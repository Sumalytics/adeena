import { createHash, randomUUID } from "node:crypto";
import {
  ExtractionCost,
  ExtractionResult,
  KnowledgeCollection,
  KnowledgeNode,
  SourceDocumentVersion,
  SourceSpan,
  type ExtractionCost as ExtractionCostRecord,
  type ExtractionResult as ExtractionResultRecord,
  type KnowledgeCollection as KnowledgeCollectionRecord,
  type KnowledgeNode as KnowledgeNodeRecord,
  type SourceDocumentVersion as SourceDocumentVersionRecord,
  type SourceSpan as SourceSpanRecord,
} from "@/contracts/source";
import { classifyDocument, displayFilename, extractDocument } from "./extract";
import { SOURCE_ERROR_CODES, SourceError, type SourceErrorCode } from "./errors";
import { buildKnowledge } from "./knowledge";
import { sourceLimits, type SourceLimits } from "./limits";
import { assertMembership, type VerifiedMembership } from "./membership";
import type { SourceStore } from "./store";

export type IngestedSource = {
  version: SourceDocumentVersionRecord;
  extraction: ExtractionResultRecord;
  collection: KnowledgeCollectionRecord;
  nodes: KnowledgeNodeRecord[];
  spans: SourceSpanRecord[];
  cost: ExtractionCostRecord;
  replayed: boolean;
};

function hashBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function storedCode(value: string | undefined): SourceErrorCode {
  if (value && (SOURCE_ERROR_CODES as readonly string[]).includes(value)) return value as SourceErrorCode;
  return "unreadable-pdf";
}

async function readIngested(store: SourceStore, workspaceId: string, contentHash: string): Promise<IngestedSource | null> {
  const version = SourceDocumentVersion.safeParse(await store.readJson(workspaceId, contentHash, "version.json"));
  const extraction = ExtractionResult.safeParse(await store.readJson(workspaceId, contentHash, "extraction.json"));
  if (!version.success || !extraction.success) return null;
  if (extraction.data.status === "failed") throw new SourceError(storedCode(extraction.data.issues[0]?.code));
  const collection = KnowledgeCollection.safeParse(await store.readJson(workspaceId, contentHash, "knowledge.json"));
  const nodes = KnowledgeNode.array().safeParse(await store.readJson(workspaceId, contentHash, "nodes.json"));
  const spans = SourceSpan.array().safeParse(await store.readJson(workspaceId, contentHash, "spans.json"));
  const cost = ExtractionCost.safeParse(await store.readJson(workspaceId, contentHash, "cost.json"));
  if (!collection.success || !nodes.success || !spans.success || !cost.success) return null;
  return {
    version: version.data,
    extraction: extraction.data,
    collection: collection.data,
    nodes: nodes.data,
    spans: spans.data,
    cost: cost.data,
    replayed: true,
  };
}

export async function acceptDocumentBytes(input: {
  membership: VerifiedMembership;
  filename: string;
  bytes: Uint8Array;
  store: SourceStore;
  limits?: Partial<SourceLimits>;
}) {
  const membership = assertMembership(input.membership);
  const limits = sourceLimits(input.limits);
  if (input.bytes.byteLength === 0) throw new SourceError("empty-file");
  if (input.bytes.byteLength > limits.maxBytes) throw new SourceError("oversized");
  const mediaType = classifyDocument(input.filename, input.bytes);
  const contentHash = hashBytes(input.bytes);
  const created = await input.store.putBytes(membership.workspaceId, contentHash, input.bytes);
  const stored = await input.store.readBytes(membership.workspaceId, contentHash);
  if (!stored || hashBytes(stored) !== contentHash) throw new SourceError("integrity-mismatch");
  return {
    membership,
    mediaType,
    contentHash,
    created,
    stored,
    filename: displayFilename(input.filename),
    byteCount: input.bytes.byteLength,
  };
}

export async function ingestDocument(input: {
  membership: VerifiedMembership;
  filename: string;
  bytes: Uint8Array;
  store: SourceStore;
  now?: Date;
  limits?: Partial<SourceLimits>;
}): Promise<IngestedSource> {
  const accepted = await acceptDocumentBytes(input);
  const limits = sourceLimits(input.limits);
  const { membership, mediaType, contentHash, created, stored } = accepted;
  if (created === "exists") {
    const existing = await readIngested(input.store, membership.workspaceId, contentHash);
    if (existing) return existing;
  }

  const started = performance.now();
  const prior = SourceDocumentVersion.safeParse(await input.store.readJson(membership.workspaceId, contentHash, "version.json"));
  const version = prior.success ? prior.data : SourceDocumentVersion.parse({
    contract: "SOURCE-DOC-v1",
    id: randomUUID(),
    version: 1,
    immutable: true,
    workspaceId: membership.workspaceId,
    contentHash,
    byteCount: input.bytes.byteLength,
    filename: displayFilename(input.filename),
    mediaType,
    rightsStatus: "unverified",
    educationalValidation: "none",
    uploadedAt: (input.now ?? new Date()).toISOString(),
    provenance: { actorId: membership.actorId, method: "authorized-ingestion" },
  });
  await input.store.writeJson(membership.workspaceId, contentHash, "version.json", version);

  try {
    const extracted = await extractDocument(mediaType, stored, limits);
    const knowledge = buildKnowledge({
      documentVersionId: version.id,
      workspaceId: membership.workspaceId,
      extracted: extracted.blocks,
    });
    const durationMs = performance.now() - started;
    const extraction = ExtractionResult.parse({
      contract: "EXTRACTION-v1",
      id: randomUUID(),
      documentVersionId: version.id,
      workspaceId: membership.workspaceId,
      extractor: { name: "adeena.source-extract", version: "1" },
      canonicalTextHash: knowledge.canonical.hash,
      status: extracted.status,
      pageCount: extracted.pageCount,
      issues: extracted.issues,
      educationalValidation: "none",
      durationMs,
    });
    const canonicalBytes = Buffer.byteLength(knowledge.canonical.text);
    const cost = ExtractionCost.parse({
      contract: "SOURCE-COST-v1",
      documentVersionId: version.id,
      workspaceId: membership.workspaceId,
      uploadedBytes: input.bytes.byteLength,
      storedBytes: input.bytes.byteLength + canonicalBytes,
      processedPages: extracted.pageCount,
      durationMs,
      outcome: extracted.status,
      aiGenerationAuthorized: false,
    });
    await input.store.writeText(membership.workspaceId, contentHash, "canonical.txt", knowledge.canonical.text);
    await input.store.writeJson(membership.workspaceId, contentHash, "extraction.json", extraction);
    await input.store.writeJson(membership.workspaceId, contentHash, "knowledge.json", knowledge.collection);
    await input.store.writeJson(membership.workspaceId, contentHash, "nodes.json", knowledge.nodes);
    await input.store.writeJson(membership.workspaceId, contentHash, "spans.json", knowledge.spans);
    await input.store.writeJson(membership.workspaceId, contentHash, "cost.json", cost);
    return {
      version,
      extraction,
      collection: knowledge.collection,
      nodes: knowledge.nodes,
      spans: knowledge.spans,
      cost,
      replayed: false,
    };
  } catch (error) {
    const failure = error instanceof SourceError
      ? error
      : error instanceof Error && error.name === "ZodError"
        ? new SourceError("invalid-knowledge")
        : new SourceError("transient");
    const durationMs = performance.now() - started;
    const extraction = ExtractionResult.parse({
      contract: "EXTRACTION-v1",
      id: randomUUID(),
      documentVersionId: version.id,
      workspaceId: membership.workspaceId,
      extractor: { name: "adeena.source-extract", version: "1" },
      canonicalTextHash: createHash("sha256").update("").digest("hex"),
      status: "failed",
      pageCount: null,
      issues: [{ code: failure.code, page: null }],
      educationalValidation: "none",
      durationMs,
    });
    const cost = ExtractionCost.parse({
      contract: "SOURCE-COST-v1",
      documentVersionId: version.id,
      workspaceId: membership.workspaceId,
      uploadedBytes: input.bytes.byteLength,
      storedBytes: input.bytes.byteLength,
      processedPages: null,
      durationMs,
      outcome: "failed",
      aiGenerationAuthorized: false,
    });
    await input.store.writeJson(membership.workspaceId, contentHash, "extraction.json", extraction);
    await input.store.writeJson(membership.workspaceId, contentHash, "cost.json", cost);
    throw failure;
  }
}

export async function readCanonicalText(input: {
  membership: VerifiedMembership;
  contentHash: string;
  store: SourceStore;
}) {
  const membership = assertMembership(input.membership);
  const text = await input.store.readText(membership.workspaceId, input.contentHash, "canonical.txt");
  if (text === null) throw new SourceError("cross-workspace");
  return text;
}
