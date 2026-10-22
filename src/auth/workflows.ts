import type { Sql } from "postgres";
import { z } from "zod";
import { AUDIENCE_OPTIONS } from "@/app/studio/studio-form";
import { AgeBand, Uuid } from "@/contracts/common";
import { ensureIndividualWorkspace } from "@/db/creator";
import { createPlayableExperience, readPlayableGeneration, resumePlayableExperience } from "@/db/experience-repository";
import type { VerifiedIdentity } from "@/db/identity";
import {
  createCreatorWorkflow,
  listCreatorWorkflows,
  readCreatorWorkflow,
  readWorkflowForExperience,
  recordWorkflowGeneration,
  releaseUnusedWorkflowGeneration,
  reserveWorkflowGeneration,
  resolveRecommendedWorkflowTopic,
  selectWorkflowAudience,
  selectWorkflowSource,
  selectWorkflowTopic,
} from "@/db/workflow-repository";
import { FIXTURE_PROVIDER, closedProviderError, selectGenerationProvider } from "@/experience/provider";
import { SourceError } from "@/source/errors";
import { creatorDatabase } from "./database";
import { requestOriginAllowed } from "./password-post";
import type { CreatorSession } from "./subject";

const CreateBody = z.object({ idempotencyKey: Uuid }).strict();

const ExpectedVersion = z.number().int().positive();

const UpdateBody = z.union([
  z.object({ expectedVersion: ExpectedVersion, documentVersionId: Uuid }).strict(),
  z.object({
    expectedVersion: ExpectedVersion,
    audienceLabel: z.enum(AUDIENCE_OPTIONS),
    ageBand: AgeBand,
  }).strict(),
  z.object({ expectedVersion: ExpectedVersion, topicCandidateId: Uuid }).strict(),
  z.object({ expectedVersion: ExpectedVersion, resolveRecommendedTopic: z.literal(true) }).strict(),
]);

function failure(error: unknown) {
  if (!(error instanceof SourceError)) throw error;
  if (error.code === "unauthenticated") return { status: 401 as const, body: { error: error.code } };
  if (error.code === "stale-workflow") return { status: 409 as const, body: { error: error.code } };
  if (error.code === "invalid-workflow") return { status: 400 as const, body: { error: error.code } };
  if (error.code === "stale-extraction") return { status: 422 as const, body: { error: error.code } };
  return { status: 403 as const, body: { error: error.code } };
}

export function rejectUntrustedWorkflowMutation(request: Request) {
  if (requestOriginAllowed(request)) return null;
  return Response.json({ error: "rejected" }, { status: 403 });
}

export async function listCreatorWorkflowRecords(identity: VerifiedIdentity, workspaceId: string) {
  return listCreatorWorkflows({ sql: creatorDatabase(), identity, workspaceId });
}

export async function readCreatorWorkflowRecord(identity: VerifiedIdentity, workspaceId: string, workflowId: string) {
  try {
    return await readCreatorWorkflow({ sql: creatorDatabase(), identity, workspaceId, workflowId });
  } catch (error) {
    if (error instanceof SourceError) return null;
    throw error;
  }
}

export async function creatorWorkflowListResponse(input: { session: CreatorSession | null; sql: Sql }) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    const workflows = await listCreatorWorkflows({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
    });
    return { status: 200 as const, body: { workflows } };
  } catch (error) {
    return failure(error);
  }
}

export async function creatorWorkflowCreateResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  body: unknown;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  const body = CreateBody.safeParse(input.body);
  if (!body.success) return { status: 400 as const, body: { error: "invalid-workflow" } };
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    const workflow = await createCreatorWorkflow({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      idempotencyKey: body.data.idempotencyKey,
    });
    return { status: 200 as const, body: workflow };
  } catch (error) {
    return failure(error);
  }
}

export async function creatorWorkflowReadResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  workflowId: string;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  if (!Uuid.safeParse(input.workflowId).success) return { status: 400 as const, body: { error: "invalid-workflow" } };
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    const workflow = await readCreatorWorkflow({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      workflowId: input.workflowId,
    });
    return { status: 200 as const, body: workflow };
  } catch (error) {
    return failure(error);
  }
}

export async function creatorWorkflowUpdateResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  workflowId: string;
  body: unknown;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  if (!Uuid.safeParse(input.workflowId).success) return { status: 400 as const, body: { error: "invalid-workflow" } };
  const body = UpdateBody.safeParse(input.body);
  if (!body.success) return { status: 400 as const, body: { error: "invalid-workflow" } };
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    const shared = {
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      workflowId: input.workflowId,
      expectedVersion: body.data.expectedVersion,
    };
    const workflow = "documentVersionId" in body.data
      ? await selectWorkflowSource({ ...shared, documentVersionId: body.data.documentVersionId })
      : "audienceLabel" in body.data
        ? await selectWorkflowAudience({
          ...shared,
          audienceLabel: body.data.audienceLabel,
          ageBand: body.data.ageBand,
        })
        : "topicCandidateId" in body.data
          ? await selectWorkflowTopic({ ...shared, topicCandidateId: body.data.topicCandidateId })
          : await resolveRecommendedWorkflowTopic(shared);
    return { status: 200 as const, body: workflow };
  } catch (error) {
    return failure(error);
  }
}

const GenerateBody = z.object({
  expectedVersion: ExpectedVersion,
  authorizeGeneration: z.literal(true),
}).strict();

function generateFailure(error: unknown) {
  if (!(error instanceof SourceError)) throw error;
  if (error.code === "stale-workflow") return { status: 409 as const, body: { error: error.code } };
  if (error.code === "invalid-workflow" || error.code === "invalid-generation") return { status: 400 as const, body: { error: error.code } };
  if (error.code === "unauthenticated") return { status: 401 as const, body: { error: error.code } };
  if (error.code === "insufficient-source" || error.code === "invalid-experience" || error.code === "stale-extraction") {
    return { status: 422 as const, body: { error: error.code } };
  }
  if (error.code === "generation-unavailable") return { status: 503 as const, body: { error: error.code } };
  return { status: 403 as const, body: { error: error.code } };
}

export async function creatorWorkflowGenerationReadResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  workflowId: string;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  if (!Uuid.safeParse(input.workflowId).success) return { status: 400 as const, body: { error: "invalid-workflow" } };
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    const workflow = await readCreatorWorkflow({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      workflowId: input.workflowId,
    });
    const generation = await readPlayableGeneration({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      jobId: workflow.generationJobId,
      idempotencyKey: workflow.generationIdempotencyKey,
    });
    return { status: 200 as const, body: { workflow, generation } };
  } catch (error) {
    return failure(error);
  }
}

export async function creatorWorkflowGenerateResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  workflowId: string;
  body: unknown;
  provider?: typeof FIXTURE_PROVIDER;
  env?: Record<string, string | undefined>;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  if (!Uuid.safeParse(input.workflowId).success) return { status: 400 as const, body: { error: "invalid-workflow" } };
  const body = GenerateBody.safeParse(input.body);
  if (!body.success) return { status: 400 as const, body: { error: "invalid-workflow" } };
  const env = input.env ?? process.env;
  const provider = input.provider ?? selectGenerationProvider(env);
  if (provider !== FIXTURE_PROVIDER) {
    const code = closedProviderError(env);
    return { status: code === "generation-unavailable" ? 503 as const : 403 as const, body: { error: code } };
  }
  let reserved: Awaited<ReturnType<typeof reserveWorkflowGeneration>> | null = null;
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    reserved = await reserveWorkflowGeneration({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      workflowId: input.workflowId,
      expectedVersion: body.data.expectedVersion,
    });
    if (!reserved.documentVersionId || !reserved.audienceLabel || !reserved.ageBand || !reserved.selectedTopicCandidateId || !reserved.generationIdempotencyKey) {
      throw new SourceError("invalid-workflow");
    }
    const shared = {
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
    };
    let view = reserved.generationJobId
      ? await resumePlayableExperience({ ...shared, jobId: reserved.generationJobId })
      : await createPlayableExperience({
        ...shared,
        documentVersionId: reserved.documentVersionId,
        topicCandidateId: reserved.selectedTopicCandidateId,
        audienceLabel: reserved.audienceLabel,
        ageBand: reserved.ageBand,
        idempotencyKey: reserved.generationIdempotencyKey,
        authorizeGeneration: true,
        provider,
      });
    for (let attempt = 0; attempt < 4 && view.status !== "ready" && view.status !== "failed" && view.status !== "cancelled"; attempt += 1) {
      view = await resumePlayableExperience({ ...shared, jobId: view.jobId });
    }
    const recorded = await recordWorkflowGeneration({
      ...shared,
      workflowId: input.workflowId,
      jobId: view.jobId,
      experienceVersionId: view.experienceVersionId,
    });
    return { status: view.status === "ready" ? 200 as const : 202 as const, body: { workflow: recorded, generation: view } };
  } catch (error) {
    if (error instanceof SourceError && reserved?.generationIdempotencyKey) {
      try {
        const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
        const existing = await readPlayableGeneration({
          sql: input.sql,
          identity: input.session.identity,
          workspaceId: workspace.workspaceId,
          idempotencyKey: reserved.generationIdempotencyKey,
        });
        if (existing) {
          const recorded = await recordWorkflowGeneration({
            sql: input.sql,
            identity: input.session.identity,
            workspaceId: workspace.workspaceId,
            workflowId: input.workflowId,
            jobId: existing.jobId,
            experienceVersionId: existing.experienceVersionId,
          });
          const failed = generateFailure(error);
          return { status: failed.status, body: { ...failed.body, workflow: recorded, generation: existing } };
        }
        const released = await releaseUnusedWorkflowGeneration({
          sql: input.sql,
          identity: input.session.identity,
          workspaceId: workspace.workspaceId,
          workflowId: input.workflowId,
        });
        const failed = generateFailure(error);
        return { status: failed.status, body: { ...failed.body, workflow: released } };
      } catch {
        return generateFailure(error);
      }
    }
    return generateFailure(error);
  }
}

export async function creatorWorkflowForPreview(identity: VerifiedIdentity, versionId: string, parentVersionId: string | null) {
  try {
    const workspace = await ensureIndividualWorkspace(creatorDatabase(), identity);
    return await readWorkflowForExperience({
      sql: creatorDatabase(),
      identity,
      workspaceId: workspace.workspaceId,
      versionId,
      parentVersionId,
    });
  } catch {
    return null;
  }
}
