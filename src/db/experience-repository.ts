import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import { AUDIENCE_OPTIONS } from "@/app/studio/studio-form";
import { AgeBand, Uuid } from "@/contracts/common";
import { compileExperiencePlan, newExperienceIds, type Compilation, type GenerationSource } from "@/experience/compile";
import type { CreatorDraftSummary, CreatorExperienceView, GenerationStatus, GenerationUsage } from "@/experience/public";
import { COMPILER_VERSION, CONFIGURED_PROVIDER, FIXTURE_PRICE_VERSION, FIXTURE_PROVIDER, PROMPT_VERSION } from "@/experience/provider";
import { parseManifest } from "@adeena/experience-schema";
import { SourceError, SOURCE_ERROR_CODES, type SourceErrorCode } from "@/source/errors";
import { limitedSensitivityMatch } from "@/topic/analyze";
import { withWorkspace, type AuthorizedWorkspace } from "./authz";
import { databaseFailure } from "./client";
import type { VerifiedIdentity } from "./identity";

const LEASE_OWNER = "creator-request";
const BLOCKING = new Set(["review-required", "sensitive-domain", "unsafe-title", "rights-blocked"]);
const STATUSES = new Set<GenerationStatus>(["queued", "planning", "compiling", "validating", "ready", "failed", "cancelled"]);

type LoadedSource = Omit<GenerationSource, "experienceId" | "versionId">;

type Run = {
  kind: "run";
  jobId: string;
  topicCandidateId: string;
  source: LoadedSource;
  sourceChars: number;
  attempt: number;
};

type Gate = { kind: "done"; view: CreatorExperienceView } | { kind: "stop"; code: SourceErrorCode } | Run;

export async function createPlayableExperience(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  documentVersionId: string;
  topicCandidateId: string;
  audienceLabel: string;
  ageBand: AgeBand;
  idempotencyKey: string;
  authorizeGeneration: true;
  provider: typeof FIXTURE_PROVIDER;
  compiler?: (source: GenerationSource) => Compilation;
}) {
  assertGeneration(input);
  try {
    const prepared = await withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
      const loaded = await loadSource(workspace, input);
      const existing = await workspace.tx<{
        id: string;
        status: string;
        failure_code: string | null;
        document_version_id: string;
        topic_candidate_id: string;
        audience_label: string;
        age_band: string;
      }[]>`
        select id::text, status, failure_code, document_version_id::text, topic_candidate_id::text, audience_label, age_band
        from experience_generation_jobs
        where workspace_id = ${input.workspaceId}::uuid and idempotency_key = ${input.idempotencyKey}::uuid
      `;
      const job = existing[0];
      if (job) {
        if (job.document_version_id !== input.documentVersionId || job.topic_candidate_id !== input.topicCandidateId || job.audience_label !== input.audienceLabel || job.age_band !== input.ageBand) {
          throw new SourceError("invalid-generation");
        }
        if (job.status === "failed") return { kind: "stop" as const, code: asCode(job.failure_code) };
        if (job.status === "ready" || job.status === "cancelled") {
          const view = await present(workspace, job.id, true);
          if (!view) throw new SourceError("cross-workspace");
          return { kind: "done" as const, view };
        }
        return claimRun(workspace, job.id, input.topicCandidateId, loaded);
      }
      const jobId = randomUUID();
      await workspace.tx`
        insert into experience_generation_jobs (
          id, workspace_id, document_version_id, topic_candidate_id, idempotency_key,
          audience_label, age_band, compiler_version, prompt_version, provider, status, created_by
        ) values (
          ${jobId}::uuid, ${input.workspaceId}::uuid, ${input.documentVersionId}::uuid, ${input.topicCandidateId}::uuid,
          ${input.idempotencyKey}::uuid, ${input.audienceLabel}, ${input.ageBand}, ${COMPILER_VERSION}, ${PROMPT_VERSION},
          ${FIXTURE_PROVIDER}, 'queued', ${workspace.userId}::uuid
        )
      `;
      return claimRun(workspace, jobId, input.topicCandidateId, loaded);
    });
    if (prepared.kind === "done") return prepared.view;
    if (prepared.kind === "stop") throw new SourceError(prepared.code);
    return finish(input, prepared);
  } catch (error) {
    rethrow(error);
  }
}

export async function resumePlayableExperience(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  jobId: string;
  compiler?: (source: GenerationSource) => Compilation;
}) {
  if (!Uuid.safeParse(input.jobId).success) throw new SourceError("invalid-generation");
  try {
    const prepared = await withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
      const rows = await workspace.tx<{
        id: string;
        status: string;
        failure_code: string | null;
        document_version_id: string;
        topic_candidate_id: string;
        audience_label: string;
        age_band: string;
      }[]>`
        select id::text, status, failure_code, document_version_id::text, topic_candidate_id::text, audience_label, age_band
        from experience_generation_jobs
        where id = ${input.jobId}::uuid and workspace_id = ${input.workspaceId}::uuid
      `;
      const job = rows[0];
      if (!job) throw new SourceError("cross-workspace");
      const age = AgeBand.safeParse(job.age_band);
      if (!age.success) throw new SourceError("invalid-generation");
      if (job.status === "failed") return { kind: "stop" as const, code: asCode(job.failure_code) };
      if (job.status === "ready" || job.status === "cancelled") {
        const view = await present(workspace, job.id, true);
        if (!view) throw new SourceError("cross-workspace");
        return { kind: "done" as const, view };
      }
      const loaded = await loadSource(workspace, {
        documentVersionId: job.document_version_id,
        topicCandidateId: job.topic_candidate_id,
        audienceLabel: job.audience_label,
        ageBand: age.data,
      });
      return claimRun(workspace, job.id, job.topic_candidate_id, loaded);
    });
    if (prepared.kind === "done") return prepared.view;
    if (prepared.kind === "stop") throw new SourceError(prepared.code);
    return finish(input, prepared);
  } catch (error) {
    rethrow(error);
  }
}

export async function listPlayableDrafts(sql: Sql, identity: VerifiedIdentity, workspaceId: string) {
  try {
    return await withWorkspace(sql, identity, workspaceId, async ({ tx }) => {
      const rows = await tx<{ id: string; title: string | null; review_status: string | null; publication_status: string | null }[]>`
        select v.id::text, v.manifest->>'title' as title,
          coalesce(j.review_status, e.review_status) as review_status, v.publication_status
        from experience_versions v
        left join experience_generation_jobs j on j.id = v.job_id and j.workspace_id = v.workspace_id
        left join experience_edit_jobs e on e.id = v.edit_job_id and e.workspace_id = v.workspace_id
        left join experience_current_drafts c on c.experience_id = v.experience_id and c.workspace_id = v.workspace_id
        where v.workspace_id = ${workspaceId}::uuid
          and (c.version_id = v.id or (c.experience_id is null and v.parent_version_id is null))
        order by v.created_at desc
        limit 20
      `;
      return rows.flatMap((row): CreatorDraftSummary[] => {
        if (row.publication_status !== "unpublished") return [];
        if (row.review_status !== "ready-for-review" && row.review_status !== "review-required") return [];
        return [{
          id: row.id,
          title: publicTitle(row.title),
          reviewStatus: row.review_status,
          publicationStatus: "unpublished",
          liveModel: false,
        }];
      });
    });
  } catch (error) {
    rethrow(error);
  }
}

export async function readPlayableExperience(sql: Sql, identity: VerifiedIdentity, workspaceId: string, versionId: string) {
  if (!Uuid.safeParse(versionId).success) throw new SourceError("invalid-generation");
  try {
    return await withWorkspace(sql, identity, workspaceId, async ({ tx }) => {
      const rows = await tx<{
        manifest: unknown;
        publication_status: string;
        review_status: string | null;
        rights_status: string;
        provider: string | null;
        experience_id: string;
        parent_version_id: string | null;
        is_current: boolean;
        edit_job_id: string | null;
        edit_status: string | null;
        summary: string | null;
        graph_changed: boolean | null;
        uncertainty: string | null;
        review_note: string | null;
        base_version_id: string | null;
        scenes_touched: number | null;
        choices_changed: number | null;
      }[]>`
        select v.manifest, v.publication_status, v.experience_id::text, v.parent_version_id::text,
          coalesce(j.review_status, e.review_status) as review_status, d.rights_status,
          coalesce(j.provider, e.provider) as provider,
          (c.version_id = v.id or (c.experience_id is null and v.parent_version_id is null)) as is_current,
          e.id::text as edit_job_id, e.status as edit_status, e.summary, e.graph_changed, e.uncertainty,
          e.review_note, e.base_version_id::text, e.scenes_touched, e.choices_changed
        from experience_versions v
        left join experience_generation_jobs j on j.id = v.job_id and j.workspace_id = v.workspace_id
        left join experience_edit_jobs e on e.id = v.edit_job_id and e.workspace_id = v.workspace_id
        left join experience_current_drafts c on c.experience_id = v.experience_id and c.workspace_id = v.workspace_id
        join source_document_versions d on d.id = v.document_version_id and d.workspace_id = v.workspace_id
        where v.id = ${versionId}::uuid and v.workspace_id = ${workspaceId}::uuid
      `;
      const row = rows[0];
      if (!row || row.publication_status !== "unpublished") throw new SourceError("cross-workspace");
      const provider = row.provider === CONFIGURED_PROVIDER ? CONFIGURED_PROVIDER : row.provider === FIXTURE_PROVIDER ? FIXTURE_PROVIDER : null;
      if (!provider) throw new SourceError("invalid-experience");
      const parsed = parseManifest(row.manifest);
      if (!parsed.ok || parsed.manifest.runtime.requiresLlm !== false || parsed.manifest.runtime.executableScripts !== false) {
        throw new SourceError("invalid-experience");
      }
      const rights = row.rights_status === "cleared" || row.rights_status === "blocked" ? row.rights_status : "unverified";
      const review = row.review_status === "ready-for-review" ? "ready-for-review" : "review-required";
      const edit = row.edit_job_id && row.edit_status && row.base_version_id ? {
        jobId: row.edit_job_id,
        status: row.edit_status,
        summary: row.summary,
        graphChanged: row.graph_changed === true,
        uncertainty: row.uncertainty,
        reviewNote: row.review_note,
        baseVersionId: row.base_version_id,
        scenesTouched: row.scenes_touched ?? 0,
        choicesChanged: row.choices_changed ?? 0,
      } : null;
      return {
        manifest: parsed.manifest,
        reviewStatus: review,
        rightsStatus: rights,
        publicationStatus: "unpublished" as const,
        provider,
        experienceId: row.experience_id,
        parentVersionId: row.parent_version_id,
        isCurrent: row.is_current === true,
        edit,
      };
    });
  } catch (error) {
    rethrow(error);
  }
}

async function finish(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; compiler?: (source: GenerationSource) => Compilation }, run: Run) {
  const started = Date.now();
  const marked = await withWorkspace(input.sql, input.identity, input.workspaceId, async ({ tx }) => mark(tx, input.workspaceId, run.jobId, "compiling"));
  if (!marked) return currentView(input, run.jobId, false);
  let outcome: Compilation;
  try {
    outcome = (input.compiler ?? compileExperiencePlan)({ ...run.source, ...newExperienceIds() });
  } catch {
    outcome = { ok: false, code: "invalid-experience", diagnostics: [{ code: "compiler.stopped", message: "The compiler stopped." }], simulation: { ok: false } };
  }
  if (outcome.ok && /private:\/\/|https?:\/\//i.test(JSON.stringify(outcome.manifest))) {
    outcome = { ok: false, code: "invalid-experience", diagnostics: [{ code: "manifest.locator", message: "The manifest locator was rejected." }], simulation: { ok: false } };
  }
  const compileMs = Date.now() - started;
  const validating = await withWorkspace(input.sql, input.identity, input.workspaceId, async ({ tx }) => mark(tx, input.workspaceId, run.jobId, "validating"));
  if (!validating) return currentView(input, run.jobId, false);
  const saved = await withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => persist(workspace, input.workspaceId, run, outcome, compileMs, Date.now() - started));
  if (saved.kind === "stop") throw new SourceError(saved.code);
  return saved.view;
}

async function currentView(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string }, jobId: string, replayed: boolean) {
  return withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
    const view = await present(workspace, jobId, replayed);
    if (!view) throw new SourceError("cross-workspace");
    return view;
  });
}

async function loadSource(workspace: AuthorizedWorkspace, input: {
  documentVersionId: string;
  topicCandidateId: string;
  audienceLabel: string;
  ageBand: AgeBand;
}): Promise<{ source: LoadedSource; sourceChars: number }> {
  const versions = await workspace.tx<{ rights_status: string }[]>`
    select rights_status from source_document_versions
    where id = ${input.documentVersionId}::uuid and workspace_id = ${workspace.workspaceId}::uuid
  `;
  const version = versions[0];
  if (!version) throw new SourceError("cross-workspace");
  if (version.rights_status === "blocked") throw new SourceError("rights-blocked");
  // Audience-scoping defect, left unchanged for the generation task: this reads the
  // newest active recommendation on the document and does not match the requested
  // audience or age band. Two workflows on one source can therefore be judged by
  // each other's run. The later task must load the workflow's own run and keep
  // the rights, review, eligibility, and extraction checks below.
  const runs = await workspace.tx<{ status: string; reasons: unknown }[]>`
    select status, reasons from recommendation_runs
    where workspace_id = ${workspace.workspaceId}::uuid and document_version_id = ${input.documentVersionId}::uuid and active = true
    order by created_at desc
    limit 1
  `;
  const run = runs[0];
  if (!run) throw new SourceError("generation-denied");
  if (strings(run.reasons).some((reason) => BLOCKING.has(reason))) throw new SourceError("review-required");
  if (run.status === "insufficient-support") throw new SourceError("insufficient-source");
  const candidates = await workspace.tx<{
    title: string;
    eligibility: string;
    reasons: unknown;
    source_span_ids: unknown;
    extraction_id: string;
  }[]>`
    select title, eligibility, reasons, source_span_ids, extraction_id::text
    from topic_candidates
    where id = ${input.topicCandidateId}::uuid and workspace_id = ${workspace.workspaceId}::uuid
      and document_version_id = ${input.documentVersionId}::uuid
  `;
  const candidate = candidates[0];
  if (!candidate) throw new SourceError("generation-denied");
  if (strings(candidate.reasons).some((reason) => BLOCKING.has(reason)) || candidate.eligibility === "needs-review") {
    throw new SourceError("review-required");
  }
  if (candidate.eligibility === "insufficient-support") throw new SourceError("insufficient-source");
  if (candidate.eligibility !== "eligible") throw new SourceError("generation-denied");
  const latest = await workspace.tx<{ id: string }[]>`
    select id::text from extraction_results
    where workspace_id = ${workspace.workspaceId}::uuid and document_version_id = ${input.documentVersionId}::uuid
    order by completed_at desc
    limit 1
  `;
  if (latest[0]?.id !== candidate.extraction_id) throw new SourceError("stale-extraction");
  const spanRows = await workspace.tx<{ id: string; excerpt: string }[]>`
    select id::text, excerpt from source_spans
    where workspace_id = ${workspace.workspaceId}::uuid and document_version_id = ${input.documentVersionId}::uuid
  `;
  const wanted = strings(candidate.source_span_ids);
  const spans = spanRows.filter((span) => wanted.includes(span.id));
  if (wanted.length === 0 || spans.length !== wanted.length) throw new SourceError("generation-denied");
  if ([candidate.title, ...spans.map((span) => span.excerpt)].some((value) => limitedSensitivityMatch(value))) {
    throw new SourceError("review-required");
  }
  return {
    source: {
      documentVersionId: input.documentVersionId,
      topicTitle: candidate.title,
      audienceLabel: input.audienceLabel,
      ageBand: input.ageBand,
      spans,
    },
    sourceChars: spans.reduce((sum, span) => sum + span.excerpt.length, 0),
  };
}

async function claimRun(workspace: AuthorizedWorkspace, jobId: string, topicCandidateId: string, loaded: { source: LoadedSource; sourceChars: number }): Promise<Gate> {
  const claimed = await workspace.tx<{ id: string; attempt_count: number }[]>`
    update experience_generation_jobs
    set status = 'planning', attempt_count = attempt_count + 1, lease_owner = ${LEASE_OWNER},
        lease_expires_at = now() + interval '30 seconds', updated_at = now(), failure_code = null
    where id = ${jobId}::uuid and workspace_id = ${workspace.workspaceId}::uuid and permanent = false
      and attempt_count < max_attempts
      and (status = 'queued' or (status in ('planning', 'compiling', 'validating') and lease_expires_at < now()))
    returning id::text, attempt_count
  `;
  const claim = claimed[0];
  if (claim) {
    return { kind: "run", jobId, topicCandidateId, source: loaded.source, sourceChars: loaded.sourceChars, attempt: claim.attempt_count };
  }
  const view = await present(workspace, jobId, false);
  if (!view) throw new SourceError("cross-workspace");
  if (view.status === "ready" || view.status === "failed") return view.status === "failed"
    ? { kind: "stop", code: asCode(view.failureCode) }
    : { kind: "done", view: { ...view, replayed: true } };
  return { kind: "done", view };
}

async function persist(
  workspace: AuthorizedWorkspace,
  workspaceId: string,
  run: Run,
  outcome: Compilation,
  compileMs: number,
  durationMs: number,
): Promise<{ kind: "done"; view: CreatorExperienceView } | { kind: "stop"; code: SourceErrorCode }> {
  const locked = await workspace.tx<{ id: string }[]>`
    update experience_generation_jobs
    set source_chars = ${run.sourceChars}, compile_ms = ${compileMs}, duration_ms = ${durationMs}, updated_at = now()
    where id = ${run.jobId}::uuid and workspace_id = ${workspaceId}::uuid and lease_owner = ${LEASE_OWNER} and status = 'validating'
    returning id::text
  `;
  if (locked.length === 0) {
    const view = await present(workspace, run.jobId, true);
    if (!view) throw new SourceError("cross-workspace");
    return view.status === "failed" ? { kind: "stop", code: asCode(view.failureCode) } : { kind: "done", view };
  }
  const versionId = outcome.ok ? outcome.manifest.versionId : null;
  const reviewStatus = outcome.ok ? await reviewFor(workspace, run.source.documentVersionId) : null;
  if (outcome.ok && versionId) {
    await workspace.tx`
      insert into experience_versions (
        id, workspace_id, document_version_id, topic_candidate_id, job_id, experience_id, compiler_version,
        prompt_version, source_span_ids, manifest, publication_status, created_by
      ) values (
        ${versionId}::uuid, ${workspaceId}::uuid, ${run.source.documentVersionId}::uuid, ${run.topicCandidateId}::uuid,
        ${run.jobId}::uuid, ${outcome.manifest.experienceId}::uuid, ${COMPILER_VERSION}, ${PROMPT_VERSION},
        ${JSON.stringify(outcome.plan.sourceReferences.map((item) => item.spanId))}::jsonb,
        ${JSON.stringify(outcome.manifest)}::jsonb, 'unpublished', ${workspace.userId}::uuid
      )
    `;
  }
  await workspace.tx`
    insert into experience_plans (id, workspace_id, job_id, experience_version_id, plan, created_by)
    values (
      ${randomUUID()}::uuid, ${workspaceId}::uuid, ${run.jobId}::uuid, ${versionId}::uuid,
      ${JSON.stringify(outcome.ok ? outcome.plan : { rejected: true, code: outcome.code })}::jsonb,
      ${workspace.userId}::uuid
    )
  `;
  await workspace.tx`
    insert into experience_validation_results (
      id, workspace_id, job_id, experience_version_id, ok, diagnostics, simulation, created_by
    ) values (
      ${randomUUID()}::uuid, ${workspaceId}::uuid, ${run.jobId}::uuid, ${versionId}::uuid, ${outcome.ok},
      ${JSON.stringify({ items: outcome.ok ? [] : outcome.diagnostics })}::jsonb,
      ${JSON.stringify(outcome.ok ? outcome.simulation : outcome.simulation)}::jsonb,
      ${workspace.userId}::uuid
    )
  `;
  await workspace.tx`
    insert into experience_generation_costs (
      id, workspace_id, job_id, provider, model, pricing_version, input_tokens, output_tokens, call_count,
      retry_count, estimated_cost_micros, actual_cost_micros, currency, usage_kind, created_by
    ) values (
      ${randomUUID()}::uuid, ${workspaceId}::uuid, ${run.jobId}::uuid, ${FIXTURE_PROVIDER}, 'none', ${FIXTURE_PRICE_VERSION},
      0, 0, 0, ${Math.max(0, run.attempt - 1)}, null, 0, 'USD', 'none', ${workspace.userId}::uuid
    )
  `;
  await workspace.tx`
    update experience_generation_jobs
    set status = ${outcome.ok ? "ready" : "failed"}, permanent = true, review_status = ${reviewStatus},
        failure_code = ${outcome.ok ? null : outcome.code}, experience_version_id = ${versionId}::uuid,
        lease_owner = null, lease_expires_at = null, updated_at = now()
    where id = ${run.jobId}::uuid and workspace_id = ${workspaceId}::uuid
  `;
  if (!outcome.ok) return { kind: "stop", code: outcome.code };
  const view = await present(workspace, run.jobId, false);
  if (!view) throw new SourceError("cross-workspace");
  return { kind: "done", view };
}

async function reviewFor(workspace: AuthorizedWorkspace, documentVersionId: string) {
  const rows = await workspace.tx<{ rights_status: string }[]>`
    select rights_status from source_document_versions
    where id = ${documentVersionId}::uuid and workspace_id = ${workspace.workspaceId}::uuid
  `;
  return rows[0]?.rights_status === "cleared" ? "ready-for-review" : "review-required";
}

async function present(workspace: AuthorizedWorkspace, jobId: string, replayed: boolean): Promise<CreatorExperienceView | null> {
  const rows = await workspace.tx<{
    id: string;
    status: string;
    failure_code: string | null;
    review_status: string | null;
    provider: string;
    experience_version_id: string | null;
    title: string | null;
    publication_status: string | null;
    rights_status: string | null;
    usage_kind: string | null;
    currency: string | null;
    pricing_version: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    call_count: number | null;
    retry_count: number | null;
    estimated_cost_micros: number | null;
    actual_cost_micros: number | null;
  }[]>`
    select j.id::text, j.status, j.failure_code, j.review_status, j.provider, j.experience_version_id::text,
      v.manifest->>'title' as title, v.publication_status, d.rights_status, c.usage_kind, c.currency,
      c.pricing_version, c.input_tokens, c.output_tokens, c.call_count, c.retry_count,
      c.estimated_cost_micros, c.actual_cost_micros
    from experience_generation_jobs j
    left join experience_versions v on v.id = j.experience_version_id and v.workspace_id = j.workspace_id
    left join source_document_versions d on d.id = j.document_version_id and d.workspace_id = j.workspace_id
    left join experience_generation_costs c on c.job_id = j.id and c.workspace_id = j.workspace_id
    where j.id = ${jobId}::uuid and j.workspace_id = ${workspace.workspaceId}::uuid
  `;
  const row = rows[0];
  if (!row || !STATUSES.has(row.status as GenerationStatus) || row.provider !== FIXTURE_PROVIDER) return null;
  const status = row.status as GenerationStatus;
  const versionId = row.experience_version_id;
  const usage: GenerationUsage | null = row.usage_kind === "actual" || row.usage_kind === "estimate" || row.usage_kind === "none"
    ? {
        kind: row.usage_kind,
        currency: "USD",
        pricingVersion: row.pricing_version ?? FIXTURE_PRICE_VERSION,
        inputTokens: row.input_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
        callCount: row.call_count ?? 0,
        retryCount: row.retry_count ?? 0,
        estimatedCostMicros: row.estimated_cost_micros,
        actualCostMicros: row.actual_cost_micros,
      }
    : null;
  return {
    jobId: row.id,
    status,
    experienceVersionId: versionId,
    title: row.title ? publicTitle(row.title) : null,
    reviewStatus: row.review_status === "ready-for-review" || row.review_status === "review-required" ? row.review_status : null,
    publicationStatus: row.publication_status === "unpublished" ? "unpublished" : null,
    rightsStatus: row.rights_status === "cleared" || row.rights_status === "blocked" || row.rights_status === "unverified" ? row.rights_status : null,
    failureCode: row.failure_code,
    replayed,
    provider: FIXTURE_PROVIDER,
    liveModel: false,
    aiGenerationAuthorized: false,
    usage,
    previewPath: status === "ready" && versionId ? `/creator/preview/${versionId}` : null,
  };
}

async function mark(tx: Sql, workspaceId: string, jobId: string, status: "compiling" | "validating") {
  const rows = await tx<{ id: string }[]>`
    update experience_generation_jobs
    set status = ${status}, updated_at = now()
    where id = ${jobId}::uuid and workspace_id = ${workspaceId}::uuid and lease_owner = ${LEASE_OWNER}
      and permanent = false and status in ('planning', 'compiling', 'validating')
    returning id::text
  `;
  return rows.length > 0;
}

function assertGeneration(input: { authorizeGeneration: true; provider: typeof FIXTURE_PROVIDER; documentVersionId: string; topicCandidateId: string; idempotencyKey: string; audienceLabel: string; ageBand: string }) {
  if (input.authorizeGeneration !== true) throw new SourceError("generation-denied");
  if (input.provider !== FIXTURE_PROVIDER) throw new SourceError("generation-unavailable");
  if (!Uuid.safeParse(input.documentVersionId).success || !Uuid.safeParse(input.topicCandidateId).success || !Uuid.safeParse(input.idempotencyKey).success) {
    throw new SourceError("invalid-generation");
  }
  if (!AgeBand.safeParse(input.ageBand).success || !z.enum(AUDIENCE_OPTIONS).safeParse(input.audienceLabel).success) {
    throw new SourceError("invalid-generation");
  }
}

function strings(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function asCode(value: string | null): SourceErrorCode {
  if (value && (SOURCE_ERROR_CODES as readonly string[]).includes(value)) return value as SourceErrorCode;
  return "invalid-experience";
}

function publicTitle(value: string | null) {
  if (!value || /<script|javascript:|private:\/\/|https?:\/\//i.test(value)) return "Private draft";
  return value.slice(0, 120);
}

function rethrow(error: unknown): never {
  if (error instanceof SourceError) throw error;
  const failure = databaseFailure(error);
  if (/row-level security/i.test(failure.message)) throw new SourceError("cross-workspace");
  throw failure;
}
