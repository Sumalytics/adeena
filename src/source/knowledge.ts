import { createHash, randomUUID } from "node:crypto";
import {
  KnowledgeCollection,
  KnowledgeNode,
  SourceSpan,
  type KnowledgeCollection as KnowledgeCollectionRecord,
  type KnowledgeNode as KnowledgeNodeRecord,
  type SourceSpan as SourceSpanRecord,
} from "@/contracts/source";
import { SourceError } from "./errors";
import type { ExtractedBlock } from "./extract-text";

export type CanonicalText = {
  text: string;
  hash: string;
  pieces: { block: ExtractedBlock; start: number; end: number }[];
};

export function canonicalText(blocks: ExtractedBlock[]): CanonicalText {
  const pieces: CanonicalText["pieces"] = [];
  let text = "";
  for (const block of blocks) {
    if (text) text += "\n\n";
    const start = text.length;
    text += block.text;
    pieces.push({ block, start, end: text.length });
  }
  return { text, hash: createHash("sha256").update(text).digest("hex"), pieces };
}

export function buildKnowledge(input: {
  documentVersionId: string;
  workspaceId: string;
  extracted: ExtractedBlock[];
}): {
  collection: KnowledgeCollectionRecord;
  nodes: KnowledgeNodeRecord[];
  spans: SourceSpanRecord[];
  canonical: CanonicalText;
} {
  const canonical = canonicalText(input.extracted);
  const collectionId = randomUUID();
  const spans: SourceSpanRecord[] = [];
  const nodes: KnowledgeNodeRecord[] = [];
  const documentSpan = SourceSpan.parse({
    contract: "SOURCE-SPAN-v1",
    id: randomUUID(),
    documentVersionId: input.documentVersionId,
    workspaceId: input.workspaceId,
    canonicalTextHash: canonical.hash,
    start: 0,
    end: canonical.text.length,
    page: null,
  });
  spans.push(documentSpan);
  const documentNode = KnowledgeNode.parse({
    contract: "KNOWLEDGE-NODE-v1",
    id: randomUUID(),
    collectionId,
    documentVersionId: input.documentVersionId,
    workspaceId: input.workspaceId,
    kind: "document",
    parentId: null,
    order: 0,
    title: null,
    headingCertainty: "none",
    spanId: documentSpan.id,
  });
  nodes.push(documentNode);
  let chapterId: string | null = null;
  let sectionId: string | null = null;
  for (const piece of canonical.pieces) {
    const span = SourceSpan.parse({
      contract: "SOURCE-SPAN-v1",
      id: randomUUID(),
      documentVersionId: input.documentVersionId,
      workspaceId: input.workspaceId,
      canonicalTextHash: canonical.hash,
      start: piece.start,
      end: piece.end,
      page: piece.block.page,
    });
    spans.push(span);
    let parentId = documentNode.id;
    if (piece.block.kind === "chapter") {
      parentId = documentNode.id;
    } else if (piece.block.kind === "section") {
      parentId = chapterId ?? documentNode.id;
    } else if (sectionId) parentId = sectionId;
    else if (chapterId) parentId = chapterId;
    const node = KnowledgeNode.parse({
      contract: "KNOWLEDGE-NODE-v1",
      id: randomUUID(),
      collectionId,
      documentVersionId: input.documentVersionId,
      workspaceId: input.workspaceId,
      kind: piece.block.kind,
      parentId,
      order: nodes.length,
      title: piece.block.title,
      headingCertainty: piece.block.headingCertainty,
      spanId: span.id,
    });
    nodes.push(node);
    if (piece.block.kind === "chapter") {
      chapterId = node.id;
      sectionId = null;
    } else if (piece.block.kind === "section") sectionId = node.id;
  }
  const collection = KnowledgeCollection.parse({
    contract: "KNOWLEDGE-COLLECTION-v1",
    id: collectionId,
    documentVersionId: input.documentVersionId,
    workspaceId: input.workspaceId,
    canonicalTextHash: canonical.hash,
    nodeIds: nodes.map((node) => node.id),
    educationalValidation: "none",
  });
  assertKnowledge({ collection, nodes, spans, canonicalText: canonical.text });
  return { collection, nodes, spans, canonical };
}

export function assertKnowledge(input: {
  collection: KnowledgeCollectionRecord;
  nodes: KnowledgeNodeRecord[];
  spans: SourceSpanRecord[];
  canonicalText: string;
}) {
  const hash = createHash("sha256").update(input.canonicalText).digest("hex");
  if (hash !== input.collection.canonicalTextHash) throw new SourceError("invalid-knowledge");
  if (input.collection.nodeIds.join("|") !== input.nodes.map((node) => node.id).join("|")) {
    throw new SourceError("invalid-knowledge");
  }
  const orders = new Set<number>();
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const spanById = new Map(input.spans.map((span) => [span.id, span]));
  for (const node of input.nodes) {
    if (node.collectionId !== input.collection.id) throw new SourceError("invalid-knowledge");
    if (node.documentVersionId !== input.collection.documentVersionId) throw new SourceError("invalid-knowledge");
    if (node.workspaceId !== input.collection.workspaceId) throw new SourceError("invalid-knowledge");
    if (orders.has(node.order)) throw new SourceError("invalid-knowledge");
    orders.add(node.order);
    if (node.parentId === node.id) throw new SourceError("invalid-knowledge");
    if (node.kind === "document" && node.parentId !== null) throw new SourceError("invalid-knowledge");
    if (node.kind !== "document" && !node.parentId) throw new SourceError("invalid-knowledge");
    if (node.parentId && !byId.has(node.parentId)) throw new SourceError("invalid-knowledge");
    const seen = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId) {
      if (seen.has(parentId)) throw new SourceError("invalid-knowledge");
      seen.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    const span = spanById.get(node.spanId);
    if (!span) throw new SourceError("invalid-knowledge");
    if (span.documentVersionId !== node.documentVersionId || span.workspaceId !== node.workspaceId) {
      throw new SourceError("invalid-knowledge");
    }
    if (span.canonicalTextHash !== hash) throw new SourceError("invalid-knowledge");
    if (span.start < 0 || span.end > input.canonicalText.length || span.end <= span.start) {
      throw new SourceError("invalid-knowledge");
    }
  }
}
