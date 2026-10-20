import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Sql } from "postgres";
import { classifyDocument, displayFilename } from "@/source/extract";
import { SourceError, sourceError } from "@/source/errors";
import { sourceLimits, type SourceLimits } from "@/source/limits";
import type { PrivateObjectStore } from "@/storage/object-store";
import { withWorkspace } from "./authz";
import { databaseFailure } from "./client";
import type { VerifiedIdentity } from "./identity";
import {
  extractionJobs,
  extractionResults,
  knowledgeCollections,
  knowledgeNodes,
  sourceDocumentVersions,
  sourceDocuments,
  sourceProcessingCosts,
  sourceSpans,
  workspaceMemberships,
} from "./schema";

export async function grantMembership(
  sql: Sql,
  identity: VerifiedIdentity,
  input: { workspaceId: string; userId: string; role: "owner" | "editor" | "viewer" },
) {
  await withWorkspace(sql, identity, input.workspaceId, async ({ db }) => {
    await db.insert(workspaceMemberships).values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      status: "active",
    });
  });
}

export async function setMembershipStatus(
  sql: Sql,
  identity: VerifiedIdentity,
  input: { workspaceId: string; userId: string; status: "active" | "inactive" },
) {
  await withWorkspace(sql, identity, input.workspaceId, async ({ db }) => {
    await db
      .update(workspaceMemberships)
      .set({ status: input.status })
      .where(and(eq(workspaceMemberships.workspaceId, input.workspaceId), eq(workspaceMemberships.userId, input.userId)));
  });
}

export async function enqueueDurableSource(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  filename: string;
  bytes: Uint8Array;
  idempotencyKey: string;
  store: PrivateObjectStore;
  limits?: Partial<SourceLimits>;
  maxAttempts?: number;
}) {
  const limits = sourceLimits(input.limits);
  if (input.bytes.byteLength === 0) throw new SourceError("empty-file");
  if (input.bytes.byteLength > limits.maxBytes) throw new SourceError("oversized");
  const mediaType = classifyDocument(input.filename, input.bytes);
  const contentHash = createHash("sha256").update(input.bytes).digest("hex");
  const filename = displayFilename(input.filename);
  try {
    return await withWorkspace(input.sql, input.identity, input.workspaceId, async ({ db, userId }) => {
      const existingJob = await db
        .select()
        .from(extractionJobs)
        .where(and(eq(extractionJobs.workspaceId, input.workspaceId), eq(extractionJobs.idempotencyKey, input.idempotencyKey)));
      if (existingJob[0]) {
        const version = await db
          .select()
          .from(sourceDocumentVersions)
          .where(eq(sourceDocumentVersions.id, existingJob[0].documentVersionId));
        return { job: existingJob[0], version: version[0], replayed: true as const };
      }

      const existingVersion = await db
        .select()
        .from(sourceDocumentVersions)
        .where(and(eq(sourceDocumentVersions.workspaceId, input.workspaceId), eq(sourceDocumentVersions.contentHash, contentHash)));
      let version = existingVersion[0];
      if (!version) {
        const stored = await input.store.putOriginal(input.workspaceId, contentHash, input.bytes);
        if (!(await input.store.verifyOriginal(input.workspaceId, contentHash))) throw new SourceError("integrity-mismatch");
        const documentId = randomUUID();
        await db.insert(sourceDocuments).values({ id: documentId, workspaceId: input.workspaceId });
        const inserted = await db
          .insert(sourceDocumentVersions)
          .values({
            id: randomUUID(),
            documentId,
            workspaceId: input.workspaceId,
            version: 1,
            parentVersionId: null,
            originalFilename: filename,
            contentHash,
            mediaType,
            sizeBytes: input.bytes.byteLength,
            storageLocator: stored.locator,
            rightsStatus: "unverified",
            uploadedBy: userId,
          })
          .returning();
        version = inserted[0];
      }
      if (!version) throw new SourceError("integrity-mismatch");
      const insertedJob = await db
        .insert(extractionJobs)
        .values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          documentVersionId: version.id,
          idempotencyKey: input.idempotencyKey,
          status: "queued",
          attemptCount: 0,
          maxAttempts: input.maxAttempts ?? 2,
          permanent: false,
        })
        .returning();
      const job = insertedJob[0];
      if (!job) throw new SourceError("transient");
      return { job, version, replayed: false as const };
    });
  } catch (error) {
    if (error instanceof SourceError) throw error;
    const failure = databaseFailure(error);
    if (/row-level security|workspace owner/i.test(failure.message)) throw new SourceError("cross-workspace");
    throw failure;
  }
}

export async function readSourceVersion(sql: Sql, identity: VerifiedIdentity, workspaceId: string, versionId: string) {
  return withWorkspace(sql, identity, workspaceId, async ({ db }) => {
    const rows = await db
      .select()
      .from(sourceDocumentVersions)
      .where(and(eq(sourceDocumentVersions.workspaceId, workspaceId), eq(sourceDocumentVersions.id, versionId)));
    if (!rows[0]) throw new SourceError("cross-workspace");
    return rows[0];
  });
}

export async function referencedLocators(sql: Sql, identity: VerifiedIdentity, workspaceId: string) {
  return withWorkspace(sql, identity, workspaceId, async ({ db }) => {
    const versions = await db
      .select({ locator: sourceDocumentVersions.storageLocator })
      .from(sourceDocumentVersions)
      .where(eq(sourceDocumentVersions.workspaceId, workspaceId));
    const results = await db
      .select({ locator: extractionResults.canonicalLocator })
      .from(extractionResults)
      .where(eq(extractionResults.workspaceId, workspaceId));
    return [
      ...versions.map((row) => row.locator),
      ...results.flatMap((row) => (row.locator ? [row.locator] : [])),
    ];
  });
}

export async function readJob(sql: Sql, identity: VerifiedIdentity, workspaceId: string, jobId: string) {
  return withWorkspace(sql, identity, workspaceId, async ({ db }) => {
    const rows = await db
      .select()
      .from(extractionJobs)
      .where(and(eq(extractionJobs.workspaceId, workspaceId), eq(extractionJobs.id, jobId)));
    return rows[0] ?? null;
  });
}

export async function readExtractionRecord(sql: Sql, identity: VerifiedIdentity, workspaceId: string, versionId: string) {
  return withWorkspace(sql, identity, workspaceId, async ({ db }) => {
    const result = await db
      .select()
      .from(extractionResults)
      .where(and(eq(extractionResults.workspaceId, workspaceId), eq(extractionResults.documentVersionId, versionId)));
    const nodes = await db.select().from(knowledgeNodes).where(eq(knowledgeNodes.workspaceId, workspaceId));
    const spans = await db.select().from(sourceSpans).where(eq(sourceSpans.documentVersionId, versionId));
    const collections = await db
      .select()
      .from(knowledgeCollections)
      .where(eq(knowledgeCollections.documentVersionId, versionId));
    const costs = await db.select().from(sourceProcessingCosts).where(eq(sourceProcessingCosts.workspaceId, workspaceId));
    return { result: result[0] ?? null, nodes, spans, collection: collections[0] ?? null, costs };
  });
}

export function persistedFailure(error: unknown) {
  return error instanceof SourceError ? error : sourceError(error);
}
