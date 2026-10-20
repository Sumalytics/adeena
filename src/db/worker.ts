import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Sql } from "postgres";
import { SOURCE_MEDIA_TYPES } from "@/contracts/source";
import { extractDocument } from "@/source/extract";
import { SourceError } from "@/source/errors";
import { buildKnowledge } from "@/source/knowledge";
import { sourceLimits, type SourceLimits } from "@/source/limits";
import type { PrivateObjectStore } from "@/storage/object-store";
import { withWorkspace } from "./authz";
import type { VerifiedIdentity } from "./identity";
import {
  extractionJobs,
  extractionResults,
  knowledgeCollections,
  knowledgeNodes,
  sourceDocumentVersions,
  sourceProcessingCosts,
  sourceSpans,
} from "./schema";
import { persistedFailure } from "./source-repository";

export type ClaimedJob = {
  id: string;
  workspaceId: string;
  documentVersionId: string;
  attemptCount: number;
  maxAttempts: number;
};

function mediaType(value: string) {
  if ((SOURCE_MEDIA_TYPES as readonly string[]).includes(value)) return value as (typeof SOURCE_MEDIA_TYPES)[number];
  throw new SourceError("unsupported-type");
}

function excerpt(text: string, start: number, end: number) {
  const slice = text.slice(start, end).slice(0, 280);
  if (!slice) throw new SourceError("invalid-knowledge");
  return slice;
}

export async function claimExtractionJob(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  leaseOwner: string;
  leaseMs?: number;
}): Promise<ClaimedJob | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(input.leaseOwner)) throw new SourceError("invalid-path");
  const leaseMs = input.leaseMs ?? 30_000;
  return withWorkspace(input.sql, input.identity, input.workspaceId, async ({ tx }) => {
    await tx`
      UPDATE extraction_jobs
      SET status = 'failed', permanent = true, failure_code = COALESCE(failure_code, 'transient'),
          lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE workspace_id = ${input.workspaceId}::uuid
        AND status = 'processing'
        AND lease_expires_at < now()
        AND attempt_count >= max_attempts
    `;
    const claimed = await tx`
      UPDATE extraction_jobs AS job
      SET status = 'processing',
          lease_owner = ${input.leaseOwner},
          lease_expires_at = now() + (${leaseMs} * interval '1 millisecond'),
          attempt_count = attempt_count + 1,
          updated_at = now()
      WHERE job.id = (
        SELECT id FROM extraction_jobs
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND permanent = false
          AND attempt_count < max_attempts
          AND (status = 'queued' OR (status = 'processing' AND lease_expires_at < now()))
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, workspace_id, document_version_id, attempt_count, max_attempts
    `;
    const row = claimed[0];
    if (!row) return null;
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      documentVersionId: String(row.document_version_id),
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
    };
  });
}

export async function runExtractionOnce(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  store: PrivateObjectStore;
  leaseOwner: string;
  limits?: Partial<SourceLimits>;
  leaseMs?: number;
}) {
  const claimed = await claimExtractionJob(input);
  if (!claimed) return null;
  const limits = sourceLimits(input.limits);
  const version = await withWorkspace(input.sql, input.identity, input.workspaceId, async ({ db }) => {
    const rows = await db
      .select()
      .from(sourceDocumentVersions)
      .where(and(eq(sourceDocumentVersions.id, claimed.documentVersionId), eq(sourceDocumentVersions.workspaceId, input.workspaceId)));
    return rows[0] ?? null;
  });
  if (!version) throw new SourceError("cross-workspace");
  const started = performance.now();
  try {
    const bytes = await input.store.readOriginal(input.workspaceId, version.contentHash);
    const extracted = await extractDocument(mediaType(version.mediaType), bytes, limits);
    const knowledge = buildKnowledge({
      documentVersionId: version.id,
      workspaceId: input.workspaceId,
      extracted: extracted.blocks,
    });
    const canonical = await input.store.putCanonical(input.workspaceId, version.contentHash, knowledge.canonical.text);
    await persistSuccess({
      ...input,
      claimed,
      version,
      extracted,
      knowledge,
      canonicalLocator: canonical.locator,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    });
    return claimed;
  } catch (error) {
    await persistFailure({
      ...input,
      claimed,
      version,
      failure: persistedFailure(error),
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    });
    return claimed;
  }
}

async function persistSuccess(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  claimed: ClaimedJob;
  leaseOwner: string;
  version: { id: string; sizeBytes: number };
  extracted: { status: "complete" | "partial"; pageCount: number | null; issues: { code: string; page: number | null }[] };
  knowledge: ReturnType<typeof buildKnowledge>;
  canonicalLocator: string;
  durationMs: number;
}) {
  const extractionId = randomUUID();
  await withWorkspace(input.sql, input.identity, input.workspaceId, async ({ db }) => {
    await db.insert(extractionResults).values({
      id: extractionId,
      workspaceId: input.workspaceId,
      documentVersionId: input.version.id,
      jobId: input.claimed.id,
      extractorName: "adeena.source-extract",
      extractorVersion: "1",
      status: input.extracted.status,
      canonicalLocator: input.canonicalLocator,
      canonicalTextHash: input.knowledge.canonical.hash,
      pageCount: input.extracted.pageCount,
      diagnostics: input.extracted.issues,
    });
    await db.insert(sourceSpans).values(
      input.knowledge.spans.map((span) => ({
        id: span.id,
        workspaceId: input.workspaceId,
        documentVersionId: input.version.id,
        extractionId,
        textHash: span.canonicalTextHash,
        startOffset: span.start,
        endOffset: span.end,
        pageNumber: span.page,
        excerpt: excerpt(input.knowledge.canonical.text, span.start, span.end),
      })),
    );
    await db.insert(knowledgeCollections).values({
      id: input.knowledge.collection.id,
      workspaceId: input.workspaceId,
      documentVersionId: input.version.id,
      title: null,
      structureStatus: input.extracted.status,
      canonicalTextHash: input.knowledge.canonical.hash,
    });
    for (const node of input.knowledge.nodes) {
      await db.insert(knowledgeNodes).values({
        id: node.id,
        collectionId: node.collectionId,
        workspaceId: input.workspaceId,
        parentId: node.parentId,
        role: node.kind,
        title: node.title,
        nodeOrder: node.order,
        confidence: node.headingCertainty,
        spanId: node.spanId,
      });
    }
    await db.insert(sourceProcessingCosts).values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      jobId: input.claimed.id,
      uploadedBytes: input.version.sizeBytes,
      storedBytes: input.version.sizeBytes + Buffer.byteLength(input.knowledge.canonical.text),
      processedPages: input.extracted.pageCount,
      durationMs: input.durationMs,
      operationStatus: input.extracted.status,
      aiGenerationAuthorized: false,
    });
    const finished = await db
      .update(extractionJobs)
      .set({
        status: input.extracted.status,
        leaseOwner: null,
        leaseExpiresAt: null,
        failureCode: null,
        permanent: false,
        updatedAt: new Date(),
      })
      .where(and(eq(extractionJobs.id, input.claimed.id), eq(extractionJobs.leaseOwner, input.leaseOwner), eq(extractionJobs.status, "processing")))
      .returning({ id: extractionJobs.id });
    if (finished.length === 0) throw new SourceError("transient");
  });
}

async function persistFailure(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  claimed: ClaimedJob;
  leaseOwner: string;
  version: { id: string; sizeBytes: number };
  failure: SourceError;
  durationMs: number;
}) {
  const retry = input.failure.code === "transient" && input.claimed.attemptCount < input.claimed.maxAttempts;
  await withWorkspace(input.sql, input.identity, input.workspaceId, async ({ db }) => {
    if (!retry) {
      await db.insert(extractionResults).values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        documentVersionId: input.version.id,
        jobId: input.claimed.id,
        extractorName: "adeena.source-extract",
        extractorVersion: "1",
        status: "failed",
        canonicalLocator: null,
        canonicalTextHash: createHash("sha256").update("").digest("hex"),
        pageCount: null,
        diagnostics: [{ code: input.failure.code, page: null }],
      });
      await db.insert(sourceProcessingCosts).values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        jobId: input.claimed.id,
        uploadedBytes: input.version.sizeBytes,
        storedBytes: input.version.sizeBytes,
        processedPages: null,
        durationMs: input.durationMs,
        operationStatus: "failed",
        aiGenerationAuthorized: false,
      });
    }
    await db
      .update(extractionJobs)
      .set({
        status: retry ? "queued" : "failed",
        permanent: !retry,
        failureCode: input.failure.code,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(extractionJobs.id, input.claimed.id), eq(extractionJobs.leaseOwner, input.leaseOwner)));
  });
}
