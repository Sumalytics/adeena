import type { Sql } from "postgres";
import { z } from "zod";
import { Uuid } from "@/contracts/common";
import { ensureIndividualWorkspace } from "@/db/creator";
import {
  acceptExperienceEdit,
  listExperienceRevisions,
  proposeExperienceEdit,
  rejectExperienceEdit,
  resumeExperienceEdit,
  type EditOutcome,
} from "@/db/edit-repository";
import { EDIT_POLICY_VERSION } from "@/experience/edit";
import { CONFIGURED_PROVIDER, FIXTURE_PROVIDER, closedProviderError, configuredEditAuthorization, selectGenerationProvider, type ProviderEnv } from "@/experience/provider";
import { SourceError, type SourceErrorCode } from "@/source/errors";
import { creatorDatabase } from "./database";
import type { CreatorSession } from "./subject";

const SceneId = z.string().trim().regex(/^[a-z][a-z0-9-]{0,40}$/);

const EditBody = z.object({
  baseVersionId: Uuid,
  expectedBaseVersionId: Uuid,
  instruction: z.string().trim().min(1).max(500),
  sceneId: SceneId.optional(),
  idempotencyKey: Uuid,
  editPolicyVersion: z.literal(EDIT_POLICY_VERSION),
  authorizeEdit: z.literal(true),
}).strict();

const AcceptBody = z.object({
  editJobId: Uuid,
  expectedBaseVersionId: Uuid,
}).strict();

const JobBody = z.object({ editJobId: Uuid }).strict();

function statusFor(code: SourceErrorCode) {
  if (code === "unauthenticated") return 401;
  if (code === "invalid-edit") return 400;
  if (code === "stale-version") return 409;
  if (code === "job-limit") return 429;
  if (code === "unsupported-edit" || code === "invalid-experience") return 422;
  if (code === "generation-unavailable" || code === "provider-unavailable") return 503;
  return 403;
}

function failure(error: unknown) {
  if (!(error instanceof SourceError)) throw error;
  return { status: statusFor(error.code), body: { error: error.code } };
}

function fromOutcome(outcome: EditOutcome) {
  if (outcome.kind === "stop") {
    return {
      status: statusFor(outcome.code),
      body: outcome.alternatives.length > 0 ? { error: outcome.code, alternatives: outcome.alternatives } : { error: outcome.code },
    };
  }
  if (outcome.kind === "pending") return { status: 202 as const, body: { editJobId: outcome.editJobId, status: "planning" as const } };
  if (outcome.kind === "ready") return { status: outcome.proposal.replayed ? 200 as const : 201 as const, body: outcome.proposal };
  return { status: 200 as const, body: outcome };
}

function closed(env: ProviderEnv) {
  const code = closedProviderError(env);
  return { status: code === "generation-unavailable" ? 503 as const : 403 as const, body: { error: code } };
}

function selectedProvider(provider: typeof FIXTURE_PROVIDER | typeof CONFIGURED_PROVIDER | undefined, env: ProviderEnv) {
  return provider ?? selectGenerationProvider(env);
}

export async function creatorEditResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  body: unknown;
  provider?: typeof FIXTURE_PROVIDER | typeof CONFIGURED_PROVIDER;
  env?: ProviderEnv;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  const body = EditBody.safeParse(input.body);
  if (!body.success) return { status: 400 as const, body: { error: "invalid-edit" } };
  const env = input.env ?? process.env;
  const provider = selectedProvider(input.provider, env);
  if (provider === "closed") return closed(env);
  if (provider === CONFIGURED_PROVIDER) {
    const authorized = configuredEditAuthorization(env);
    if (!authorized.ok) return { status: authorized.code === "generation-unavailable" ? 503 as const : 403 as const, body: { error: authorized.code } };
  }
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    const outcome = await proposeExperienceEdit({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      baseVersionId: body.data.baseVersionId,
      expectedBaseVersionId: body.data.expectedBaseVersionId,
      instruction: body.data.instruction,
      sceneId: body.data.sceneId,
      idempotencyKey: body.data.idempotencyKey,
      authorizeEdit: true,
      provider,
      env,
    });
    return fromOutcome(outcome);
  } catch (error) {
    return failure(error);
  }
}

export async function creatorEditAcceptResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  body: unknown;
  provider?: typeof FIXTURE_PROVIDER | typeof CONFIGURED_PROVIDER;
  env?: ProviderEnv;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  const body = AcceptBody.safeParse(input.body);
  if (!body.success) return { status: 400 as const, body: { error: "invalid-edit" } };
  const provider = selectedProvider(input.provider, input.env ?? process.env);
  if (provider === "closed") return closed(input.env ?? process.env);
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    const outcome = await acceptExperienceEdit({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      editJobId: body.data.editJobId,
      expectedBaseVersionId: body.data.expectedBaseVersionId,
    });
    return fromOutcome(outcome);
  } catch (error) {
    return failure(error);
  }
}

export async function creatorEditRejectResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  body: unknown;
  provider?: typeof FIXTURE_PROVIDER | typeof CONFIGURED_PROVIDER;
  env?: ProviderEnv;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  const body = JobBody.safeParse(input.body);
  if (!body.success) return { status: 400 as const, body: { error: "invalid-edit" } };
  const provider = selectedProvider(input.provider, input.env ?? process.env);
  if (provider === "closed") return closed(input.env ?? process.env);
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    const outcome = await rejectExperienceEdit({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      editJobId: body.data.editJobId,
    });
    return fromOutcome(outcome);
  } catch (error) {
    return failure(error);
  }
}

export async function creatorEditContinueResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  body: unknown;
  provider?: typeof FIXTURE_PROVIDER | typeof CONFIGURED_PROVIDER;
  env?: ProviderEnv;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  const body = JobBody.safeParse(input.body);
  if (!body.success) return { status: 400 as const, body: { error: "invalid-edit" } };
  const env = input.env ?? process.env;
  const provider = selectedProvider(input.provider, env);
  if (provider === "closed") return closed(env);
  if (provider === CONFIGURED_PROVIDER) {
    const authorized = configuredEditAuthorization(env);
    if (!authorized.ok) return { status: authorized.code === "generation-unavailable" ? 503 as const : 403 as const, body: { error: authorized.code } };
  }
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    const outcome = await resumeExperienceEdit({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      editJobId: body.data.editJobId,
      env,
    });
    return fromOutcome(outcome);
  } catch (error) {
    return failure(error);
  }
}

export async function readCreatorHistory(identity: Parameters<typeof listExperienceRevisions>[1], versionId: string) {
  const workspace = await ensureIndividualWorkspace(creatorDatabase(), identity);
  return listExperienceRevisions(creatorDatabase(), identity, workspace.workspaceId, versionId);
}
