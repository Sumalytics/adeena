import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import type { ExperienceManifest } from "@adeena/experience-schema";
import { parseManifest } from "@adeena/experience-schema";
import {
  EDIT_ALTERNATIVES,
  EDIT_MODEL_INSTRUCTIONS,
  GROQ_DIALOGUE_INSTRUCTIONS,
  GROQ_GRAPH_INSTRUCTIONS,
  EDIT_POLICY_VERSION,
  EDIT_PROMPT_VERSION,
  ExperienceEditAuditEventV1,
  ExperienceRevisionV1,
  MODEL_EDIT_PROMPT_VERSION,
  applyModelOutput,
  dialogueEditContext,
  editModelContext,
  graphEditContext,
  groqEditKind,
  prepareDialogueTarget,
  reviseManifest,
  screenEditInstruction,
  type CreatorEditProposal,
  type ExperienceRevisionItem,
  type RevisionResult,
} from "@/experience/edit";
import { groqGraphTransportSchema, groqTransportSchema } from "@/experience/groq-edit";
import {
  COMPILER_VERSION,
  CONFIGURED_PROVIDER,
  FIXTURE_PRICE_VERSION,
  FIXTURE_PROVIDER,
  GROQ_COMMERCIAL_SCHEDULE,
  configuredEditAuthorization,
  editCallEstimate,
  logEditDiagnostic,
  requestPaidEdit,
  type ProviderEnv,
  type RateSchedule,
} from "@/experience/provider";
import { AUDIENCE_OPTIONS } from "@/app/studio/studio-form";
import { AgeBand } from "@/contracts/common";
import { SourceError, SOURCE_ERROR_CODES, type SourceErrorCode } from "@/source/errors";
import { withWorkspace, type AuthorizedWorkspace } from "./authz";
import { databaseFailure } from "./client";
import type { VerifiedIdentity } from "./identity";

const LEASE_OWNER = "creator-edit";
const READY_CAP = 4;
const FREE_SESSION_ID = randomUUID();

type ProposalRow = {
  id: string;
  base_version_id: string;
  proposed_version_id: string | null;
  summary: string | null;
  graph_changed: boolean | null;
  uncertainty: string | null;
  review_note: string | null;
  scenes_touched: number | null;
  choices_changed: number | null;
  failure_code: string | null;
  status: string;
};

export type EditOutcome =
  | { kind: "ready"; proposal: CreatorEditProposal }
  | { kind: "pending"; editJobId: string }
  | { kind: "discarded"; currentVersionId: string; previewPath: string; replayed: boolean }
  | { kind: "accepted"; currentVersionId: string; previewPath: string; replayed: boolean }
  | { kind: "stop"; code: SourceErrorCode; alternatives: string[] };

export async function proposeExperienceEdit(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  baseVersionId: string;
  expectedBaseVersionId: string;
  instruction: string;
  sceneId?: string;
  idempotencyKey: string;
  authorizeEdit: true;
  provider: typeof FIXTURE_PROVIDER | typeof CONFIGURED_PROVIDER;
  env?: ProviderEnv;
  fetchImpl?: typeof fetch;
  schedules?: Record<string, RateSchedule>;
}) {
  if ((input.provider !== FIXTURE_PROVIDER && input.provider !== CONFIGURED_PROVIDER) || input.authorizeEdit !== true) throw new SourceError("generation-denied");
  if (input.provider === CONFIGURED_PROVIDER) {
    const auth = configuredEditAuthorization(input.env ?? process.env, input.schedules);
    if (!auth.ok) throw new SourceError(auth.code);
  }
  try {
    const prepared = await withWorkspace(input.sql, input.identity, input.workspaceId, (workspace) => prepare(workspace, input));
    if (prepared.kind !== "run") return prepared.outcome;
    const produced = await produce(input, prepared);
    return await withWorkspace(input.sql, input.identity, input.workspaceId, (workspace) => complete(workspace, prepared, produced.outcome, produced.usage, produced.persistFailure));
  } catch (error) {
    rethrow(error);
  }
}

export async function resumeExperienceEdit(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  editJobId: string;
  env?: ProviderEnv;
  fetchImpl?: typeof fetch;
  schedules?: Record<string, RateSchedule>;
}) {
  try {
    const prepared = await withWorkspace(input.sql, input.identity, input.workspaceId, (workspace) => reclaim(workspace, input.editJobId));
    if (prepared.kind !== "run") return prepared.outcome;
    const produced = await produce(input, prepared);
    return await withWorkspace(input.sql, input.identity, input.workspaceId, (workspace) => complete(workspace, prepared, produced.outcome, produced.usage, produced.persistFailure));
  } catch (error) {
    rethrow(error);
  }
}

export async function acceptExperienceEdit(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  editJobId: string;
  expectedBaseVersionId: string;
}) {
  try {
    return await withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
      const job = await lockedJob(workspace, input.editJobId);
      if (job.status === "accepted" && job.proposed_version_id) {
        return accepted(job.proposed_version_id, true);
      }
      if (job.status !== "ready" || !job.proposed_version_id) throw new SourceError("invalid-edit");
      if (job.base_version_id !== input.expectedBaseVersionId) throw new SourceError("stale-version");
      const pointer = await pointerFor(workspace, job.experience_id);
      if (pointer === null) {
        if (job.base_parent_version_id) throw new SourceError("stale-version");
        try {
          await workspace.tx`
            insert into experience_current_drafts (workspace_id, experience_id, version_id, updated_by)
            values (
              ${workspace.workspaceId}::uuid, ${job.experience_id}::uuid, ${job.proposed_version_id}::uuid, ${workspace.userId}::uuid
            )
          `;
        } catch (error) {
          if (postgresCode(error) === "23505") throw new SourceError("stale-version");
          throw error;
        }
      } else if (pointer !== job.base_version_id) {
        throw new SourceError("stale-version");
      } else {
        const moved = await workspace.tx<{ version_id: string }[]>`
          update experience_current_drafts
          set version_id = ${job.proposed_version_id}::uuid, updated_by = ${workspace.userId}::uuid, updated_at = now()
          where workspace_id = ${workspace.workspaceId}::uuid and experience_id = ${job.experience_id}::uuid
            and version_id = ${job.base_version_id}::uuid
          returning version_id::text
        `;
        if (moved.length === 0) throw new SourceError("stale-version");
      }
      const updated = await workspace.tx<{ id: string }[]>`
        update experience_edit_jobs
        set status = 'accepted', lease_owner = null, lease_expires_at = null, updated_at = now()
        where id = ${job.id}::uuid and workspace_id = ${workspace.workspaceId}::uuid and status = 'ready'
        returning id::text
      `;
      if (updated.length === 0) throw new SourceError("stale-version");
      await recordEvent(workspace, job.id, "accepted", "The creator accepted this revision.");
      return accepted(job.proposed_version_id, false);
    });
  } catch (error) {
    rethrow(error);
  }
}

export async function rejectExperienceEdit(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  editJobId: string;
}) {
  try {
    return await withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
      const job = await lockedJob(workspace, input.editJobId);
      const current = await currentVersion(workspace, job.experience_id, job.base_version_id, job.base_parent_version_id);
      if (job.status === "rejected") return discarded(current, true);
      if (job.status !== "ready") throw new SourceError("invalid-edit");
      const updated = await workspace.tx<{ id: string }[]>`
        update experience_edit_jobs
        set status = 'rejected', lease_owner = null, lease_expires_at = null, updated_at = now()
        where id = ${job.id}::uuid and workspace_id = ${workspace.workspaceId}::uuid and status = 'ready'
        returning id::text
      `;
      if (updated.length === 0) throw new SourceError("invalid-edit");
      await recordEvent(workspace, job.id, "rejected", "The creator discarded this revision.");
      return discarded(current, false);
    });
  } catch (error) {
    rethrow(error);
  }
}

export async function listExperienceRevisions(
  sql: Sql,
  identity: VerifiedIdentity,
  workspaceId: string,
  versionId: string,
): Promise<ExperienceRevisionItem[]> {
  try {
    return await withWorkspace(sql, identity, workspaceId, async (workspace) => {
      const rows = await workspace.tx<{ id: string; parent_version_id: string | null; title: string | null; is_current: boolean; summary: string | null }[]>`
        select v.id::text, v.parent_version_id::text, v.manifest->>'title' as title,
          (c.version_id = v.id or (c.experience_id is null and v.parent_version_id is null)) as is_current,
          e.summary
        from experience_versions anchor
        join experience_versions v on v.experience_id = anchor.experience_id and v.workspace_id = anchor.workspace_id
        left join experience_current_drafts c on c.experience_id = v.experience_id and c.workspace_id = v.workspace_id
        left join experience_edit_jobs e on e.id = v.edit_job_id and e.workspace_id = v.workspace_id
        where anchor.id = ${versionId}::uuid and anchor.workspace_id = ${workspace.workspaceId}::uuid
        order by v.created_at asc
      `;
      if (rows.length === 0) throw new SourceError("cross-workspace");
      return rows.map((row) => ({
        id: row.id,
        title: publicTitle(row.title),
        current: row.is_current === true,
        summary: row.summary,
        kind: row.parent_version_id ? "revision" as const : "original" as const,
      }));
    });
  } catch (error) {
    rethrow(error);
  }
}

type Run = {
  kind: "run";
  jobId: string;
  manifest: ExperienceManifest;
  instruction: string;
  sceneId: string | null;
  documentVersionId: string;
  topicCandidateId: string;
  experienceId: string;
  sourceSpanIds: unknown;
  reviewStatus: "ready-for-review" | "review-required";
  audience: { label: string; ageBand: string } | null;
  baseVersionId: string;
  provider: typeof FIXTURE_PROVIDER | typeof CONFIGURED_PROVIDER;
};

type EditUsage = {
  provider: typeof FIXTURE_PROVIDER | typeof CONFIGURED_PROVIDER;
  model: string;
  priceVersion: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  responseId: string | null;
  callCount: number;
  retryCount: number;
  estimatedCostMicros: number;
  actualCostMicros: number;
  commercialEstimateMicros: number | null;
  usageKind: "none" | "estimate" | "actual";
  executionMode: "fixture" | "paid-development" | "free-development";
  latencyMs: number | null;
  remainingRequests: number | null;
  remainingTokens: number | null;
};

const FIXTURE_USAGE: EditUsage = {
  provider: FIXTURE_PROVIDER,
  model: "none",
  priceVersion: FIXTURE_PRICE_VERSION,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  responseId: null,
  callCount: 0,
  retryCount: 0,
  estimatedCostMicros: 0,
  actualCostMicros: 0,
  commercialEstimateMicros: null,
  usageKind: "none",
  executionMode: "fixture",
  latencyMs: null,
  remainingRequests: null,
  remainingTokens: null,
};

type Prepared = Run | { kind: "done"; outcome: EditOutcome };

async function prepare(workspace: AuthorizedWorkspace, input: {
  baseVersionId: string;
  expectedBaseVersionId: string;
  instruction: string;
  sceneId?: string;
  idempotencyKey: string;
  provider: typeof FIXTURE_PROVIDER | typeof CONFIGURED_PROVIDER;
}): Promise<Prepared> {
  const loaded = await loadBase(workspace, input.baseVersionId);
  if (loaded.currentVersionId !== input.baseVersionId || input.expectedBaseVersionId !== input.baseVersionId) {
    throw new SourceError("stale-version");
  }
  const existing = await workspace.tx<ProposalRow[]>`
    select id::text, status, instruction, provider, base_version_id::text, proposed_version_id::text, failure_code, permanent,
      lease_expires_at, attempt_count, max_attempts, summary, graph_changed, uncertainty, review_note,
      scenes_touched, choices_changed
    from experience_edit_jobs
    where workspace_id = ${workspace.workspaceId}::uuid and idempotency_key = ${input.idempotencyKey}::uuid
  `;
  const job = existing[0] as (ProposalRow & {
    instruction: string;
    provider: string;
    permanent: boolean;
    lease_expires_at: Date | string | null;
    attempt_count: number;
    max_attempts: number;
  }) | undefined;
  if (job) {
    if (job.instruction !== input.instruction || job.base_version_id !== input.baseVersionId) throw new SourceError("invalid-edit");
    return finishExisting(workspace, job, loaded);
  }
  const waiting = await workspace.tx<{ total: number }[]>`
    select count(*)::int as total from experience_edit_jobs
    where workspace_id = ${workspace.workspaceId}::uuid and experience_id = ${loaded.experienceId}::uuid and status = 'ready'
  `;
  if (Number(waiting[0]?.total ?? 0) >= READY_CAP) throw new SourceError("job-limit");
  const jobId = randomUUID();
  await workspace.tx`
    insert into experience_edit_jobs (
      id, workspace_id, experience_id, base_version_id, expected_base_version_id, idempotency_key, instruction,
      scene_id, status, attempt_count, max_attempts, lease_owner, lease_expires_at, provider, prompt_version,
      compiler_version, edit_policy_version, created_by
    ) values (
      ${jobId}::uuid, ${workspace.workspaceId}::uuid, ${loaded.experienceId}::uuid, ${input.baseVersionId}::uuid,
      ${input.expectedBaseVersionId}::uuid, ${input.idempotencyKey}::uuid, ${input.instruction},
      ${input.sceneId ?? null}, 'planning', 1, 2, ${LEASE_OWNER}, now() + make_interval(secs => ${input.provider === CONFIGURED_PROVIDER ? 90 : 30}), ${input.provider},
      ${input.provider === CONFIGURED_PROVIDER ? MODEL_EDIT_PROMPT_VERSION : EDIT_PROMPT_VERSION}, ${COMPILER_VERSION}, ${EDIT_POLICY_VERSION}, ${workspace.userId}::uuid
    )
  `;
  await recordEvent(workspace, jobId, "requested", "An edit was requested.");
  return {
    kind: "run",
    jobId,
    instruction: input.instruction,
    sceneId: input.sceneId ?? null,
    provider: input.provider,
    ...loaded,
    baseVersionId: input.baseVersionId,
  };
}

async function finishExisting(workspace: AuthorizedWorkspace, job: ProposalRow & {
  provider?: string;
  permanent: boolean;
  lease_expires_at: Date | string | null;
  attempt_count: number;
  max_attempts: number;
}, loaded: Omit<Run, "kind" | "jobId" | "instruction" | "sceneId" | "baseVersionId" | "provider"> & { baseVersionId?: string }): Promise<Prepared> {
  if (job.status === "ready" && job.proposed_version_id) return { kind: "done", outcome: { kind: "ready", proposal: await proposalFrom(workspace, job, true) } };
  if (job.status === "accepted" && job.proposed_version_id) return { kind: "done", outcome: accepted(job.proposed_version_id, true) };
  if (job.status === "rejected") {
    const current = await currentVersion(workspace, loaded.experienceId, job.base_version_id, null);
    return { kind: "done", outcome: discarded(current, true) };
  }
  if (job.status === "failed" && job.permanent) return { kind: "done", outcome: stopped(job.failure_code) };
  const leaseOpen = job.lease_expires_at !== null && new Date(job.lease_expires_at).getTime() > Date.now();
  if (leaseOpen && (job.status === "planning" || job.status === "validating")) {
    return { kind: "done", outcome: { kind: "pending", editJobId: job.id } };
  }
  if (job.attempt_count >= job.max_attempts) {
    await failJob(workspace, job.id, "invalid-experience");
    return { kind: "done", outcome: stopped("invalid-experience") };
  }
  const claimed = await workspace.tx<{ id: string }[]>`
    update experience_edit_jobs
    set status = 'planning', lease_owner = ${LEASE_OWNER}, lease_expires_at = now() + make_interval(secs => ${job.provider === CONFIGURED_PROVIDER ? 90 : 30}),
      attempt_count = attempt_count + 1, updated_at = now()
    where id = ${job.id}::uuid and workspace_id = ${workspace.workspaceId}::uuid
      and status in ('planning', 'validating') and (lease_expires_at is null or lease_expires_at < now())
      and attempt_count < max_attempts
    returning id::text
  `;
  if (claimed.length === 0) return { kind: "done", outcome: { kind: "pending", editJobId: job.id } };
  const instruction = await workspace.tx<{ instruction: string; scene_id: string | null }[]>`
    select instruction, scene_id from experience_edit_jobs
    where id = ${job.id}::uuid and workspace_id = ${workspace.workspaceId}::uuid
  `;
  return {
    kind: "run",
    jobId: job.id,
    manifest: loaded.manifest,
    instruction: instruction[0]?.instruction ?? "",
    sceneId: instruction[0]?.scene_id ?? null,
    documentVersionId: loaded.documentVersionId,
    topicCandidateId: loaded.topicCandidateId,
    audience: loaded.audience,
    experienceId: loaded.experienceId,
    sourceSpanIds: loaded.sourceSpanIds,
    reviewStatus: loaded.reviewStatus,
    baseVersionId: job.base_version_id,
    provider: job.provider === CONFIGURED_PROVIDER ? CONFIGURED_PROVIDER : FIXTURE_PROVIDER,
  };
}

async function reclaim(workspace: AuthorizedWorkspace, editJobId: string): Promise<Prepared> {
  const rows = await workspace.tx<{ base_version_id: string }[]>`
    select base_version_id::text from experience_edit_jobs
    where id = ${editJobId}::uuid and workspace_id = ${workspace.workspaceId}::uuid
  `;
  const baseId = rows[0]?.base_version_id;
  if (!baseId) throw new SourceError("cross-workspace");
  const loaded = await loadBase(workspace, baseId);
  const existing = await workspace.tx<ProposalRow[]>`
    select id::text, status, provider, base_version_id::text, proposed_version_id::text, failure_code, permanent,
      lease_expires_at, attempt_count, max_attempts, summary, graph_changed, uncertainty, review_note,
      scenes_touched, choices_changed
    from experience_edit_jobs
    where id = ${editJobId}::uuid and workspace_id = ${workspace.workspaceId}::uuid
  `;
  const job = existing[0] as ProposalRow & { permanent: boolean; lease_expires_at: Date | string | null; attempt_count: number; max_attempts: number };
  if (!job) throw new SourceError("cross-workspace");
  return finishExisting(workspace, job, { ...loaded, baseVersionId: baseId });
}

async function complete(workspace: AuthorizedWorkspace, run: Run, outcome: RevisionResult | { ok: false; code: SourceErrorCode; alternatives: string[] }, usage: EditUsage = FIXTURE_USAGE, persistFailure = true): Promise<EditOutcome> {
  if (!outcome.ok && !persistFailure) return stopped(outcome.code, outcome.alternatives);
  const locked = await workspace.tx<{ id: string }[]>`
    update experience_edit_jobs
    set status = 'validating', updated_at = now()
    where id = ${run.jobId}::uuid and workspace_id = ${workspace.workspaceId}::uuid
      and status = 'planning' and lease_owner = ${LEASE_OWNER}
    returning id::text
  `;
  if (locked.length === 0) {
    const current = await workspace.tx<ProposalRow[]>`
      select id::text, status, base_version_id::text, proposed_version_id::text, failure_code, summary,
        graph_changed, uncertainty, review_note, scenes_touched, choices_changed
      from experience_edit_jobs
      where id = ${run.jobId}::uuid and workspace_id = ${workspace.workspaceId}::uuid
    `;
    const job = current[0];
    if (job?.status === "ready" && job.proposed_version_id) return { kind: "ready", proposal: await proposalFrom(workspace, job, true) };
    if (job?.status === "failed") return stopped(job.failure_code);
    return { kind: "pending", editJobId: run.jobId };
  }
  if (!outcome.ok) {
    await recordCost(workspace, run.jobId, usage);
    await failJob(workspace, run.jobId, outcome.code);
    return stopped(outcome.code, outcome.alternatives);
  }
  const revision = ExperienceRevisionV1.safeParse({
    contract: "EXPERIENCE-REVISION-v1",
    versionId: outcome.manifest.versionId,
    parentVersionId: run.baseVersionId,
    experienceId: outcome.manifest.experienceId,
    publicationStatus: "unpublished",
  });
  if (!revision.success || outcome.manifest.experienceId !== run.experienceId) {
    await failJob(workspace, run.jobId, "invalid-experience");
    return stopped("invalid-experience");
  }
  const reviewStatus = outcome.validation.graphChanged || run.reviewStatus !== "ready-for-review" ? "review-required" : "ready-for-review";
  const reviewNote = outcome.plan.reviewRequirements[0] ?? null;
  await workspace.tx`
    insert into experience_versions (
      id, workspace_id, document_version_id, topic_candidate_id, job_id, experience_id, compiler_version,
      prompt_version, source_span_ids, manifest, publication_status, created_by, parent_version_id, edit_job_id
    ) values (
      ${outcome.manifest.versionId}::uuid, ${workspace.workspaceId}::uuid, ${run.documentVersionId}::uuid,
      ${run.topicCandidateId}::uuid, null, ${outcome.manifest.experienceId}::uuid, ${COMPILER_VERSION},
      ${outcome.plan.promptVersion}, ${JSON.stringify(run.sourceSpanIds)}::jsonb, ${JSON.stringify(outcome.manifest)}::jsonb,
      'unpublished', ${workspace.userId}::uuid, ${run.baseVersionId}::uuid, ${run.jobId}::uuid
    )
  `;
  await workspace.tx`
    update experience_edit_jobs
    set status = 'ready', proposed_version_id = ${outcome.manifest.versionId}::uuid, permanent = true,
      review_status = ${reviewStatus}, intent = ${outcome.plan.intent}, plan = ${JSON.stringify(outcome.plan)}::jsonb,
      patch = ${JSON.stringify(outcome.patch)}::jsonb, validation = ${JSON.stringify(outcome.validation)}::jsonb,
      summary = ${outcome.plan.summary}, graph_changed = ${outcome.validation.graphChanged},
      uncertainty = ${outcome.plan.uncertainty}, review_note = ${reviewNote},
      scenes_touched = ${outcome.validation.scenesTouched}, choices_changed = ${outcome.validation.choicesChanged},
      lease_owner = null, lease_expires_at = null, updated_at = now()
    where id = ${run.jobId}::uuid and workspace_id = ${workspace.workspaceId}::uuid
  `;
  await recordCost(workspace, run.jobId, usage);
  await recordEvent(workspace, run.jobId, "ready", outcome.plan.summary);
  return {
    kind: "ready",
    proposal: await proposalFrom(workspace, {
      id: run.jobId,
      base_version_id: run.baseVersionId,
      proposed_version_id: outcome.manifest.versionId,
      summary: outcome.plan.summary,
      graph_changed: outcome.validation.graphChanged,
      uncertainty: outcome.plan.uncertainty,
      review_note: reviewNote,
      scenes_touched: outcome.validation.scenesTouched,
      choices_changed: outcome.validation.choicesChanged,
      failure_code: null,
      status: "ready",
    }, false),
  };
}

async function loadBase(workspace: AuthorizedWorkspace, versionId: string) {
  const rows = await workspace.tx<{
    manifest: unknown;
    experience_id: string;
    document_version_id: string;
    topic_candidate_id: string;
    parent_version_id: string | null;
    source_span_ids: unknown;
    review_status: string | null;
    pointer_version_id: string | null;
    audience_label: string | null;
    age_band: string | null;
  }[]>`
    select v.manifest, v.experience_id::text, v.document_version_id::text, v.topic_candidate_id::text,
      v.parent_version_id::text, v.source_span_ids, coalesce(j.review_status, e.review_status) as review_status,
      c.version_id::text as pointer_version_id, audience.audience_label, audience.age_band
    from experience_versions v
    left join experience_generation_jobs j on j.id = v.job_id and j.workspace_id = v.workspace_id
    left join experience_edit_jobs e on e.id = v.edit_job_id and e.workspace_id = v.workspace_id
    left join experience_current_drafts c on c.experience_id = v.experience_id and c.workspace_id = v.workspace_id
    left join lateral (
      select g.audience_label, g.age_band
      from experience_versions root
      join experience_generation_jobs g on g.id = root.job_id and g.workspace_id = root.workspace_id
      where root.experience_id = v.experience_id and root.workspace_id = v.workspace_id and root.parent_version_id is null
      limit 1
    ) audience on true
    where v.id = ${versionId}::uuid and v.workspace_id = ${workspace.workspaceId}::uuid
  `;
  const row = rows[0];
  if (!row) throw new SourceError("cross-workspace");
  const parsed = parseManifest(row.manifest);
  if (!parsed.ok) throw new SourceError("invalid-experience");
  const currentVersionId = row.pointer_version_id ?? (row.parent_version_id ? "" : versionId);
  return {
    manifest: parsed.manifest,
    documentVersionId: row.document_version_id,
    topicCandidateId: row.topic_candidate_id,
    experienceId: row.experience_id,
    sourceSpanIds: row.source_span_ids,
    reviewStatus: row.review_status === "ready-for-review" ? "ready-for-review" as const : "review-required" as const,
    audience: storedAudience(row.audience_label, row.age_band),
    currentVersionId,
  };
}

function storedAudience(label: string | null, ageBand: string | null) {
  const age = AgeBand.safeParse(ageBand);
  const audience = z.enum(AUDIENCE_OPTIONS).safeParse(label);
  if (!age.success || !audience.success) return null;
  return { label: audience.data, ageBand: age.data };
}

async function lockedJob(workspace: AuthorizedWorkspace, editJobId: string) {
  const rows = await workspace.tx<{
    id: string;
    status: string;
    base_version_id: string;
    proposed_version_id: string | null;
    experience_id: string;
    base_parent_version_id: string | null;
  }[]>`
    select j.id::text, j.status, j.base_version_id::text, j.proposed_version_id::text, j.experience_id::text,
      v.parent_version_id::text as base_parent_version_id
    from experience_edit_jobs j
    join experience_versions v on v.id = j.base_version_id and v.workspace_id = j.workspace_id
    where j.id = ${editJobId}::uuid and j.workspace_id = ${workspace.workspaceId}::uuid
    for update of j
  `;
  const job = rows[0];
  if (!job) throw new SourceError("cross-workspace");
  return job;
}

async function pointerFor(workspace: AuthorizedWorkspace, experienceId: string) {
  const rows = await workspace.tx<{ version_id: string }[]>`
    select version_id::text from experience_current_drafts
    where workspace_id = ${workspace.workspaceId}::uuid and experience_id = ${experienceId}::uuid
    for update
  `;
  return rows[0]?.version_id ?? null;
}

async function currentVersion(workspace: AuthorizedWorkspace, experienceId: string, baseVersionId: string, parentVersionId: string | null) {
  const pointer = await workspace.tx<{ version_id: string }[]>`
    select version_id::text from experience_current_drafts
    where workspace_id = ${workspace.workspaceId}::uuid and experience_id = ${experienceId}::uuid
  `;
  if (pointer[0]?.version_id) return pointer[0].version_id;
  if (!parentVersionId) return baseVersionId;
  const root = await workspace.tx<{ id: string }[]>`
    select id::text from experience_versions
    where workspace_id = ${workspace.workspaceId}::uuid and experience_id = ${experienceId}::uuid and parent_version_id is null
    order by created_at asc
    limit 1
  `;
  return root[0]?.id ?? baseVersionId;
}

async function failJob(workspace: AuthorizedWorkspace, jobId: string, code: SourceErrorCode) {
  const failureCode = /^[a-z0-9-]{1,80}$/.test(code) ? code : "invalid-experience";
  await workspace.tx`
    update experience_edit_jobs
    set status = 'failed', permanent = true, failure_code = ${failureCode}, lease_owner = null, lease_expires_at = null, updated_at = now()
    where id = ${jobId}::uuid and workspace_id = ${workspace.workspaceId}::uuid and status <> 'ready'
  `;
  const costs = await workspace.tx<{ total: number }[]>`
    select count(*)::int as total from experience_edit_costs where edit_job_id = ${jobId}::uuid
  `;
  if (Number(costs[0]?.total ?? 0) === 0) await recordCost(workspace, jobId);
  await recordEvent(workspace, jobId, "failed", "The edit did not become a revision.");
}

async function recordCost(workspace: AuthorizedWorkspace, jobId: string, usage: EditUsage = FIXTURE_USAGE) {
  await workspace.tx`
    insert into experience_edit_costs (
      id, workspace_id, edit_job_id, provider, model, pricing_version, input_tokens, cached_input_tokens, output_tokens,
      reasoning_tokens, call_count, retry_count, estimated_cost_micros, actual_cost_micros, currency, usage_kind,
      provider_response_id, execution_mode, commercial_estimate_micros, latency_ms, remaining_requests, remaining_tokens, created_by
    ) values (
      ${randomUUID()}::uuid, ${workspace.workspaceId}::uuid, ${jobId}::uuid, ${usage.provider}, ${usage.model},
      ${usage.priceVersion}, ${usage.inputTokens}, ${usage.cachedInputTokens}, ${usage.outputTokens}, ${usage.reasoningTokens},
      ${usage.callCount}, ${usage.retryCount}, ${usage.estimatedCostMicros}, ${usage.actualCostMicros}, 'USD', ${usage.usageKind},
      ${usage.responseId}, ${usage.executionMode}, ${usage.commercialEstimateMicros}, ${usage.latencyMs},
      ${usage.remainingRequests}, ${usage.remainingTokens}, ${workspace.userId}::uuid
    )
    on conflict (edit_job_id) do update set
      provider = excluded.provider,
      model = excluded.model,
      pricing_version = excluded.pricing_version,
      input_tokens = excluded.input_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      output_tokens = excluded.output_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      call_count = excluded.call_count,
      retry_count = excluded.retry_count,
      estimated_cost_micros = excluded.estimated_cost_micros,
      actual_cost_micros = excluded.actual_cost_micros,
      usage_kind = excluded.usage_kind,
      provider_response_id = excluded.provider_response_id,
      execution_mode = excluded.execution_mode,
      commercial_estimate_micros = excluded.commercial_estimate_micros,
      latency_ms = excluded.latency_ms,
      remaining_requests = excluded.remaining_requests,
      remaining_tokens = excluded.remaining_tokens
  `;
}

async function recordEvent(workspace: AuthorizedWorkspace, jobId: string, kind: "requested" | "ready" | "accepted" | "rejected" | "failed", summary: string) {
  const event = ExperienceEditAuditEventV1.safeParse({ contract: "EXPERIENCE-EDIT-AUDIT-v1", kind, summary });
  if (!event.success) throw new SourceError("invalid-edit");
  await workspace.tx`
    insert into experience_edit_events (id, workspace_id, edit_job_id, kind, summary, created_by)
    values (
      ${randomUUID()}::uuid, ${workspace.workspaceId}::uuid, ${jobId}::uuid, ${event.data.kind}, ${event.data.summary},
      ${workspace.userId}::uuid
    )
  `;
}

async function proposalFrom(workspace: AuthorizedWorkspace, job: ProposalRow, replayed: boolean): Promise<CreatorEditProposal> {
  const rows = await workspace.tx<{
    provider: string;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    call_count: number | null;
    estimated_cost_micros: number | null;
    actual_cost_micros: number | null;
    usage_kind: string | null;
  }[]>`
    select j.provider, c.model, c.input_tokens::int, c.output_tokens::int, c.call_count::int,
      c.estimated_cost_micros::int, c.actual_cost_micros::int, c.usage_kind
    from experience_edit_jobs j
    left join experience_edit_costs c on c.edit_job_id = j.id
    where j.id = ${job.id}::uuid and j.workspace_id = ${workspace.workspaceId}::uuid
  `;
  const row = rows[0];
  const callCount = Number(row?.call_count ?? 0);
  const kind = row?.usage_kind === "actual" || row?.usage_kind === "estimate" || row?.usage_kind === "none" ? row.usage_kind : "none";
  return {
    editJobId: job.id,
    status: "ready",
    baseVersionId: job.base_version_id,
    proposedVersionId: job.proposed_version_id ?? "",
    summary: job.summary ?? "A revised draft is ready to preview.",
    graphChanged: job.graph_changed === true,
    uncertainty: job.uncertainty,
    reviewNote: job.review_note,
    scenesTouched: job.scenes_touched ?? 0,
    choicesChanged: job.choices_changed ?? 0,
    previewPath: `/creator/preview/${job.proposed_version_id}`,
    liveModel: row?.provider === CONFIGURED_PROVIDER && callCount > 0,
    publicationStatus: "unpublished",
    provider: row?.provider === CONFIGURED_PROVIDER ? CONFIGURED_PROVIDER : FIXTURE_PROVIDER,
    usage: {
      kind,
      currency: "USD",
      actualCostMicros: Number(row?.actual_cost_micros ?? 0),
      estimatedCostMicros: Number(row?.estimated_cost_micros ?? 0),
      callCount,
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
    },
    replayed,
  };
}

async function produce(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  env?: ProviderEnv;
  fetchImpl?: typeof fetch;
  schedules?: Record<string, RateSchedule>;
}, run: Run) {
  if (run.provider !== CONFIGURED_PROVIDER) {
    return { outcome: runRevision(run.manifest, run.instruction, run.sceneId), usage: FIXTURE_USAGE, persistFailure: true };
  }
  const env = input.env ?? process.env;
  const screened = screenEditInstruction(run.manifest, run.instruction, run.sceneId ?? undefined);
  if (!screened.ok) return { outcome: screened, usage: quietUsage(), persistFailure: true };
  const auth = configuredEditAuthorization(env, input.schedules);
  if (!auth.ok) return { outcome: { ok: false as const, code: auth.code, alternatives: [] as string[] }, usage: quietUsage(), persistFailure: false };
  if ("mode" in auth) return produceFree(input, run, env, auth);
  const estimated = editCallEstimate(auth.spend);
  if (estimated === null || estimated > auth.spend.maxEditMicros || estimated > auth.spend.spendCapMicros) {
    return { outcome: { ok: false as const, code: "budget-unavailable" as const, alternatives: [] as string[] }, usage: quietUsage(), persistFailure: true };
  }
  const reserved = await withWorkspace(input.sql, input.identity, input.workspaceId, (workspace) => claimModelSlot(workspace, run.jobId, {
    ...quietUsage(),
    model: auth.spend.model,
    priceVersion: auth.spend.priceVersion,
    callCount: 1,
    estimatedCostMicros: estimated,
    usageKind: "estimate",
    executionMode: "paid-development",
  }, auth.spend.spendCapMicros));
  if (reserved.status !== "ok") {
    const code = reserved.status === "over-cap" ? "budget-unavailable" as const : "provider-unavailable" as const;
    return { outcome: { ok: false as const, code, alternatives: [] as string[] }, usage: quietUsage(), persistFailure: true };
  }
  let extraReserved = 0;
  const paid = await requestPaidEdit({
    env,
    systemText: EDIT_MODEL_INSTRUCTIONS,
    userText: editModelContext(run.manifest, run.instruction, run.sceneId ?? undefined),
    fetchImpl: input.fetchImpl,
    schedules: input.schedules,
    remainingAfterReserveMicros: auth.spend.spendCapMicros - reserved.reservedMicros,
    confirmRetry: async () => {
      const accepted = await withWorkspace(input.sql, input.identity, input.workspaceId, (workspace) => reserveAnotherEstimate(workspace, estimated, auth.spend.spendCapMicros));
      if (accepted) extraReserved += 1;
      return accepted;
    },
  });
  const reservedMicros = estimated * (1 + extraReserved);
  const keptMicros = paid.releaseReservation ? 0 : paid.usageKind === "actual" ? paid.actualCostMicros : reservedMicros;
  await withWorkspace(input.sql, input.identity, input.workspaceId, (workspace) => reconcileReservation(workspace, reservedMicros, keptMicros));
  const usage: EditUsage = {
    provider: CONFIGURED_PROVIDER,
    model: auth.spend.model,
    priceVersion: auth.spend.priceVersion,
    inputTokens: paid.inputTokens,
    cachedInputTokens: paid.cachedInputTokens,
    outputTokens: paid.outputTokens,
    reasoningTokens: paid.reasoningTokens,
    responseId: paid.responseId,
    callCount: Math.max(1, paid.callCount),
    retryCount: paid.retryCount,
    estimatedCostMicros: paid.estimatedCostMicros,
    actualCostMicros: paid.releaseReservation ? 0 : paid.usageKind === "actual" ? paid.actualCostMicros : reservedMicros,
    commercialEstimateMicros: null,
    usageKind: paid.usageKind,
    executionMode: "paid-development",
    latencyMs: paid.latencyMs,
    remainingRequests: paid.remainingRequests,
    remainingTokens: paid.remainingTokens,
  };
  if (!paid.ok || !paid.content) {
    const code = paid.code === "budget-unavailable" || paid.code === "invalid-experience" || paid.code === "provider-unavailable" || paid.code === "generation-unavailable" || paid.code === "unsupported-edit" ? paid.code : "provider-unavailable";
    return { outcome: { ok: false as const, code, alternatives: [] as string[] }, usage, persistFailure: true };
  }
  const outcome = applyModelOutput(run.manifest, run.instruction, paid.content, randomUUID(), run.sceneId ?? undefined);
  if (!outcome.ok && outcome.diagnostic) logEditDiagnostic(outcome.diagnostic);
  return { outcome, usage, persistFailure: true };
}

async function produceFree(
  input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; fetchImpl?: typeof fetch },
  run: Run,
  env: ProviderEnv,
  auth: { model: string; priceVersion: string; sessionLimit: number; dayLimit: number },
) {
  const ceiling = Math.round((4_000 * GROQ_COMMERCIAL_SCHEDULE.inputMicrosPerMillion + 800 * GROQ_COMMERCIAL_SCHEDULE.outputMicrosPerMillion) / 1_000_000);
  const baseline = freeUsage(auth, ceiling);
  const kind = groqEditKind(run.instruction);
  const prepared = kind === "dialogue" ? prepareDialogueTarget(run.manifest, run.sceneId ?? undefined) : null;
  if (prepared && !prepared.ok) {
    logEditDiagnostic(prepared.diagnostic);
    return {
      outcome: { ok: false as const, code: "invalid-experience" as const, alternatives: [] as string[], diagnostic: prepared.diagnostic },
      usage: { ...baseline, callCount: 0, usageKind: "none" as const, commercialEstimateMicros: null },
      persistFailure: true,
    };
  }
  const reserved = await withWorkspace(input.sql, input.identity, input.workspaceId, (workspace) => claimFreeSlot(workspace, run.jobId, baseline, auth.sessionLimit, auth.dayLimit));
  if (reserved.status !== "ok") {
    const code = reserved.status === "exhausted" ? "budget-unavailable" as const : "provider-unavailable" as const;
    return {
      outcome: { ok: false as const, code, alternatives: [] as string[] },
      usage: { ...baseline, callCount: 0, usageKind: "none" as const, commercialEstimateMicros: null },
      persistFailure: true,
    };
  }
  const dialogue = prepared && prepared.ok ? prepared.target : undefined;
  const paid = await requestPaidEdit({
    env,
    systemText: kind === "graph" ? GROQ_GRAPH_INSTRUCTIONS : GROQ_DIALOGUE_INSTRUCTIONS,
    userText: dialogue ? dialogueEditContext(run.instruction, dialogue, run.audience ?? undefined) : graphEditContext(run.manifest, run.instruction, run.audience ?? undefined),
    fetchImpl: input.fetchImpl,
    outputSchema: dialogue ? groqTransportSchema(dialogue.sceneId, dialogue.editableParts.length) : groqGraphTransportSchema(run.manifest),
    editMode: kind,
    dialogueTarget: dialogue,
    confirmRetry: () => withWorkspace(input.sql, input.identity, input.workspaceId, (workspace) => claimFreeRequest(workspace, auth.sessionLimit, auth.dayLimit)),
  });
  const usage: EditUsage = {
    ...baseline,
    inputTokens: paid.inputTokens,
    cachedInputTokens: paid.cachedInputTokens,
    outputTokens: paid.outputTokens,
    reasoningTokens: paid.reasoningTokens,
    responseId: paid.responseId,
    callCount: Math.max(1, paid.callCount),
    retryCount: paid.retryCount,
    estimatedCostMicros: 0,
    actualCostMicros: 0,
    commercialEstimateMicros: paid.commercialEstimateMicros,
    usageKind: paid.usageKind,
    latencyMs: paid.latencyMs,
    remainingRequests: paid.remainingRequests,
    remainingTokens: paid.remainingTokens,
  };
  if (!paid.ok || !paid.content) {
    const code = paid.code === "budget-unavailable" || paid.code === "invalid-experience" || paid.code === "provider-unavailable" || paid.code === "generation-unavailable" || paid.code === "unsupported-edit" ? paid.code : "provider-unavailable";
    if (paid.diagnostic) logEditDiagnostic(paid.diagnostic);
    return { outcome: { ok: false as const, code, alternatives: [] as string[] }, usage, persistFailure: true };
  }
  const outcome = applyModelOutput(run.manifest, run.instruction, paid.content, randomUUID(), run.sceneId ?? undefined);
  if (!outcome.ok && outcome.diagnostic) logEditDiagnostic(outcome.diagnostic);
  return { outcome, usage, persistFailure: true };
}

function freeUsage(auth: { model: string; priceVersion: string }, ceiling: number): EditUsage {
  return {
    ...FIXTURE_USAGE,
    provider: CONFIGURED_PROVIDER,
    model: auth.model,
    priceVersion: auth.priceVersion,
    callCount: 1,
    commercialEstimateMicros: ceiling,
    usageKind: "estimate",
    executionMode: "free-development",
  };
}

function quietUsage(): EditUsage {
  return { ...FIXTURE_USAGE, provider: CONFIGURED_PROVIDER, priceVersion: "unconfigured" };
}

async function claimFreeSlot(workspace: AuthorizedWorkspace, jobId: string, usage: EditUsage, sessionLimit: number, dayLimit: number) {
  const locked = await workspace.tx<{ session_id: string; session_requests: number; day_requests: number; usage_day: string }[]>`
    select session_id, session_requests::int, day_requests::int, to_char(usage_day, 'YYYY-MM-DD') as usage_day
    from adeena_free_quota where id = 'development' for update
  `;
  const existing = await workspace.tx<{ call_count: number }[]>`
    select call_count::int from experience_edit_costs where edit_job_id = ${jobId}::uuid
  `;
  if (Number(existing[0]?.call_count ?? 0) >= 1) return { status: "duplicate" as const };
  const allowed = await claimFreeRequest(workspace, sessionLimit, dayLimit, locked[0]);
  if (!allowed) return { status: "exhausted" as const };
  try {
    await insertCost(workspace, jobId, usage);
  } catch (error) {
    if (postgresCode(error) === "23505") return { status: "duplicate" as const };
    throw error;
  }
  return { status: "ok" as const };
}

async function claimFreeRequest(
  workspace: AuthorizedWorkspace,
  sessionLimit: number,
  dayLimit: number,
  locked?: { session_id: string; session_requests: number; day_requests: number; usage_day: string },
) {
  const row = locked ?? (await workspace.tx<{ session_id: string; session_requests: number; day_requests: number; usage_day: string }[]>`
    select session_id, session_requests::int, day_requests::int, to_char(usage_day, 'YYYY-MM-DD') as usage_day
    from adeena_free_quota where id = 'development' for update
  `)[0];
  if (!row) return false;
  const todayRows = await workspace.tx<{ day: string }[]>`select to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD') as day`;
  const today = todayRows[0]?.day ?? "";
  let sessionRequests = row.session_id === FREE_SESSION_ID ? Number(row.session_requests) : 0;
  let dayRequests = row.usage_day === today ? Number(row.day_requests) : 0;
  if (sessionRequests + 1 > sessionLimit || dayRequests + 1 > dayLimit) return false;
  sessionRequests += 1;
  dayRequests += 1;
  await workspace.tx`
    update adeena_free_quota
    set session_id = ${FREE_SESSION_ID}, session_requests = ${sessionRequests}, day_requests = ${dayRequests},
      usage_day = ${today}::date, updated_at = now()
    where id = 'development'
  `;
  return true;
}

async function insertCost(workspace: AuthorizedWorkspace, jobId: string, usage: EditUsage) {
  await workspace.tx`
    insert into experience_edit_costs (
      id, workspace_id, edit_job_id, provider, model, pricing_version, input_tokens, cached_input_tokens, output_tokens,
      reasoning_tokens, call_count, retry_count, estimated_cost_micros, actual_cost_micros, currency, usage_kind,
      provider_response_id, execution_mode, commercial_estimate_micros, latency_ms, remaining_requests, remaining_tokens, created_by
    ) values (
      ${randomUUID()}::uuid, ${workspace.workspaceId}::uuid, ${jobId}::uuid, ${usage.provider}, ${usage.model},
      ${usage.priceVersion}, ${usage.inputTokens}, ${usage.cachedInputTokens}, ${usage.outputTokens}, ${usage.reasoningTokens},
      ${usage.callCount}, ${usage.retryCount}, ${usage.estimatedCostMicros}, ${usage.actualCostMicros}, 'USD', ${usage.usageKind},
      ${usage.responseId}, ${usage.executionMode}, ${usage.commercialEstimateMicros}, ${usage.latencyMs},
      ${usage.remainingRequests}, ${usage.remainingTokens}, ${workspace.userId}::uuid
    )
  `;
}

async function claimModelSlot(workspace: AuthorizedWorkspace, jobId: string, usage: EditUsage, spendCapMicros: number) {
  const existing = await workspace.tx<{ call_count: number }[]>`
    select call_count::int from experience_edit_costs where edit_job_id = ${jobId}::uuid
  `;
  if (Number(existing[0]?.call_count ?? 0) >= 1) return { status: "duplicate" as const };
  const locked = await workspace.tx<{ reserved_micros: number }[]>`
    select reserved_micros::int from adeena_edit_spend where id = 'development' for update
  `;
  const reserved = locked[0] ? Number(locked[0].reserved_micros) : null;
  if (reserved === null || reserved + usage.estimatedCostMicros > spendCapMicros) return { status: "over-cap" as const };
  try {
    await workspace.tx`
      insert into experience_edit_costs (
        id, workspace_id, edit_job_id, provider, model, pricing_version, input_tokens, cached_input_tokens, output_tokens,
        reasoning_tokens, call_count, retry_count, estimated_cost_micros, actual_cost_micros, currency, usage_kind,
        provider_response_id, execution_mode, commercial_estimate_micros, latency_ms, remaining_requests, remaining_tokens, created_by
      ) values (
        ${randomUUID()}::uuid, ${workspace.workspaceId}::uuid, ${jobId}::uuid, ${usage.provider}, ${usage.model},
        ${usage.priceVersion}, ${usage.inputTokens}, ${usage.cachedInputTokens}, ${usage.outputTokens}, ${usage.reasoningTokens},
        ${usage.callCount}, ${usage.retryCount}, ${usage.estimatedCostMicros}, ${usage.actualCostMicros}, 'USD', ${usage.usageKind},
        ${usage.responseId}, ${usage.executionMode}, ${usage.commercialEstimateMicros}, ${usage.latencyMs},
        ${usage.remainingRequests}, ${usage.remainingTokens}, ${workspace.userId}::uuid
      )
    `;
  } catch (error) {
    if (postgresCode(error) === "23505") return { status: "duplicate" as const };
    throw error;
  }
  const updated = await workspace.tx<{ reserved_micros: number }[]>`
    update adeena_edit_spend
    set reserved_micros = reserved_micros + ${usage.estimatedCostMicros}, updated_at = now()
    where id = 'development'
    returning reserved_micros::int
  `;
  return { status: "ok" as const, reservedMicros: Number(updated[0]?.reserved_micros ?? reserved + usage.estimatedCostMicros) };
}

async function reserveAnotherEstimate(workspace: AuthorizedWorkspace, estimatedMicros: number, spendCapMicros: number) {
  const locked = await workspace.tx<{ reserved_micros: number }[]>`
    select reserved_micros::int from adeena_edit_spend where id = 'development' for update
  `;
  const reserved = locked[0] ? Number(locked[0].reserved_micros) : null;
  if (reserved === null || reserved + estimatedMicros > spendCapMicros) return false;
  await workspace.tx`
    update adeena_edit_spend
    set reserved_micros = reserved_micros + ${estimatedMicros}, updated_at = now()
    where id = 'development'
  `;
  return true;
}

async function reconcileReservation(workspace: AuthorizedWorkspace, reservedMicros: number, keptMicros: number) {
  const delta = keptMicros - reservedMicros;
  await workspace.tx`select reserved_micros from adeena_edit_spend where id = 'development' for update`;
  await workspace.tx`
    update adeena_edit_spend
    set reserved_micros = greatest(0, reserved_micros + ${delta}), updated_at = now()
    where id = 'development'
  `;
}

function accepted(versionId: string, replayed: boolean): EditOutcome {
  return { kind: "accepted", currentVersionId: versionId, previewPath: `/creator/preview/${versionId}`, replayed };
}

function discarded(versionId: string, replayed: boolean): EditOutcome {
  return { kind: "discarded", currentVersionId: versionId, previewPath: `/creator/preview/${versionId}`, replayed };
}

function stopped(code: string | null, alternatives: string[] = []): EditOutcome {
  const known = code && (SOURCE_ERROR_CODES as readonly string[]).includes(code) ? code as SourceErrorCode : "invalid-experience";
  const extra = known === "unsupported-edit" || known === "review-required" ? [...EDIT_ALTERNATIVES] : [];
  return { kind: "stop", code: known, alternatives: alternatives.length > 0 ? alternatives : extra };
}

function publicTitle(value: string | null) {
  if (!value || /<script|javascript:|private:\/\/|https?:\/\//i.test(value)) return "Private draft";
  return value.slice(0, 120);
}

function runRevision(manifest: ExperienceManifest, instruction: string, sceneId: string | null) {
  try {
    return reviseManifest(manifest, instruction, sceneId ?? undefined, randomUUID());
  } catch {
    return { ok: false as const, code: "invalid-experience" as const, alternatives: [] };
  }
}

function postgresCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

function rethrow(error: unknown): never {
  if (error instanceof SourceError) throw error;
  const failure = databaseFailure(error);
  if (/row-level security/i.test(failure.message)) throw new SourceError("cross-workspace");
  throw failure;
}
