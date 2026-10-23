import type { Sql } from "postgres";
import { z } from "zod";
import { AUDIENCE_OPTIONS } from "@/app/studio/studio-form";
import { AgeBand, Uuid } from "@/contracts/common";
import { ensureIndividualWorkspace } from "@/db/creator";
import { listExperienceRevisions } from "@/db/edit-repository";
import {
  createPlayableExperience,
  listPlayableDrafts,
  readPlayableExperience,
  resumePlayableExperience,
} from "@/db/experience-repository";
import type { CreatorDraftSummary } from "@/experience/public";
import { FIXTURE_PROVIDER, CONFIGURED_PROVIDER, configuredEditAuthorization, closedProviderError, selectGenerationProvider } from "@/experience/provider";
import { SourceError } from "@/source/errors";
import type { VerifiedIdentity } from "@/db/identity";
import { creatorDatabase } from "./database";
import type { CreatorSession } from "./subject";

const GenerateBody = z.object({
  documentVersionId: Uuid,
  topicCandidateId: Uuid,
  audienceLabel: z.enum(AUDIENCE_OPTIONS),
  ageBand: AgeBand,
  idempotencyKey: Uuid,
  authorizeGeneration: z.literal(true),
  compilerVersion: z.literal("1"),
}).strict();

const ContinueBody = z.object({ jobId: Uuid }).strict();

function failure(error: unknown) {
  if (!(error instanceof SourceError)) throw error;
  const status = error.code === "unauthenticated"
    ? 401
    : error.code === "invalid-generation"
      ? 400
      : error.code === "insufficient-source" || error.code === "invalid-experience" || error.code === "stale-extraction"
        ? 422
        : error.code === "generation-unavailable"
          ? 503
          : 403;
  return { status: status as 400 | 401 | 403 | 422 | 503, body: { error: error.code } };
}

export async function creatorExperienceResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  body: unknown;
  provider?: typeof FIXTURE_PROVIDER | typeof CONFIGURED_PROVIDER;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  const body = GenerateBody.safeParse(input.body);
  if (!body.success) return { status: 400 as const, body: { error: "invalid-generation" } };
  const provider = input.provider ?? selectGenerationProvider(process.env);
  if (provider !== FIXTURE_PROVIDER && (provider !== CONFIGURED_PROVIDER || !configuredEditAuthorization(process.env).ok)) {
    const code = provider === CONFIGURED_PROVIDER ? configuredEditAuthorization(process.env).code ?? "budget-unavailable" : closedProviderError(process.env);
    return { status: code === "generation-unavailable" ? 503 as const : 403 as const, body: { error: code } };
  }
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    const view = await createPlayableExperience({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      documentVersionId: body.data.documentVersionId,
      topicCandidateId: body.data.topicCandidateId,
      audienceLabel: body.data.audienceLabel,
      ageBand: body.data.ageBand,
      idempotencyKey: body.data.idempotencyKey,
      authorizeGeneration: true,
      provider,
    });
    if (view.status !== "ready") return { status: 202 as const, body: view };
    return { status: view.replayed ? 200 as const : 201 as const, body: view };
  } catch (error) {
    return failure(error);
  }
}

export async function creatorExperienceContinueResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  body: unknown;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  const body = ContinueBody.safeParse(input.body);
  if (!body.success) return { status: 400 as const, body: { error: "invalid-generation" } };
  if (selectGenerationProvider(process.env) !== FIXTURE_PROVIDER && !configuredEditAuthorization(process.env).ok) {
    const code = closedProviderError(process.env);
    return { status: code === "generation-unavailable" ? 503 as const : 403 as const, body: { error: code } };
  }
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    const view = await resumePlayableExperience({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      jobId: body.data.jobId,
    });
    if (view.status !== "ready") return { status: 202 as const, body: view };
    return { status: 200 as const, body: view };
  } catch (error) {
    return failure(error);
  }
}

export async function listCreatorDrafts(identity: VerifiedIdentity, workspaceId: string): Promise<CreatorDraftSummary[]> {
  try {
    return await listPlayableDrafts(creatorDatabase(), identity, workspaceId);
  } catch {
    return [];
  }
}

async function timedRead<T>(run: () => Promise<T>) {
  const started = Date.now();
  const value = await run();
  return { value, ms: Date.now() - started };
}

export async function readCreatorPreview(identity: VerifiedIdentity, versionId: string) {
  const started = Date.now();
  try {
    const workspace = await ensureIndividualWorkspace(creatorDatabase(), identity);
    const workspaceMs = Date.now() - started;
    const parallelStarted = Date.now();
    const [previewResult, historyResult] = await Promise.all([
      timedRead(() => readPlayableExperience(creatorDatabase(), identity, workspace.workspaceId, versionId)),
      timedRead(() => listExperienceRevisions(creatorDatabase(), identity, workspace.workspaceId, versionId)),
    ]);
    const preview = previewResult.value;
    const previewMs = previewResult.ms;
    const history = historyResult.value;
    const historyMs = historyResult.ms;
    const parallelMs = Date.now() - parallelStarted;
    const originalStarted = Date.now();
    const originalManifest = preview.parentVersionId && preview.edit?.status === "ready" && !preview.isCurrent
      ? (await readPlayableExperience(creatorDatabase(), identity, workspace.workspaceId, preview.parentVersionId)).manifest
      : null;
    const originalMs = Date.now() - originalStarted;
    return { ok: true as const, preview, history, originalManifest, timing: { workspaceMs, previewMs, historyMs, originalMs, parallelMs } };
  } catch (error) {
    const code = error instanceof SourceError ? error.code : "transient";
    return { ok: false as const, error: code, timing: { workspaceMs: Date.now() - started, previewMs: 0, historyMs: 0, originalMs: 0 } };
  }
}
