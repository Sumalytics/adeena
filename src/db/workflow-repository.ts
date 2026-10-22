import { randomUUID } from "node:crypto";
import type { PendingQuery, Row, Sql } from "postgres";
import { AUDIENCE_OPTIONS, type AudienceOption } from "@/app/studio/studio-form";
import { AgeBand, Uuid } from "@/contracts/common";
import { SourceError } from "@/source/errors";
import { withWorkspace } from "./authz";
import type { VerifiedIdentity } from "./identity";

export type CreatorWorkflow = {
  id: string;
  workspaceId: string;
  version: number;
  documentVersionId: string | null;
  audienceLabel: AudienceOption | null;
  ageBand: AgeBand | null;
  recommendationRunId: string | null;
  recommendationIdempotencyKey: string | null;
  selectedTopicCandidateId: string | null;
  generationIdempotencyKey: string | null;
  generationJobId: string | null;
  experienceVersionId: string | null;
};

type WorkflowRow = {
  id: string;
  workspace_id: string;
  version: number;
  document_version_id: string | null;
  audience_label: string | null;
  age_band: string | null;
  recommendation_run_id: string | null;
  recommendation_idempotency_key: string | null;
  selected_topic_candidate_id: string | null;
  generation_idempotency_key: string | null;
  generation_job_id: string | null;
  experience_version_id: string | null;
};

type Selection = {
  documentVersionId: string | null;
  audienceLabel: string | null;
  ageBand: string | null;
  recommendationRunId: string | null;
  recommendationIdempotencyKey: string | null;
  selectedTopicCandidateId: string | null;
};

function present(row: WorkflowRow): CreatorWorkflow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    version: Number(row.version),
    documentVersionId: row.document_version_id,
    audienceLabel: row.audience_label === null ? null : audienceOption(row.audience_label),
    ageBand: row.age_band === null ? null : ageBand(row.age_band),
    recommendationRunId: row.recommendation_run_id,
    recommendationIdempotencyKey: row.recommendation_idempotency_key,
    selectedTopicCandidateId: row.selected_topic_candidate_id,
    generationIdempotencyKey: row.generation_idempotency_key,
    generationJobId: row.generation_job_id,
    experienceVersionId: row.experience_version_id,
  };
}

function audienceOption(value: string): AudienceOption {
  if ((AUDIENCE_OPTIONS as readonly string[]).includes(value)) return value as AudienceOption;
  throw new SourceError("invalid-workflow");
}

function ageBand(value: string): AgeBand {
  const parsed = AgeBand.safeParse(value);
  if (!parsed.success) throw new SourceError("invalid-workflow");
  return parsed.data;
}

function requireUuid(value: string) {
  if (!Uuid.safeParse(value).success) throw new SourceError("invalid-workflow");
}

function postgresCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

async function readRows(tx: Sql, where: PendingQuery<Row[]>): Promise<WorkflowRow[]> {
  return tx<WorkflowRow[]>`
    select id::text, workspace_id::text, version,
      document_version_id::text, audience_label, age_band,
      recommendation_run_id::text, recommendation_idempotency_key::text,
      selected_topic_candidate_id::text, generation_idempotency_key::text,
      generation_job_id::text, experience_version_id::text
    ${where}
  `;
}

export async function createCreatorWorkflow(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  idempotencyKey: string;
}) {
  requireUuid(input.idempotencyKey);
  return withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
    const id = randomUUID();
    const inserted = await workspace.tx<WorkflowRow[]>`
      insert into creator_workflows (id, workspace_id, created_by, idempotency_key)
      values (${id}::uuid, ${workspace.workspaceId}::uuid, ${workspace.userId}::uuid, ${input.idempotencyKey}::uuid)
      on conflict (workspace_id, idempotency_key) do nothing
      returning id::text, workspace_id::text, version,
        document_version_id::text, audience_label, age_band,
        recommendation_run_id::text, recommendation_idempotency_key::text,
        selected_topic_candidate_id::text, generation_idempotency_key::text,
        generation_job_id::text, experience_version_id::text
    `;
    if (inserted[0]) return present(inserted[0]);
    const existing = await readRows(workspace.tx, workspace.tx`
      from creator_workflows
      where workspace_id = ${workspace.workspaceId}::uuid and idempotency_key = ${input.idempotencyKey}::uuid
    `);
    const row = existing[0];
    if (!row) throw new SourceError("invalid-workflow");
    return present(row);
  });
}

export async function listCreatorWorkflows(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
}) {
  return withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
    const rows = await readRows(workspace.tx, workspace.tx`
      from creator_workflows
      where workspace_id = ${workspace.workspaceId}::uuid
      order by updated_at desc, id
    `);
    return rows.map(present);
  });
}

export async function readCreatorWorkflow(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  workflowId: string;
}) {
  requireUuid(input.workflowId);
  return withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
    const rows = await readRows(workspace.tx, workspace.tx`
      from creator_workflows
      where id = ${input.workflowId}::uuid and workspace_id = ${workspace.workspaceId}::uuid
    `);
    const row = rows[0];
    if (!row) throw new SourceError("cross-workspace");
    return present(row);
  });
}

export async function selectWorkflowSource(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  workflowId: string;
  expectedVersion: number;
  documentVersionId: string;
}) {
  requireUuid(input.workflowId);
  requireUuid(input.documentVersionId);
  return updateWorkflow(input, async (row, tx) => {
    await assertSource(tx, input.workspaceId, input.documentVersionId);
    const same = row.document_version_id === input.documentVersionId;
    return {
      documentVersionId: input.documentVersionId,
      audienceLabel: row.audience_label,
      ageBand: row.age_band,
      recommendationRunId: same ? row.recommendation_run_id : null,
      recommendationIdempotencyKey: same ? row.recommendation_idempotency_key : null,
      selectedTopicCandidateId: same ? row.selected_topic_candidate_id : null,
    };
  });
}

export async function selectWorkflowAudience(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  workflowId: string;
  expectedVersion: number;
  audienceLabel: string;
  ageBand: string;
}) {
  requireUuid(input.workflowId);
  const audience = audienceOption(input.audienceLabel);
  const age = ageBand(input.ageBand);
  return updateWorkflow(input, async (row) => {
    if (!row.document_version_id) throw new SourceError("invalid-workflow");
    const changed = row.audience_label !== audience || row.age_band !== age;
    return {
      documentVersionId: row.document_version_id,
      audienceLabel: audience,
      ageBand: age,
      recommendationRunId: changed ? null : row.recommendation_run_id,
      recommendationIdempotencyKey: changed ? null : row.recommendation_idempotency_key,
      selectedTopicCandidateId: changed ? null : row.selected_topic_candidate_id,
    };
  });
}

export async function selectWorkflowTopic(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  workflowId: string;
  expectedVersion: number;
  topicCandidateId: string;
}) {
  requireUuid(input.workflowId);
  requireUuid(input.topicCandidateId);
  return updateWorkflow(input, async (row, tx) => {
    if (!row.document_version_id) throw new SourceError("invalid-workflow");
    const topic = await tx<{ document_version_id: string }[]>`
      select document_version_id::text
      from topic_candidates
      where id = ${input.topicCandidateId}::uuid and workspace_id = ${input.workspaceId}::uuid
    `;
    const match = topic[0];
    if (!match) throw new SourceError("cross-workspace");
    if (match.document_version_id !== row.document_version_id) throw new SourceError("invalid-workflow");
    return {
      documentVersionId: row.document_version_id,
      audienceLabel: row.audience_label,
      ageBand: row.age_band,
      recommendationRunId: row.recommendation_run_id,
      recommendationIdempotencyKey: row.recommendation_idempotency_key,
      selectedTopicCandidateId: input.topicCandidateId,
    };
  });
}

async function assertSource(tx: Sql, workspaceId: string, documentVersionId: string) {
  const rows = await tx<{ id: string }[]>`
    select id::text from source_document_versions
    where id = ${documentVersionId}::uuid and workspace_id = ${workspaceId}::uuid
  `;
  if (!rows[0]) throw new SourceError("cross-workspace");
}

async function updateWorkflow(
  input: {
    sql: Sql;
    identity: VerifiedIdentity;
    workspaceId: string;
    workflowId: string;
    expectedVersion: number;
  },
  next: (row: WorkflowRow, tx: Sql) => Promise<Selection>,
) {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new SourceError("stale-workflow");
  try {
    return await withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
      const locked = await workspace.tx<WorkflowRow[]>`
        select id::text, workspace_id::text, version,
          document_version_id::text, audience_label, age_band,
          recommendation_run_id::text, recommendation_idempotency_key::text,
          selected_topic_candidate_id::text, generation_idempotency_key::text,
          generation_job_id::text, experience_version_id::text
        from creator_workflows
        where id = ${input.workflowId}::uuid and workspace_id = ${workspace.workspaceId}::uuid
        for update
      `;
      const row = locked[0];
      if (!row) throw new SourceError("cross-workspace");
      if (Number(row.version) !== input.expectedVersion) throw new SourceError("stale-workflow");
      if (row.generation_idempotency_key || row.generation_job_id) throw new SourceError("invalid-workflow");
      const value = await next(row, workspace.tx);
      const updated = await workspace.tx<WorkflowRow[]>`
        update creator_workflows
        set document_version_id = ${value.documentVersionId}::uuid,
            audience_label = ${value.audienceLabel},
            age_band = ${value.ageBand},
            recommendation_run_id = ${value.recommendationRunId}::uuid,
            recommendation_idempotency_key = ${value.recommendationIdempotencyKey}::uuid,
            selected_topic_candidate_id = ${value.selectedTopicCandidateId}::uuid,
            version = version + 1
        where id = ${input.workflowId}::uuid
          and workspace_id = ${workspace.workspaceId}::uuid
          and version = ${input.expectedVersion}
          and generation_idempotency_key is null
          and generation_job_id is null
        returning id::text, workspace_id::text, version,
          document_version_id::text, audience_label, age_band,
          recommendation_run_id::text, recommendation_idempotency_key::text,
          selected_topic_candidate_id::text, generation_idempotency_key::text,
          generation_job_id::text, experience_version_id::text
      `;
      const saved = updated[0];
      if (!saved) throw new SourceError("stale-workflow");
      return present(saved);
    });
  } catch (error) {
    if (error instanceof SourceError) throw error;
    const code = postgresCode(error);
    if (code === "23514" || code === "23503") throw new SourceError("invalid-workflow");
    throw error;
  }
}
