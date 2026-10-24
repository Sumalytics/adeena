import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { parseManifest } from "@adeena/experience-schema";
import { Uuid } from "@/contracts/common";
import { SourceError } from "@/source/errors";
import {
  billedMicros,
  configuredEditAuthorization,
  GENERATION_LIMITS,
  GROQ_COMMERCIAL_SCHEDULE,
  type PaidEditResult,
  type ProviderEnv,
  type RateSchedule,
} from "@/experience/provider";
import {
  VISUAL_PLAN_PROMPT_VERSION,
  VISUAL_REVIEW_PROMPT_VERSION,
  VisualDirectorProposalV1,
  requestVisualDirectorStage,
  selectedVisualSource,
  visualReviewPasses,
  type VisualDirectorInput,
  type VisualDirectorProposal,
} from "@/experience/visual-director/model-plan";
import { validateVisualDirectorProposal } from "@/experience/visual-director/model-validation";
import { ARCHETYPE_REGISTRY } from "@/experience/visual-director/schema";
import { associateVisualExperience } from "./visual-experience-repository";
import { withWorkspace } from "./authz";
import type { VerifiedIdentity } from "./identity";
import { claimFreeRequest, reconcileReservation, releaseUnusedFreeRequests, reserveAnotherEstimate } from "./model-budget";

type Options = { env?: ProviderEnv; fetchImpl?: typeof fetch; schedules?: Record<string, RateSchedule> };
export type VisualGenerationResult = {
  jobId: string;
  status: "ready" | "unsupported-visual-treatment" | "rejected" | "in-progress";
  associationId?: string;
  reason?: string;
  diagnostics?: { code: string; message: string }[];
  usage?: { callCount: number; inputTokens: number; outputTokens: number; actualCostMicros: number | null; commercialEstimateMicros: number | null; durationMs: number | null };
  replayed: boolean;
};
export type VisualGenerationView = VisualGenerationResult & {
  internalStatus: "queued" | "planning" | "reviewing" | "ready" | "unsupported" | "failed";
};

const implemented = Object.entries(ARCHETYPE_REGISTRY).filter(([, value]) => value.renderer === "implemented").map(([id]) => id) as VisualDirectorInput["implementedArchetypes"];
type JobRow = { id: string; status: string; association_id: string | null; failure_code: string | null; diagnostics: unknown; duration_ms: number | null };

async function loadInput(sql: Sql, identity: VerifiedIdentity, workspaceId: string, experienceVersionId: string): Promise<VisualDirectorInput> {
  return withWorkspace(sql, identity, workspaceId, async ({ tx }) => {
    const rows = await tx<{ manifest: unknown; document_version_id: string; topic_title: string; audience_label: string; age_band: VisualDirectorInput["source"]["ageBand"]; source_span_ids: unknown; learner_objective: string | null }[]>`
      with recursive lineage as (
        select v0.id,v0.parent_version_id,v0.job_id,0 as depth from experience_versions v0
        where v0.id=${experienceVersionId}::uuid and v0.workspace_id=${workspaceId}::uuid
        union all
        select parent.id,parent.parent_version_id,parent.job_id,lineage.depth+1 from experience_versions parent
        join lineage on lineage.parent_version_id=parent.id where parent.workspace_id=${workspaceId}::uuid and lineage.depth<20
      ), origin as (select id,job_id from lineage where job_id is not null order by depth desc limit 1)
      select v.manifest,v.document_version_id::text,c.title as topic_title,j.audience_label,j.age_band,v.source_span_ids,
        p.plan->>'learnerObjective' as learner_objective
      from experience_versions v
      join origin o on true
      join experience_generation_jobs j on j.id=o.job_id and j.workspace_id=v.workspace_id
      join topic_candidates c on c.id=v.topic_candidate_id and c.workspace_id=v.workspace_id
      join source_document_versions d on d.id=v.document_version_id and d.workspace_id=v.workspace_id
      left join experience_plans p on p.experience_version_id=o.id and p.workspace_id=v.workspace_id
      where v.id=${experienceVersionId}::uuid and v.workspace_id=${workspaceId}::uuid and v.publication_status='unpublished' and d.rights_status<>'blocked'`;
    const row = rows[0];
    const manifest = parseManifest(row?.manifest);
    if (!row || !manifest.ok) throw new SourceError("invalid-experience");
    const wanted = Array.isArray(row.source_span_ids) ? row.source_span_ids.filter((id): id is string => typeof id === "string") : [];
    const spans = await tx<{ id: string; excerpt: string }[]>`select id::text,coalesce(generation_excerpt,excerpt) as excerpt from source_spans where workspace_id=${workspaceId}::uuid and document_version_id=${row.document_version_id}::uuid and id::text in ${tx(wanted)}`;
    if (!wanted.length || spans.length !== wanted.length) throw new SourceError("invalid-experience");
    const source = selectedVisualSource({ documentVersionId: row.document_version_id, topicTitle: row.topic_title, audienceLabel: row.audience_label, ageBand: row.age_band, spans, experienceId: manifest.manifest.experienceId, versionId: manifest.manifest.versionId });
    if (!source.spans.length) throw new SourceError("insufficient-source");
    return { source, learningObjective: row.learner_objective ?? `Explain and apply ${row.topic_title}.`, locale: manifest.manifest.locale, manifest: manifest.manifest, implementedArchetypes: implemented, allowedAssetIds: manifest.manifest.assets.map((asset) => asset.id), practiceMechanics: ["sequence-steps", "classify", "calculate-two-set-cardinality"] };
  });
}

export async function enqueueVisualGeneration(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; experienceVersionId: string; idempotencyKey: string } & Pick<Options, "env" | "schedules">): Promise<VisualGenerationView> {
  if (!Uuid.safeParse(input.experienceVersionId).success || !Uuid.safeParse(input.idempotencyKey).success) throw new SourceError("invalid-generation");
  const env = input.env ?? process.env;
  const auth = configuredEditAuthorization(env, input.schedules);
  if (!auth.ok) throw new SourceError(auth.code);
  const free = "mode" in auth;
  const schedule = free ? GROQ_COMMERCIAL_SCHEDULE : auth.spend;
  const ceiling = ([GENERATION_LIMITS.visualPlan, GENERATION_LIMITS.visualReview] as const).reduce((sum, limit) => sum + (billedMicros(schedule, limit.input, 0, limit.output) ?? 2_000_000_000), 0);
  await loadInput(input.sql, input.identity, input.workspaceId, input.experienceVersionId);
  return withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
    const association = await workspace.tx<{ id: string; authored_fixture: boolean }[]>`select id::text,authored_fixture from visual_experience_blueprints where workspace_id=${input.workspaceId}::uuid and experience_version_id=${input.experienceVersionId}::uuid`;
    if (association[0]?.authored_fixture) throw new SourceError("invalid-experience");
    const created = randomUUID();
    await workspace.tx`insert into visual_generation_jobs(id,workspace_id,experience_version_id,idempotency_key,provider,status,prompt_version,review_prompt_version,created_by)
      values(${created}::uuid,${input.workspaceId}::uuid,${input.experienceVersionId}::uuid,${input.idempotencyKey}::uuid,'configured-provider','queued',${VISUAL_PLAN_PROMPT_VERSION},${VISUAL_REVIEW_PROMPT_VERSION},${workspace.userId}::uuid)
      on conflict do nothing`;
    const rows = await workspace.tx<JobRow[]>`select id::text,status,association_id::text,failure_code,diagnostics,duration_ms from visual_generation_jobs where workspace_id=${input.workspaceId}::uuid and experience_version_id=${input.experienceVersionId}::uuid`;
    const job = rows[0];
    if (!job) throw new SourceError("invalid-generation");
    if (association[0]) return { ...present(job, true), status: "ready", associationId: association[0].id, internalStatus: "ready" };
    if (!free && ceiling > auth.spend.maxEditMicros && job.status === "queued") {
      const diagnostics = [{ code: "budget-unavailable", message: "The authorized per-generation limit does not cover the bounded visual-generation operation." }];
      await workspace.tx`update visual_generation_jobs set status='failed',failure_code='budget-unavailable',diagnostics=${JSON.stringify(diagnostics)}::jsonb,updated_at=now() where id=${job.id}::uuid`;
      return { ...present({ ...job, status: "failed", failure_code: "budget-unavailable", diagnostics }, job.id !== created), internalStatus: "failed" };
    }
    return { ...present(job, job.id !== created), internalStatus: asInternalStatus(job.status) };
  });
}

export async function readVisualGeneration(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; experienceVersionId: string }): Promise<VisualGenerationView | null> {
  if (!Uuid.safeParse(input.experienceVersionId).success) throw new SourceError("invalid-generation");
  return withWorkspace(input.sql, input.identity, input.workspaceId, async ({ tx }) => {
    await tx`update visual_generation_jobs set status='failed',failure_code='provider-unavailable',diagnostics='[{"code":"provider-unavailable","message":"Visual generation did not finish before its bounded worker window closed."}]'::jsonb,updated_at=now()
      where workspace_id=${input.workspaceId}::uuid and experience_version_id=${input.experienceVersionId}::uuid
        and status in ('queued','planning','reviewing') and updated_at < now()-interval '4 minutes'`;
    const rows = await tx<JobRow[]>`select id::text,status,association_id::text,failure_code,diagnostics,duration_ms from visual_generation_jobs where workspace_id=${input.workspaceId}::uuid and experience_version_id=${input.experienceVersionId}::uuid`;
    const job = rows[0];
    return job ? { ...present(job, true), internalStatus: asInternalStatus(job.status) } : null;
  });
}

export async function failVisualGeneration(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; experienceVersionId: string; code: "budget-unavailable" | "provider-unavailable" }) {
  return withWorkspace(input.sql, input.identity, input.workspaceId, async ({ tx }) => {
    await tx`update visual_generation_jobs set status='failed',failure_code=${input.code},diagnostics=${JSON.stringify([{ code: input.code, message: "The bounded visual-generation worker could not complete this operation." }])}::jsonb,updated_at=now()
      where workspace_id=${input.workspaceId}::uuid and experience_version_id=${input.experienceVersionId}::uuid and status in ('queued','planning','reviewing')`;
  });
}

export async function generateVisualExperience(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; experienceVersionId: string; idempotencyKey: string } & Options): Promise<VisualGenerationResult> {
  const started = Date.now();
  if (!Uuid.safeParse(input.experienceVersionId).success || !Uuid.safeParse(input.idempotencyKey).success) throw new SourceError("invalid-generation");
  const env = input.env ?? process.env;
  const auth = configuredEditAuthorization(env, input.schedules);
  if (!auth.ok) throw new SourceError(auth.code);
  const directorInput = await loadInput(input.sql, input.identity, input.workspaceId, input.experienceVersionId);
  await enqueueVisualGeneration(input);
  const free = "mode" in auth;
  const model = free ? auth.model : auth.spend.model;
  const price = free ? auth.priceVersion : auth.spend.priceVersion;
  const schedule = free ? GROQ_COMMERCIAL_SCHEDULE : auth.spend;
  const ceiling = ([GENERATION_LIMITS.visualPlan, GENERATION_LIMITS.visualReview] as const).reduce((sum, limit) => sum + (billedMicros(schedule, limit.input, 0, limit.output) ?? 2_000_000_000), 0);
  if (!free && ceiling > auth.spend.maxEditMicros) throw new SourceError("budget-unavailable");
  const claim = await withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
    const association = await workspace.tx<{ id: string; authored_fixture: boolean }[]>`select id::text,authored_fixture from visual_experience_blueprints where workspace_id=${input.workspaceId}::uuid and experience_version_id=${input.experienceVersionId}::uuid`;
    if (association[0]?.authored_fixture) throw new SourceError("invalid-experience");
    const rows = await workspace.tx<JobRow[]>`select id::text,status,association_id::text,failure_code,diagnostics,duration_ms from visual_generation_jobs where workspace_id=${input.workspaceId}::uuid and experience_version_id=${input.experienceVersionId}::uuid for update`;
    const job = rows[0];
    if (!job) throw new SourceError("invalid-generation");
    if (association[0]) return { kind: "terminal" as const, result: { jobId: job.id, status: "ready" as const, associationId: association[0].id, replayed: true } };
    if (job.status !== "queued") return { kind: "terminal" as const, result: present(job, true) };
    if (free) {
      if (!await claimFreeRequest(workspace, auth.sessionLimit, auth.dayLimit) || !await claimFreeRequest(workspace, auth.sessionLimit, auth.dayLimit)) throw new SourceError("budget-unavailable");
    } else if (!await reserveAnotherEstimate(workspace, ceiling, auth.spend.spendCapMicros)) throw new SourceError("budget-unavailable");
    await workspace.tx`insert into visual_generation_costs(id,workspace_id,job_id,model,pricing_version,execution_mode,reserved_cost_micros,actual_cost_micros,commercial_estimate_micros,usage_kind,model_calls,created_by)
      values(${randomUUID()}::uuid,${input.workspaceId}::uuid,${job.id}::uuid,${model},${price},${free ? "free-development" : "paid-development"},${free ? 0 : ceiling},${free ? 0 : ceiling},${free ? ceiling : null},'estimate','[{"stage":"visualPlan","status":"reserved"},{"stage":"visualReview","status":"reserved"}]'::jsonb,${workspace.userId}::uuid)`;
    await workspace.tx`update visual_generation_jobs set status='planning',updated_at=now() where id=${job.id}::uuid`;
    return { kind: "run" as const, jobId: job.id };
  });
  if (claim.kind === "terminal") return claim.result;

  const results: { stage: "visualPlan" | "visualReview"; result: PaidEditResult }[] = [];
  let proposal: VisualDirectorProposal | null = null;
  let finalStatus: "ready" | "unsupported" | "failed" = "failed";
  let failureCode: string | null = "provider-unavailable";
  let diagnostics: { code: string; message: string }[] = [];
  let reviewContent: unknown = null;
  let associationId: string | undefined;
  try {
    const planned = await requestVisualDirectorStage({ kind: "visualPlan", directorInput, env, fetchImpl: input.fetchImpl, schedules: input.schedules });
    results.push({ stage: "visualPlan", result: planned });
    if (!planned.ok) {
      failureCode = planned.code ?? "provider-unavailable";
      diagnostics = [{ code: failureCode, message: planned.diagnostic ?? "The visual planning provider did not return an acceptable structured result." }];
    }
    else {
      const parsed = VisualDirectorProposalV1.safeParse(planned.content);
      if (!parsed.success) failureCode = "proposal.schema";
      else {
        proposal = parsed.data;
        const validated = validateVisualDirectorProposal(proposal, directorInput);
        if (!validated.ok) {
          failureCode = "proposal.rejected";
          diagnostics = validated.diagnostics.map(({ code, message }) => ({ code, message }));
        } else if (validated.status === "unsupported-visual-treatment") {
          finalStatus = "unsupported";
          failureCode = "unsupported-visual-treatment";
          diagnostics = [
            { code: failureCode, message: validated.proposal.reason },
            { code: "required-capability", message: validated.proposal.requiredCapability },
          ];
        } else {
          await withWorkspace(input.sql, input.identity, input.workspaceId, async ({ tx }) => { await tx`update visual_generation_jobs set status='reviewing',updated_at=now() where id=${claim.jobId}::uuid`; });
          const reviewed = await requestVisualDirectorStage({ kind: "visualReview", directorInput, proposal, env, fetchImpl: input.fetchImpl, schedules: input.schedules });
          results.push({ stage: "visualReview", result: reviewed });
          reviewContent = reviewed.content ?? null;
          if (!reviewed.ok) {
            failureCode = reviewed.code ?? "provider-unavailable";
            diagnostics = [{ code: failureCode, message: reviewed.diagnostic ?? "The visual review provider did not return an acceptable structured result." }];
          } else if (!visualReviewPasses(reviewed.content)) {
            failureCode = "review.rejected";
            diagnostics = [{ code: failureCode, message: "The independent model review rejected the visual proposal." }];
          }
          else {
            const associated = await associateVisualExperience({ sql: input.sql, identity: input.identity, workspaceId: input.workspaceId, experienceVersionId: input.experienceVersionId, blueprint: validated.proposal.blueprint, context: validated.context, mapping: validated.proposal.mapping, authoredFixture: false, fixtureLabel: null });
            associationId = associated.associationId;
            finalStatus = "ready";
            failureCode = null;
          }
        }
      }
    }
  } catch {
    failureCode = "provider-unavailable";
  }
  const durationMs = Date.now() - started;
  const usage = await withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
    const total = (key: "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningTokens" | "callCount" | "retryCount") => results.reduce((sum, entry) => sum + entry.result[key], 0);
    const uncertain = results.some((entry) => entry.result.usageKind === "estimate");
    const actual = results.reduce((sum, entry) => sum + (entry.result.releaseReservation ? 0 : entry.result.usageKind === "actual" ? entry.result.actualCostMicros : entry.result.usageKind === "estimate" ? entry.result.estimatedCostMicros : 0), 0);
    if (!free) await reconcileReservation(workspace, ceiling, actual);
    if (free) await releaseUnusedFreeRequests(workspace, 2 - total("callCount"), claim.jobId);
    const calls = results.map(({ stage, result }) => ({ stage, status: result.ok ? "completed" : "failed", responseId: result.responseId, inputTokens: result.inputTokens, outputTokens: result.outputTokens, usageKind: result.usageKind, latencyMs: result.latencyMs }));
    const commercial = free ? results.reduce((sum, entry) => sum + (entry.result.commercialEstimateMicros ?? 0), 0) : null;
    await workspace.tx`update visual_generation_costs set input_tokens=${total("inputTokens")},cached_input_tokens=${total("cachedInputTokens")},output_tokens=${total("outputTokens")},reasoning_tokens=${total("reasoningTokens")},call_count=${total("callCount")},retry_count=${total("retryCount")},actual_cost_micros=${free ? 0 : actual},commercial_estimate_micros=${commercial},usage_kind=${uncertain ? "estimate" : results.some((entry) => entry.result.usageKind === "actual") ? "actual" : "none"},model_calls=${JSON.stringify(calls)}::jsonb where job_id=${claim.jobId}::uuid`;
    await workspace.tx`update visual_generation_jobs set status=${finalStatus},instructional_plan=${proposal?.result === "supported" ? JSON.stringify(proposal.plan) : null}::jsonb,model_review=${reviewContent ? JSON.stringify(reviewContent) : null}::jsonb,diagnostics=${JSON.stringify(diagnostics)}::jsonb,association_id=${associationId ?? null}::uuid,failure_code=${failureCode},duration_ms=${durationMs},updated_at=now() where id=${claim.jobId}::uuid`;
    return { callCount: total("callCount"), inputTokens: total("inputTokens"), outputTokens: total("outputTokens"), actualCostMicros: free ? 0 : actual, commercialEstimateMicros: commercial, durationMs };
  });
  return { jobId: claim.jobId, status: finalStatus === "ready" ? "ready" : finalStatus === "unsupported" ? "unsupported-visual-treatment" : "rejected", associationId, reason: failureCode ?? undefined, diagnostics, usage, replayed: false };
}

function present(job: { id: string; status: string; association_id: string | null; failure_code: string | null; diagnostics: unknown; duration_ms: number | null }, replayed: boolean): VisualGenerationResult {
  const status = job.status === "ready" ? "ready" : job.status === "unsupported" ? "unsupported-visual-treatment" : job.status === "failed" ? "rejected" : "in-progress";
  const diagnostics = Array.isArray(job.diagnostics) ? job.diagnostics.flatMap((item) => item && typeof item === "object" && "code" in item && "message" in item ? [{ code: String(item.code), message: String(item.message) }] : []) : undefined;
  return { jobId: job.id, status, associationId: job.association_id ?? undefined, reason: job.failure_code ?? undefined, diagnostics, replayed };
}

function asInternalStatus(status: string): VisualGenerationView["internalStatus"] {
  return status === "queued" || status === "planning" || status === "reviewing" || status === "ready" || status === "unsupported" ? status : "failed";
}
