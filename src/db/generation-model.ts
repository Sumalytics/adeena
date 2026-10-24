import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { withWorkspace } from "./authz";
import type { VerifiedIdentity } from "./identity";
import { claimFreeRequest, reconcileReservation, reserveAnotherEstimate, releaseUnusedFreeRequests } from "./model-budget";
import { billedMicros, configuredEditAuthorization, GENERATION_LIMITS, GROQ_COMMERCIAL_SCHEDULE, type PaidEditResult, type ProviderEnv, type RateSchedule } from "@/experience/provider";
import { parseSourcePlan, rejected, requestPlanStage, reviewPasses, selectedPlanSource } from "@/experience/model-plan";
import type { Compilation, GenerationSource } from "@/experience/compile";
import { SourceError } from "@/source/errors";

export type ModelOptions = { env?: ProviderEnv; fetchImpl?: typeof fetch; schedules?: Record<string, RateSchedule> };
type Input = ModelOptions & { sql: Sql; identity: VerifiedIdentity; workspaceId: string; jobId: string; leaseOwner: string; source: GenerationSource };

export async function generateModelPlan(input: Input): Promise<Compilation> {
  const env = input.env ?? process.env;
  const auth = configuredEditAuthorization(env, input.schedules);
  if (!auth.ok) return { ...rejected(auth.code, "Model execution is not authorized."), code: auth.code };
  const source = selectedPlanSource(input.source);
  if (source.spans.length === 0) return { ...rejected("source.insufficient", "No usable source excerpts."), code: "insufficient-source" };
  const free = "mode" in auth;
  const model = free ? auth.model : auth.spend.model;
  const price = free ? auth.priceVersion : auth.spend.priceVersion;
  const schedule = free ? GROQ_COMMERCIAL_SCHEDULE : auth.spend;
  const ceiling = ([GENERATION_LIMITS.plan, GENERATION_LIMITS.review] as const).reduce((sum, limit) => sum + (billedMicros(schedule, limit.input, 0, limit.output) ?? 2_000_000_000), 0);
  if (!free && ceiling > auth.spend.maxEditMicros) return { ...rejected("budget-unavailable", "The complete generation exceeds the authorized operation ceiling."), code: "budget-unavailable" };
  // Reserve both bounded calls before any network request. The durable reservation
  // prevents a retry or expired lease from issuing another billed generation.
  try {
    await withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
      const [job] = await workspace.tx`select id from experience_generation_jobs where id=${input.jobId}::uuid
        and workspace_id=${input.workspaceId}::uuid and lease_owner=${input.leaseOwner} and not permanent for update`;
      if (!job) throw new SourceError("provider-unavailable");
      const [existing] = await workspace.tx`select id from experience_generation_costs where job_id=${input.jobId}::uuid`;
      if (existing) throw new SourceError("provider-unavailable");
      if (free) {
        if (!await claimFreeRequest(workspace, auth.sessionLimit, auth.dayLimit) || !await claimFreeRequest(workspace, auth.sessionLimit, auth.dayLimit)) throw new SourceError("budget-unavailable");
      } else if (!await reserveAnotherEstimate(workspace, ceiling, auth.spend.spendCapMicros)) throw new SourceError("budget-unavailable");
      await workspace.tx`insert into experience_generation_costs
        (id,workspace_id,job_id,provider,model,pricing_version,input_tokens,output_tokens,call_count,retry_count,
          estimated_cost_micros,actual_cost_micros,currency,usage_kind,created_by,execution_mode,commercial_estimate_micros,model_calls)
        values (${randomUUID()}::uuid,${input.workspaceId}::uuid,${input.jobId}::uuid,'configured-provider',${model},${price},0,0,2,0,
          ${free ? 0 : ceiling},${free ? 0 : ceiling},'USD','estimate',${workspace.userId}::uuid,
          ${free ? "free-development" : "paid-development"},${free ? ceiling : null},
          '[{"stage":"plan","status":"reserved"},{"stage":"review","status":"reserved"}]'::jsonb)`;
    });
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    return { ...rejected(error.code, "Model execution could not reserve its bounded budget."), code: error.code as "budget-unavailable" | "provider-unavailable" };
  }
  const results: { stage: "plan" | "review"; result: PaidEditResult }[] = [];
  let outcome: Compilation;
  try {
    const planned = await requestPlanStage({ kind: "plan", source, env, fetchImpl: input.fetchImpl, schedules: input.schedules });
    results.push({ stage: "plan", result: planned });
    outcome = planned.ok ? parseSourcePlan(planned.content, source) : providerFailure(planned);
    if (outcome.ok) {
      const reviewed = await requestPlanStage({ kind: "review", source, plan: outcome.plan, env, fetchImpl: input.fetchImpl, schedules: input.schedules });
      results.push({ stage: "review", result: reviewed });
      if (!reviewed.ok) outcome = providerFailure(reviewed);
      else if (!reviewPasses(reviewed.content)) outcome = rejected("plan.review-rejected", "The independent source and outcome review rejected this plan.");
    }
  } catch {
    // Keep the reservation on an uncertain failure, never substitute a fixture.
    return { ...rejected("provider-unavailable", "Model generation stopped; its reservation is retained."), code: "provider-unavailable" };
  }
  await withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
    const uncertain = results.some(({ result }) => result.usageKind === "estimate");
    const actual = results.reduce((sum, { result }) => sum + (result.releaseReservation ? 0 : result.usageKind === "actual" ? result.actualCostMicros : result.usageKind === "estimate" ? result.estimatedCostMicros : 0), 0);
    if (!free) await reconcileReservation(workspace, ceiling, actual);
    const total = (key: "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningTokens" | "callCount" | "retryCount") => results.reduce((sum, { result }) => sum + result[key], 0);
    if (free) await releaseUnusedFreeRequests(workspace, 2 - total("callCount"), input.jobId);
    const calls = results.map(({ stage, result }) => ({ stage, status: result.ok ? "completed" : "failed", responseId: result.responseId,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens, reasoningTokens: result.reasoningTokens,
      usageKind: result.usageKind, ...(result.ok ? stage === "review" ? { review: result.content } : { proposedPlan: result.content } : {}) }));
    await workspace.tx`update experience_generation_costs set input_tokens=${total("inputTokens")},cached_input_tokens=${total("cachedInputTokens")},
      output_tokens=${total("outputTokens")},reasoning_tokens=${total("reasoningTokens")},call_count=${total("callCount")},retry_count=${total("retryCount")},
      actual_cost_micros=${free ? 0 : actual},usage_kind=${uncertain ? "estimate" : results.some(({result}) => result.usageKind === "actual") ? "actual" : "none"},
      commercial_estimate_micros=${free ? results.reduce((sum,{result})=>sum+(result.commercialEstimateMicros ?? 0),0) : null},
      model_calls=${JSON.stringify(calls)}::jsonb where job_id=${input.jobId}::uuid and workspace_id=${input.workspaceId}::uuid`;
  });
  return outcome;
}
function providerFailure(result: PaidEditResult): Compilation {
  const code = result.code === "unsupported-edit" ? "invalid-experience" : result.code ?? "provider-unavailable";
  return { ...rejected(code, "The configured model did not return an acceptable plan."), code };
}
