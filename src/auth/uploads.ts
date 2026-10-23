import { z } from "zod";
import type { Sql } from "postgres";
import { Uuid } from "@/contracts/common";
import { ensureIndividualWorkspace } from "@/db/creator";
import type { VerifiedIdentity } from "@/db/identity";
import { enqueueDurableSource, readVersionProcessing, recordSourcePermission, storeBlockedDocument } from "@/db/source-repository";
import { listExtractedSources } from "@/db/topic-repository";
import { runExtractionOnce } from "@/db/worker";
import { SourceError } from "@/source/errors";
import { classifyDocument } from "@/source/extract";
import { DEFAULT_SOURCE_LIMITS, sourceLimits, type SourceLimits } from "@/source/limits";
import type { PrivateObjectStore } from "@/storage/object-store";
import type { CreatorUploadView } from "@/topic/public";
import type { CreatorSession } from "./subject";
import { creatorObjectStore } from "./storage";

const LEASE_OWNER = "creator-request";
const FIELDS = new Set(["source", "rightsDeclaration", "idempotencyKey"]);
const RightsDeclaration = z.enum(["permission-asserted", "blocked"]);

const ContinueBody = z.object({ documentVersionId: Uuid }).strict();
const PermissionBody = z.object({ documentVersionId: Uuid, declaration: z.literal("permission-asserted") }).strict();

function failure(error: unknown) {
  if (!(error instanceof SourceError)) throw error;
  const status = error.code === "unauthenticated"
    ? 401
    : error.code === "oversized"
      ? 413
      : error.code === "job-limit"
        ? 429
        : error.code === "cross-workspace" || error.code === "rights-blocked"
          ? 403
          : 400;
  return { status: status as 400 | 401 | 403 | 413 | 429, body: { error: error.code } };
}

function issueCodes(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || !("code" in item)) return [];
    const code = item.code;
    return typeof code === "string" ? [code] : [];
  });
}

function present(
  row: Awaited<ReturnType<typeof readVersionProcessing>>,
  replayed: boolean,
): CreatorUploadView {
  const rights = row.version.rightsStatus;
  const jobStatus = row.job?.status;
  const outcome = row.cost?.operationStatus;
  const extractionStatus = row.result?.status === "complete" || row.result?.status === "partial" || row.result?.status === "failed"
    ? row.result.status
    : row.job
      ? "pending"
      : "not-queued";
  return {
    documentVersionId: row.version.id,
    filename: row.version.originalFilename,
    byteCount: row.version.sizeBytes,
    rightsStatus: rights === "cleared" || rights === "blocked" ? rights : "unverified",
    extractionStatus,
    jobStatus: jobStatus === "queued" || jobStatus === "processing" || jobStatus === "complete" || jobStatus === "partial" || jobStatus === "failed"
      ? jobStatus
      : null,
    failureCode: row.job?.failureCode ?? null,
    replayed,
    spanCount: row.spanCount,
    issueCodes: issueCodes(row.result?.diagnostics),
    cost: row.cost && (outcome === "complete" || outcome === "partial" || outcome === "failed")
      ? {
          uploadedBytes: row.cost.uploadedBytes,
          storedBytes: row.cost.storedBytes,
          processedPages: row.cost.processedPages,
          durationMs: row.cost.durationMs,
          outcome,
          aiGenerationAuthorized: false,
        }
      : null,
    generatesExperience: false,
    aiGenerationAuthorized: false,
  };
}

async function workspaceFor(sql: Sql, identity: VerifiedIdentity) {
  return ensureIndividualWorkspace(sql, identity);
}

async function readBoundedForm(request: Request, maxBodyBytes: number) {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBodyBytes) throw new SourceError("oversized");
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("multipart/form-data")) throw new SourceError("invalid-source");
  if (!request.body) throw new SourceError("empty-file");
  let total = 0;
  const stream = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBodyBytes) throw new SourceError("oversized");
      controller.enqueue(chunk);
    },
  }));
  const bounded = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  try {
    return await bounded.formData();
  } catch (error) {
    if (error instanceof SourceError) throw error;
    if (total > maxBodyBytes) throw new SourceError("oversized");
    throw new SourceError("invalid-source");
  }
}

async function acceptUpload(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  store: PrivateObjectStore;
  request: Request;
  limits?: Partial<SourceLimits>;
}) {
  const limits = sourceLimits(input.limits);
  const form = await readBoundedForm(input.request, limits.maxBytes + 65_536);
  for (const key of form.keys()) {
    if (!FIELDS.has(key)) throw new SourceError("invalid-source");
  }
  const declaration = RightsDeclaration.safeParse(form.get("rightsDeclaration"));
  const idempotencyKey = Uuid.safeParse(form.get("idempotencyKey"));
  const file = form.get("source");
  if (!declaration.success || !idempotencyKey.success || !(file instanceof File)) throw new SourceError("invalid-source");
  if (file.size === 0) throw new SourceError("empty-file");
  if (file.size > limits.maxBytes) throw new SourceError("oversized");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > limits.maxBytes) throw new SourceError("oversized");
  classifyDocument(file.name, bytes);
  const workspace = await workspaceFor(input.sql, input.identity);
  const shared = {
    sql: input.sql,
    identity: input.identity,
    workspaceId: workspace.workspaceId,
    filename: file.name,
    bytes,
    store: input.store,
    limits,
  };
  if (declaration.data === "blocked") {
    const stored = await storeBlockedDocument(shared);
    return { versionId: stored.version.id, workspaceId: workspace.workspaceId, replayed: stored.replayed };
  }
  const queued = await enqueueDurableSource({ ...shared, idempotencyKey: idempotencyKey.data });
  return { versionId: queued.version?.id ?? queued.job.documentVersionId, workspaceId: workspace.workspaceId, replayed: queued.replayed };
}

async function finish(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  versionId: string;
  store: PrivateObjectStore;
  replayed: boolean;
  limits?: Partial<SourceLimits>;
}) {
  const current = await readVersionProcessing(input.sql, input.identity, input.workspaceId, input.versionId);
  if (current.version.rightsStatus !== "blocked" && (current.job?.status === "queued" || current.job?.status === "processing")) {
    await runExtractionOnce({
      sql: input.sql,
      identity: input.identity,
      workspaceId: input.workspaceId,
      store: input.store,
      leaseOwner: LEASE_OWNER,
      limits: input.limits,
    });
  }
  const saved = await readVersionProcessing(input.sql, input.identity, input.workspaceId, input.versionId);
  const view = present(saved, input.replayed);
  if (JSON.stringify(view).includes("private://")) throw new SourceError("invalid-source");
  return view;
}

export async function creatorUploadResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  request: Request;
  store?: PrivateObjectStore;
  limits?: Partial<SourceLimits>;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  const store = input.store ?? creatorObjectStore();
  try {
    const accepted = await acceptUpload({
      sql: input.sql,
      identity: input.session.identity,
      store,
      request: input.request,
      limits: input.limits,
    });
    const view = await finish({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: accepted.workspaceId,
      versionId: accepted.versionId,
      store,
      replayed: accepted.replayed,
      limits: input.limits,
    });
    return { status: accepted.replayed ? 200 as const : 201 as const, body: view };
  } catch (error) {
    return failure(error);
  }
}

export async function creatorContinueResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  body: unknown;
  store?: PrivateObjectStore;
  limits?: Partial<SourceLimits>;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  const store = input.store ?? creatorObjectStore();
  const body = ContinueBody.safeParse(input.body);
  if (!body.success) return { status: 400 as const, body: { error: "invalid-source" } };
  try {
    const workspace = await workspaceFor(input.sql, input.session.identity);
    const view = await finish({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      versionId: body.data.documentVersionId,
      store,
      replayed: true,
      limits: input.limits,
    });
    return { status: 200 as const, body: view };
  } catch (error) {
    return failure(error);
  }
}

export async function creatorSourceResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  documentVersionId?: string | null;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  try {
    const workspace = await workspaceFor(input.sql, input.session.identity);
    const sources = await listExtractedSources(input.sql, input.session.identity, workspace.workspaceId);
    if (!input.documentVersionId) return { status: 200 as const, body: { sources, aiGenerationAuthorized: false as const } };
    const parsed = Uuid.safeParse(input.documentVersionId);
    if (!parsed.success) return { status: 400 as const, body: { error: "invalid-source" } };
    const match = sources.find((source) => source.documentVersionId === parsed.data);
    if (!match) return { status: 403 as const, body: { error: "cross-workspace" } };
    return { status: 200 as const, body: { source: match, aiGenerationAuthorized: false as const } };
  } catch (error) {
    return failure(error);
  }
}

export async function creatorSourcePermissionResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  body: unknown;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  const parsed = PermissionBody.safeParse(input.body);
  if (!parsed.success) return { status: 400 as const, body: { error: "invalid-source" } };
  try {
    const workspace = await workspaceFor(input.sql, input.session.identity);
    const recorded = await recordSourcePermission({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      documentVersionId: parsed.data.documentVersionId,
    });
    return { status: 200 as const, body: recorded };
  } catch (error) {
    return failure(error);
  }
}

export const UPLOAD_BODY_CEILING = DEFAULT_SOURCE_LIMITS.maxBytes + 65_536;
