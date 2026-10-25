import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { SourceError } from "@/source/errors";
import {
  billedMicros, configuredEditAuthorization, GENERATION_LIMITS, GROQ_COMMERCIAL_SCHEDULE,
  type PaidEditResult, type ProviderEnv, type RateSchedule,
} from "@/experience/provider";
import {
  requestVisualDirectorStage, VisualDirectorProposalV1, visualReviewPasses,
  type VisualDirectorInput, type VisualDirectorProposal,
} from "@/experience/visual-director/model-plan";
import { validateVisualDirectorProposal } from "@/experience/visual-director/model-validation";
import { associateVisualExperienceInScope } from "./visual-experience-repository";
import { loadVisualDirectorInputInScope, type VisualGenerationResult } from "./visual-generation-repository";
import { claimFreeRequest, reconcileReservation, releaseUnusedFreeRequests, reserveAnotherEstimate } from "./model-budget";
import { claimVisualGenerationJob, withVisualWorkerClaim, type VisualWorkerClaim } from "./visual-worker-auth";

type WorkerOptions = {
  sql: Sql; leaseOwner: string; leaseMs?: number; jobId?: string; env?: ProviderEnv;
  fetchImpl?: typeof fetch; schedules?: Record<string, RateSchedule>;
  onClaim?: (claim: { jobId: string; attemptCount: number; queueDelayMs: number }) => void;
};

type Prepared = {
  status: "planning" | "reviewing" | "ready";
  directorInput: VisualDirectorInput;
  proposal: VisualDirectorProposal | null;
  associationId?: string;
};

export async function runVisualGenerationWorkerOnce(input: WorkerOptions): Promise<VisualGenerationResult | null> {
  const claim = await claimVisualGenerationJob(input);
  if (!claim) return null;
  input.onClaim?.({ jobId: claim.jobId, attemptCount: claim.attemptCount, queueDelayMs: Math.max(0, Date.now() - claim.createdAt.getTime()) });
  return executeClaim(input, claim);
}

async function executeClaim(input: WorkerOptions, claim: VisualWorkerClaim): Promise<VisualGenerationResult> {
  const started = Date.now();
  const env = input.env ?? process.env;
  const auth = configuredEditAuthorization(env, input.schedules);
  if (!auth.ok) return failKnown(input.sql, claim, auth.code, started);
  const free = "mode" in auth;
  const schedule = free ? GROQ_COMMERCIAL_SCHEDULE : auth.spend;
  const ceiling = visualCeiling(schedule);
  if (!free && ceiling > auth.spend.maxEditMicros) return failKnown(input.sql, claim, "budget-unavailable", started);

  let prepared: Prepared;
  try {
    prepared = await withVisualWorkerClaim(input.sql, claim, async (scope) => {
      const jobs = await scope.tx<{ status: string; proposal: unknown; association_id: string | null }[]>`
        select status,proposal,association_id::text from visual_generation_jobs
        where id=${claim.jobId}::uuid and workspace_id=${claim.workspaceId}::uuid for update`;
      const job = jobs[0];
      if (!job) throw new SourceError("invalid-generation");
      const existing = await scope.tx<{ id: string }[]>`select id::text from visual_experience_blueprints where workspace_id=${claim.workspaceId}::uuid and experience_version_id=${claim.experienceVersionId}::uuid`;
      const directorInput = await loadVisualDirectorInputInScope(scope.tx, claim.workspaceId, claim.experienceVersionId);
      if (existing[0]) {
        await scope.tx`update visual_generation_jobs set status='ready',association_id=${existing[0].id}::uuid,lease_owner=null,lease_token=null,lease_expires_at=null,completed_at=coalesce(completed_at,now()),updated_at=now() where id=${claim.jobId}::uuid`;
        return { status: "ready", directorInput, proposal: null, associationId: existing[0].id };
      }
      if (job.status === "queued") {
        if (free) {
          if (!await claimFreeRequest(scope, auth.sessionLimit, auth.dayLimit) || !await claimFreeRequest(scope, auth.sessionLimit, auth.dayLimit)) throw new SourceError("budget-unavailable");
        } else if (!await reserveAnotherEstimate(scope, ceiling, auth.spend.spendCapMicros)) throw new SourceError("budget-unavailable");
        await scope.tx`insert into visual_generation_costs(id,workspace_id,job_id,model,pricing_version,execution_mode,reserved_cost_micros,actual_cost_micros,commercial_estimate_micros,usage_kind,model_calls,created_by)
          values(${randomUUID()}::uuid,${claim.workspaceId}::uuid,${claim.jobId}::uuid,${free ? auth.model : auth.spend.model},${free ? auth.priceVersion : auth.spend.priceVersion},${free ? "free-development" : "paid-development"},${free ? 0 : ceiling},${free ? 0 : ceiling},${free ? 0 : null},'estimate','[]'::jsonb,${scope.userId}::uuid)
          on conflict(job_id) do nothing`;
        await scope.tx`update visual_generation_jobs set status='planning',updated_at=now() where id=${claim.jobId}::uuid`;
      }
      const proposal = job.proposal ? VisualDirectorProposalV1.parse(job.proposal) : null;
      return { status: job.status === "queued" ? "planning" : job.status as "planning" | "reviewing", directorInput, proposal };
    });
  } catch (error) {
    return failKnown(input.sql, claim, error instanceof SourceError ? error.code : "provider-unavailable", started);
  }

  if (prepared.status === "ready") return { jobId: claim.jobId, status: "ready", associationId: prepared.associationId, replayed: true };
  let providerRequestOutstanding = false;
  try {
    let proposal = prepared.proposal;
    if (prepared.status === "planning") {
      await markProviderStart(input.sql, claim, "visualPlan");
      providerRequestOutstanding = true;
      const result = await requestVisualDirectorStage({ kind: "visualPlan", directorInput: prepared.directorInput, env, fetchImpl: input.fetchImpl, schedules: input.schedules });
      if (!result.ok) return finish(input.sql, claim, free, ceiling, "failed", result.code ?? "provider-unavailable", [{ code: result.code ?? "provider-unavailable", message: result.diagnostic ?? "The visual planner did not return an acceptable result." }], started, undefined, undefined, undefined, { stage: "visualPlan", result });
      const parsed = VisualDirectorProposalV1.safeParse(result.content);
      if (!parsed.success) return finish(input.sql, claim, free, ceiling, "failed", "proposal.schema", [{ code: "proposal.schema", message: "The visual proposal did not match its versioned contract." }], started, undefined, undefined, undefined, { stage: "visualPlan", result });
      proposal = parsed.data;
      const checked = validateVisualDirectorProposal(proposal, prepared.directorInput);
      if (!checked.ok) return finish(input.sql, claim, free, ceiling, "failed", "proposal.rejected", checked.diagnostics.map(({ code, message }) => ({ code, message })), started, proposal, undefined, undefined, { stage: "visualPlan", result });
      if (checked.status === "unsupported-visual-treatment") return finish(input.sql, claim, free, ceiling, "unsupported", "unsupported-visual-treatment", [
        { code: "unsupported-visual-treatment", message: checked.proposal.reason },
        { code: "required-capability", message: checked.proposal.requiredCapability },
      ], started, proposal, undefined, undefined, { stage: "visualPlan", result });
      const acceptedProposal = checked.proposal;
      await withVisualWorkerClaim(input.sql, claim, async ({ tx }) => {
        await appendStage(tx, claim, "visualPlan", result);
        await tx`update visual_generation_jobs set status='reviewing',proposal=${JSON.stringify(acceptedProposal)}::text::jsonb,instructional_plan=${JSON.stringify(acceptedProposal.plan)}::text::jsonb,provider_stage=null,provider_started_at=null,updated_at=now() where id=${claim.jobId}::uuid and lease_owner=${claim.leaseOwner}`;
      });
      providerRequestOutstanding = false;
      proposal = acceptedProposal;
    }

    if (!proposal || proposal.result !== "supported") throw new SourceError("invalid-generation");
    await markProviderStart(input.sql, claim, "visualReview");
    providerRequestOutstanding = true;
    const review = await requestVisualDirectorStage({ kind: "visualReview", directorInput: prepared.directorInput, proposal, env, fetchImpl: input.fetchImpl, schedules: input.schedules });
    if (!review.ok) return finish(input.sql, claim, free, ceiling, "failed", review.code ?? "provider-unavailable", [{ code: review.code ?? "provider-unavailable", message: review.diagnostic ?? "The visual reviewer did not return an acceptable result." }], started, proposal, review.content, undefined, { stage: "visualReview", result: review });
    if (!visualReviewPasses(review.content)) return finish(input.sql, claim, free, ceiling, "failed", "review.rejected", [{ code: "review.rejected", message: "The independent model review rejected the visual proposal." }], started, proposal, review.content, undefined, { stage: "visualReview", result: review });
    const checked = validateVisualDirectorProposal(proposal, prepared.directorInput);
    if (!checked.ok || checked.status === "unsupported-visual-treatment") throw new SourceError("invalid-experience");
    return withVisualWorkerClaim(input.sql, claim, async (scope) => {
      await appendStage(scope.tx, claim, "visualReview", review);
      const associationId = (await associateVisualExperienceInScope({
        tx: scope.tx, userId: scope.userId, workspaceId: claim.workspaceId, experienceVersionId: claim.experienceVersionId,
        blueprint: checked.proposal.blueprint, context: checked.context, mapping: checked.proposal.mapping, authoredFixture: false, fixtureLabel: null,
      })).associationId;
      return finishInScope(scope, claim, free, ceiling, "ready", null, [], started, proposal, review.content, associationId);
    });
  } catch (error) {
    return providerRequestOutstanding
      ? failUncertain(input.sql, claim, started)
      : failKnown(input.sql, claim, safeFailureCode(error), started);
  }
}

async function markProviderStart(sql: Sql, claim: VisualWorkerClaim, stage: "visualPlan" | "visualReview") {
  await withVisualWorkerClaim(sql, claim, async ({ tx }) => {
    const updated = await tx`update visual_generation_jobs set provider_stage=${stage},provider_started_at=now(),updated_at=now() where id=${claim.jobId}::uuid and lease_owner=${claim.leaseOwner} and lease_token=${claim.leaseToken}::uuid returning id`;
    if (!updated[0]) throw new SourceError("provider-unavailable");
  });
}

async function appendStage(tx: Sql, claim: VisualWorkerClaim, stage: "visualPlan" | "visualReview", result: PaidEditResult) {
  const call = { stage, status: result.ok ? "completed" : "failed", responseId: result.responseId, inputTokens: result.inputTokens, cachedInputTokens: result.cachedInputTokens, outputTokens: result.outputTokens, reasoningTokens: result.reasoningTokens, callCount: result.callCount, retryCount: result.retryCount, usageKind: result.usageKind, actualCostMicros: result.actualCostMicros, estimatedCostMicros: result.estimatedCostMicros, commercialEstimateMicros: result.commercialEstimateMicros, releaseReservation: result.releaseReservation };
  await tx`update visual_generation_costs set input_tokens=input_tokens+${result.inputTokens},cached_input_tokens=cached_input_tokens+${result.cachedInputTokens},output_tokens=output_tokens+${result.outputTokens},reasoning_tokens=reasoning_tokens+${result.reasoningTokens},call_count=call_count+${result.callCount},retry_count=retry_count+${result.retryCount},model_calls=model_calls||${JSON.stringify([call])}::text::jsonb where job_id=${claim.jobId}::uuid`;
}

async function finish(sql: Sql, claim: VisualWorkerClaim, free: boolean, ceiling: number, status: "ready" | "unsupported" | "failed", failureCode: string | null, diagnostics: { code: string; message: string }[], started: number, proposal?: VisualDirectorProposal | null, review?: unknown, associationId?: string, stageResult?: { stage: "visualPlan" | "visualReview"; result: PaidEditResult }): Promise<VisualGenerationResult> {
  return withVisualWorkerClaim(sql, claim, async (scope) => {
    if (stageResult) await appendStage(scope.tx, claim, stageResult.stage, stageResult.result);
    return finishInScope(scope, claim, free, ceiling, status, failureCode, diagnostics, started, proposal, review, associationId);
  });
}

async function finishInScope(scope: { tx: Sql; userId: string }, claim: VisualWorkerClaim, free: boolean, ceiling: number, status: "ready" | "unsupported" | "failed", failureCode: string | null, diagnostics: { code: string; message: string }[], started: number, proposal?: VisualDirectorProposal | null, review?: unknown, associationId?: string): Promise<VisualGenerationResult> {
    const rows = await scope.tx<{ call_count: number; input_tokens: number; output_tokens: number; model_calls: unknown }[]>`select call_count,input_tokens,output_tokens,model_calls from visual_generation_costs where job_id=${claim.jobId}::uuid for update`;
    const cost = rows[0];
    const calls = Array.isArray(cost?.model_calls) ? cost.model_calls as Record<string, unknown>[] : [];
    const actual = calls.reduce((sum, call) => sum + (call.releaseReservation === true ? 0 : Number(call.actualCostMicros ?? call.estimatedCostMicros ?? 0)), 0);
    const commercial = free ? calls.reduce((sum, call) => sum + Number(call.commercialEstimateMicros ?? 0), 0) : null;
    const uncertain = calls.some((call) => call.usageKind === "estimate");
    if (!free) await reconcileReservation(scope, ceiling, actual);
    if (free) await releaseUnusedFreeRequests(scope, 2 - Number(cost?.call_count ?? 0), claim.jobId, "visual");
    await scope.tx`update visual_generation_costs set actual_cost_micros=${free ? 0 : actual},commercial_estimate_micros=${commercial},usage_kind=${uncertain ? "estimate" : calls.length ? "actual" : "none"} where job_id=${claim.jobId}::uuid`;
    const durationMs = Math.max(0, Date.now() - started);
    await scope.tx`update visual_generation_jobs set status=${status},proposal=${proposal ? JSON.stringify(proposal) : null}::text::jsonb,instructional_plan=${proposal?.result === "supported" ? JSON.stringify(proposal.plan) : null}::text::jsonb,model_review=${review ? JSON.stringify(review) : null}::text::jsonb,diagnostics=${JSON.stringify(diagnostics)}::text::jsonb,association_id=${associationId ?? null}::uuid,failure_code=${failureCode},duration_ms=${durationMs},provider_stage=null,provider_started_at=null,lease_owner=null,lease_token=null,lease_expires_at=null,completed_at=now(),updated_at=now() where id=${claim.jobId}::uuid`;
    return { jobId: claim.jobId, status: status === "ready" ? "ready" : status === "unsupported" ? "unsupported-visual-treatment" : "rejected", associationId, reason: failureCode ?? undefined, diagnostics, usage: { callCount: Number(cost?.call_count ?? 0), inputTokens: Number(cost?.input_tokens ?? 0), outputTokens: Number(cost?.output_tokens ?? 0), actualCostMicros: free ? 0 : actual, commercialEstimateMicros: commercial, durationMs }, replayed: false };
}

async function failKnown(sql: Sql, claim: VisualWorkerClaim, code: string, started: number) {
  return fail(sql, claim, code, false, started);
}

async function failUncertain(sql: Sql, claim: VisualWorkerClaim, started: number) {
  return fail(sql, claim, "provider-outcome-unknown", true, started);
}

async function fail(sql: Sql, claim: VisualWorkerClaim, code: string, uncertain: boolean, started: number): Promise<VisualGenerationResult> {
  try {
    return await withVisualWorkerClaim(sql, claim, async ({ tx }) => {
      const message = uncertain ? "The provider outcome is uncertain, so this operation will not be purchased again." : "The visual-generation worker could not complete this operation.";
      await tx`update visual_generation_jobs set status='failed',failure_code=${code},uncertain_charge=${uncertain},diagnostics=${JSON.stringify([{ code, message }])}::text::jsonb,duration_ms=${Math.max(0, Date.now() - started)},lease_owner=null,lease_token=null,lease_expires_at=null,completed_at=now(),updated_at=now() where id=${claim.jobId}::uuid`;
      if (uncertain) await tx`update visual_generation_costs set actual_cost_micros=null,usage_kind='estimate' where job_id=${claim.jobId}::uuid`;
      return { jobId: claim.jobId, status: "rejected", reason: code, diagnostics: [{ code, message }], replayed: false };
    });
  } catch {
    return { jobId: claim.jobId, status: "rejected", reason: code, replayed: false };
  }
}

function visualCeiling(schedule: RateSchedule) {
  return ([GENERATION_LIMITS.visualPlan, GENERATION_LIMITS.visualReview] as const).reduce((sum, limit) => sum + (billedMicros(schedule, limit.input, 0, limit.output) ?? 2_000_000_000), 0);
}

function safeFailureCode(error: unknown) {
  if (error instanceof SourceError) return error.code;
  const code = error && typeof error === "object" && "code" in error ? String(error.code).toLowerCase() : "";
  return /^[a-z0-9]{5}$/.test(code) ? `database.${code}` : "provider-unavailable";
}
