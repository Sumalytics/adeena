import type { Sql } from "postgres";
import { z } from "zod";
import { AUDIENCE_OPTIONS } from "@/app/studio/studio-form";
import { AgeBand, Uuid } from "@/contracts/common";
import { ensureIndividualWorkspace } from "@/db/creator";
import { createPlayableExperience, readPlayableGeneration, resumePlayableExperience } from "@/db/experience-repository";
import { enqueueVisualGeneration, readVisualGeneration, type VisualGenerationView } from "@/db/visual-generation-repository";
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
import { FIXTURE_PROVIDER, CONFIGURED_PROVIDER, configuredEditAuthorization, closedProviderError, selectGenerationProvider, type ProviderEnv, type RateSchedule } from "@/experience/provider";
import type { CreatorExperienceView, CreatorGenerationJourney } from "@/experience/public";
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
  if (error.code === "insufficient-source" || error.code === "source-structure-required" || error.code === "invalid-experience" || error.code === "stale-extraction") {
    return { status: 422 as const, body: { error: error.code } };
  }
  if (error.code === "generation-unavailable" || error.code === "provider-unavailable") return { status: 503 as const, body: { error: error.code } };
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
    const base = await readPlayableGeneration({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      jobId: workflow.generationJobId,
      idempotencyKey: workflow.generationIdempotencyKey,
    });
    if (!base) return { status: 200 as const, body: { workflow, generation: null } };
    const visual = base.status === "ready" && base.experienceVersionId && base.provider === CONFIGURED_PROVIDER
      ? await readVisualGeneration({ sql: input.sql, identity: input.session.identity, workspaceId: workspace.workspaceId, experienceVersionId: base.experienceVersionId })
      : null;
    const generation = creatorGenerationJourney(base, visual);
    const recorded = generation.status === "ready" && generation.experienceVersionId && !workflow.experienceVersionId
      ? await recordWorkflowGeneration({ sql: input.sql, identity: input.session.identity, workspaceId: workspace.workspaceId, workflowId: input.workflowId, jobId: generation.jobId, experienceVersionId: generation.experienceVersionId })
      : workflow;
    return { status: 200 as const, body: { workflow: recorded, generation } };
  } catch (error) {
    return failure(error);
  }
}

export async function creatorWorkflowGenerateResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  workflowId: string;
  body: unknown;
  provider?: typeof FIXTURE_PROVIDER | typeof CONFIGURED_PROVIDER;
  env?: ProviderEnv;
  fetchImpl?: typeof fetch;
  schedules?: Record<string, RateSchedule>;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  if (!Uuid.safeParse(input.workflowId).success) return { status: 400 as const, body: { error: "invalid-workflow" } };
  const body = GenerateBody.safeParse(input.body);
  if (!body.success) return { status: 400 as const, body: { error: "invalid-workflow" } };
  const env = input.env ?? process.env;
  const provider = input.provider ?? selectGenerationProvider(env);
  if (provider !== FIXTURE_PROVIDER && (provider !== CONFIGURED_PROVIDER || !configuredEditAuthorization(env).ok)) {
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
      ? await resumePlayableExperience({ ...shared, jobId: reserved.generationJobId, env, fetchImpl: input.fetchImpl, schedules: input.schedules })
      : await createPlayableExperience({
        ...shared,
        documentVersionId: reserved.documentVersionId,
        topicCandidateId: reserved.selectedTopicCandidateId,
        audienceLabel: reserved.audienceLabel,
        ageBand: reserved.ageBand,
        idempotencyKey: reserved.generationIdempotencyKey,
        authorizeGeneration: true,
        provider, env, fetchImpl: input.fetchImpl, schedules: input.schedules,
      });
    for (let attempt = 0; attempt < 4 && view.status !== "ready" && view.status !== "failed" && view.status !== "cancelled"; attempt += 1) {
      view = await resumePlayableExperience({ ...shared, jobId: view.jobId, env, fetchImpl: input.fetchImpl, schedules: input.schedules });
    }
    let visual: VisualGenerationView | null = null;
    if (view.status === "ready" && view.experienceVersionId && provider === CONFIGURED_PROVIDER) {
      try {
        visual = await enqueueVisualGeneration({ ...shared, experienceVersionId: view.experienceVersionId, idempotencyKey: reserved.generationIdempotencyKey, env, schedules: input.schedules });
      } catch (error) {
        if (!(error instanceof SourceError)) throw error;
        visual = null;
      }
    }
    const generation = creatorGenerationJourney(view, visual);
    const recorded = await recordWorkflowGeneration({
      ...shared,
      workflowId: input.workflowId,
      jobId: view.jobId,
      experienceVersionId: generation.status === "ready" ? generation.experienceVersionId : null,
    });
    return { status: generation.status === "ready" ? 200 as const : 202 as const, body: { workflow: recorded, generation } };
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

export function creatorGenerationJourney(base: CreatorExperienceView, visual: VisualGenerationView | null): CreatorGenerationJourney {
  if (base.status !== "ready") return { ...base, visualStatus: "not-requested", stageLabel: base.status === "validating" ? "Checking the learning content" : "Creating your experience", visualMessage: null, legacyOnly: false };
  if (base.provider !== CONFIGURED_PROVIDER) return { ...base, visualStatus: "not-requested", stageLabel: "Ready to preview", visualMessage: "This development draft uses the deterministic game fixture. No AI-directed animation was generated.", legacyOnly: true };
  if (!visual) return { ...base, visualStatus: "failed", stageLabel: "Visual generation unavailable", visualMessage: "The animated explanation could not be prepared. The validated original playable draft remains available.", legacyOnly: true };
  if (visual.internalStatus === "queued" || visual.internalStatus === "planning") return { ...base, status: "compiling", previewPath: null, visualStatus: visual.internalStatus, stageLabel: "Preparing animated explanation", visualMessage: null, legacyOnly: false };
  if (visual.internalStatus === "reviewing") return { ...base, status: "validating", previewPath: null, visualStatus: "reviewing", stageLabel: "Checking the learning content", visualMessage: null, legacyOnly: false };
  if (visual.internalStatus === "ready") return { ...base, visualStatus: "ready", stageLabel: "Ready to preview", visualMessage: null, legacyOnly: false };
  if (visual.internalStatus === "unsupported") {
    const capability = visual.diagnostics?.find((item) => item.code === "required-capability")?.message;
    const treatment = capability === "timeline-sequence@1" ? "a timeline treatment" : capability === "spatial-regions@1" ? "a spatial-regions treatment" : "a visual treatment";
    return { ...base, visualStatus: "unsupported", stageLabel: "Visual generation unavailable", visualMessage: `This topic needs ${treatment} that the current player does not support yet. The validated original playable draft is available.`, legacyOnly: true };
  }
  if (visual.reason === "budget-unavailable") return { ...base, visualStatus: "failed", stageLabel: "Visual generation unavailable", visualMessage: "The authorized animation budget is too low for this bounded operation. The validated original playable draft is available.", legacyOnly: true };
  return { ...base, visualStatus: "failed", stageLabel: "Visual generation unavailable", visualMessage: "The animated explanation did not pass its source and learning checks. The validated original playable draft is available.", legacyOnly: true };
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
