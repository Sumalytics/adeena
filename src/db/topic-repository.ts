import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Sql } from "postgres";
import { plainText, type AgeBand } from "@/contracts/common";
import { TOPIC_DETECTION_VERSION, TopicOverride } from "@/contracts/topic";
import type { KnowledgeNode, SourceSpan } from "@/contracts/source";
import { SourceError } from "@/source/errors";
import { analyzeTopics } from "@/topic/analyze";
import type { ExtractedSourceSummary, TopicCandidateView, TopicRecommendationView } from "@/topic/public";
import { withWorkspace } from "./authz";
import type { VerifiedIdentity } from "./identity";
import {
  extractionResults,
  knowledgeCollections,
  knowledgeNodes,
  recommendationRuns,
  sourceDocumentVersions,
  sourceSpans,
  topicCandidates,
  topicOverrides,
} from "./schema";

const PAGE_LIMIT = 20;

export type { ExtractedSourceSummary, TopicCandidateView, TopicRecommendationView };

type RunRow = typeof recommendationRuns.$inferSelect;
type CandidateRow = typeof topicCandidates.$inferSelect;

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function candidateView(row: CandidateRow): TopicCandidateView {
  const method = row.detectionMethod;
  const uncertainty = row.uncertainty;
  const eligibility = row.eligibility;
  if (method !== "explicit-heading" && method !== "document-structure" && method !== "bounded-text") {
    throw new SourceError("invalid-topic");
  }
  if (uncertainty !== "stated" && uncertainty !== "uncertain") throw new SourceError("invalid-topic");
  if (eligibility !== "eligible" && eligibility !== "needs-review" && eligibility !== "insufficient-support") {
    throw new SourceError("invalid-topic");
  }
  return {
    id: row.id,
    title: row.title,
    sourceOrder: row.sourceOrder,
    detectionMethod: method,
    uncertainty,
    eligibility,
    reasons: asStringArray(row.reasons),
    primaryNodeId: row.primaryNodeId,
    supportChars: row.supportChars,
  };
}

function extractionStatus(value: string): "complete" | "partial" | "failed" {
  if (value === "complete" || value === "partial" || value === "failed") return value;
  throw new SourceError("invalid-topic");
}

function rightsStatus(value: string): "unverified" | "cleared" | "blocked" {
  if (value === "unverified" || value === "cleared" || value === "blocked") return value;
  throw new SourceError("invalid-topic");
}

function issueList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item && typeof item === "object" && "code" in item && typeof item.code === "string") return [{ code: item.code }];
    return [];
  });
}

function nodeKind(value: string): KnowledgeNode["kind"] {
  if (value === "document" || value === "chapter" || value === "section" || value === "block") return value;
  throw new SourceError("invalid-topic");
}

function headingCertainty(value: string): KnowledgeNode["headingCertainty"] {
  if (value === "reliable" || value === "ambiguous" || value === "none") return value;
  throw new SourceError("invalid-topic");
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

async function candidateRows(
  db: Parameters<Parameters<typeof withWorkspace>[3]>[0]["db"],
  workspaceId: string,
  documentVersionId: string,
  overrideVersion: number,
) {
  return db
    .select()
    .from(topicCandidates)
    .where(and(
      eq(topicCandidates.workspaceId, workspaceId),
      eq(topicCandidates.documentVersionId, documentVersionId),
      eq(topicCandidates.detectionVersion, TOPIC_DETECTION_VERSION),
      eq(topicCandidates.overrideVersion, overrideVersion),
    ));
}

function present(run: RunRow, rows: CandidateRow[], offset: number, replayed: boolean): TopicRecommendationView {
  const ordered = [...rows].sort((a, b) => a.sourceOrder - b.sourceOrder);
  const chosen = ordered.find((row) => row.id === run.topicCandidateId) ?? null;
  const status = run.status;
  if (status !== "recommended" && status !== "needs-creator-selection" && status !== "insufficient-support") {
    throw new SourceError("invalid-topic");
  }
  const understood = run.understood;
  if (understood !== "full" && understood !== "partial" && understood !== "unreadable") throw new SourceError("invalid-topic");
  const page = ordered.slice(offset, offset + PAGE_LIMIT).map(candidateView);
  return {
    recommendation: {
      id: run.id,
      status,
      reason: run.reason,
      topicTitle: chosen?.title ?? null,
      topicCandidateId: run.topicCandidateId,
      understood,
      generatesExperience: false,
      experienceVersionId: null,
      aiGenerationAuthorized: false,
      candidateCount: run.candidateCount,
      processedChars: run.processedChars,
      durationMs: run.durationMs,
      failureCount: 0,
      detectionVersion: TOPIC_DETECTION_VERSION,
      overrideVersion: run.overrideVersion,
      replayed,
    },
    candidates: page,
    page: { offset, limit: PAGE_LIMIT, total: ordered.length },
  };
}

export async function listExtractedSources(sql: Sql, identity: VerifiedIdentity, workspaceId: string) {
  return withWorkspace(sql, identity, workspaceId, async ({ db }) => {
    const versions = await db
      .select()
      .from(sourceDocumentVersions)
      .where(eq(sourceDocumentVersions.workspaceId, workspaceId))
      .orderBy(desc(sourceDocumentVersions.createdAt))
      .limit(50);
    const results = await db
      .select()
      .from(extractionResults)
      .where(eq(extractionResults.workspaceId, workspaceId));
    const statusByVersion = new Map(results.map((row) => [row.documentVersionId, row.status]));
    return versions.map((version): ExtractedSourceSummary => {
      const status = statusByVersion.get(version.id);
      return {
        documentVersionId: version.id,
        filename: version.originalFilename,
        extractionStatus: status === "complete" || status === "partial" || status === "failed" ? status : "pending",
      };
    });
  });
}

export async function readTopicRecommendation(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  documentVersionId: string;
  audienceLabel: string;
  ageBand: AgeBand;
  offset?: number;
}) {
  const offset = Math.max(0, input.offset ?? 0);
  return withWorkspace(input.sql, input.identity, input.workspaceId, async ({ db, tx }) => {
    const latest = await tx<{ version: number | null }[]>`
      select max(version) as version from topic_overrides
      where workspace_id = ${input.workspaceId}::uuid
        and document_version_id = ${input.documentVersionId}::uuid
    `;
    const overrideVersion = Number(latest[0]?.version ?? 0);
    const runs = await db
      .select()
      .from(recommendationRuns)
      .where(and(
        eq(recommendationRuns.workspaceId, input.workspaceId),
        eq(recommendationRuns.documentVersionId, input.documentVersionId),
        eq(recommendationRuns.audienceLabel, input.audienceLabel),
        eq(recommendationRuns.ageBand, input.ageBand),
        eq(recommendationRuns.overrideVersion, overrideVersion),
        eq(recommendationRuns.active, true),
      ));
    const run = runs[0];
    if (!run) return { recommendation: null, candidates: [], page: { offset, limit: PAGE_LIMIT, total: 0 } } satisfies TopicRecommendationView;
    const rows = await candidateRows(db, input.workspaceId, input.documentVersionId, overrideVersion);
    return present(run, rows, offset, true);
  });
}

export async function recommendFirstTopic(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  documentVersionId: string;
  audienceLabel: string;
  ageBand: AgeBand;
  idempotencyKey: string;
}) {
  try {
    return await storeRecommendation(input, false);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return storeRecommendation(input, true);
  }
}

async function storeRecommendation(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  documentVersionId: string;
  audienceLabel: string;
  ageBand: AgeBand;
  idempotencyKey: string;
}, replayOnly: boolean) {
  return withWorkspace(input.sql, input.identity, input.workspaceId, async ({ db }) => {
    const byKey = await db
      .select()
      .from(recommendationRuns)
      .where(and(eq(recommendationRuns.workspaceId, input.workspaceId), eq(recommendationRuns.idempotencyKey, input.idempotencyKey)));
    if (byKey[0]) {
      const rows = await candidateRows(db, input.workspaceId, input.documentVersionId, byKey[0].overrideVersion);
      return present(byKey[0], rows, 0, true);
    }
    if (replayOnly) throw new SourceError("transient");

    const versions = await db
      .select()
      .from(sourceDocumentVersions)
      .where(and(eq(sourceDocumentVersions.workspaceId, input.workspaceId), eq(sourceDocumentVersions.id, input.documentVersionId)));
    const version = versions[0];
    if (!version) throw new SourceError("cross-workspace");
    const extractions = await db
      .select()
      .from(extractionResults)
      .where(and(eq(extractionResults.workspaceId, input.workspaceId), eq(extractionResults.documentVersionId, version.id)));
    const extraction = extractions[0];
    if (!extraction) throw new SourceError("invalid-topic");
    const collections = await db
      .select()
      .from(knowledgeCollections)
      .where(and(eq(knowledgeCollections.workspaceId, input.workspaceId), eq(knowledgeCollections.documentVersionId, version.id)));
    const collection = collections[0] ?? null;
    const nodeRows = collection
      ? await db.select().from(knowledgeNodes).where(and(eq(knowledgeNodes.workspaceId, input.workspaceId), eq(knowledgeNodes.collectionId, collection.id)))
      : [];
    const spanRows = await db
      .select()
      .from(sourceSpans)
      .where(and(eq(sourceSpans.workspaceId, input.workspaceId), eq(sourceSpans.documentVersionId, version.id)));
    const overrideRows = await db
      .select()
      .from(topicOverrides)
      .where(and(eq(topicOverrides.workspaceId, input.workspaceId), eq(topicOverrides.documentVersionId, version.id)));
    const overrideVersion = overrideRows.reduce((max, row) => Math.max(max, row.version), 0);
    const active = await db
      .select()
      .from(recommendationRuns)
      .where(and(
        eq(recommendationRuns.workspaceId, input.workspaceId),
        eq(recommendationRuns.documentVersionId, version.id),
        eq(recommendationRuns.audienceLabel, input.audienceLabel),
        eq(recommendationRuns.ageBand, input.ageBand),
        eq(recommendationRuns.overrideVersion, overrideVersion),
        eq(recommendationRuns.active, true),
      ));
    if (active[0]) {
      const rows = await candidateRows(db, input.workspaceId, version.id, overrideVersion);
      return present(active[0], rows, 0, true);
    }

    const latestOverride = new Map<string, { version: number; title: string }>();
    for (const row of overrideRows) {
      const current = latestOverride.get(row.nodeId);
      if (!current || row.version > current.version) latestOverride.set(row.nodeId, { version: row.version, title: row.correctedTitle });
    }
    const nodes: KnowledgeNode[] = nodeRows.map((row) => ({
      contract: "KNOWLEDGE-NODE-v1",
      id: row.id,
      collectionId: row.collectionId,
      documentVersionId: version.id,
      workspaceId: input.workspaceId,
      kind: nodeKind(row.role),
      parentId: row.parentId,
      order: row.nodeOrder,
      title: row.title,
      headingCertainty: headingCertainty(row.confidence),
      spanId: row.spanId,
    }));
    const spans: SourceSpan[] = spanRows.map((row) => ({
      contract: "SOURCE-SPAN-v1",
      id: row.id,
      documentVersionId: version.id,
      workspaceId: input.workspaceId,
      canonicalTextHash: extraction.canonicalTextHash,
      start: row.startOffset,
      end: row.endOffset,
      page: row.pageNumber,
    }));
    const started = performance.now();
    if (extraction.status !== "failed" && !collection) throw new SourceError("invalid-topic");
    const decision = analyzeTopics({
      nodes,
      spans,
      extraction: {
        id: extraction.id,
        status: extractionStatus(extraction.status),
        issues: issueList(extraction.diagnostics),
      },
      canonicalTextLength: spans.reduce((max, span) => Math.max(max, span.end), 0),
      audienceLabel: input.audienceLabel,
      ageBand: input.ageBand,
      rightsStatus: rightsStatus(version.rightsStatus),
      excerpts: new Map(spanRows.map((row) => [row.id, row.excerpt])),
      overrides: [...latestOverride.entries()].map(([nodeId, override]) => ({ nodeId, title: override.title })),
    });
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    if (collection && decision.candidates.length > 0) {
      const existing = await candidateRows(db, input.workspaceId, version.id, overrideVersion);
      if (existing.length === 0) {
        await db.insert(topicCandidates).values(decision.candidates.map((candidate) => ({
          id: candidate.id,
          workspaceId: input.workspaceId,
          collectionId: candidate.collectionId,
          documentVersionId: candidate.documentVersionId,
          extractionId: candidate.extractionId,
          detectionVersion: candidate.detectionVersion,
          overrideVersion,
          title: candidate.title,
          sourceOrder: candidate.sourceOrder,
          detectionMethod: candidate.detectionMethod,
          uncertainty: candidate.uncertainty,
          eligibility: candidate.eligibility,
          reasons: candidate.reasons,
          supportChars: candidate.supportChars,
          primaryNodeId: candidate.primaryNodeId,
          nodeIds: candidate.nodeIds,
          sourceSpanIds: candidate.sourceSpanIds,
        })));
      }
    }
    const stored = collection ? await candidateRows(db, input.workspaceId, version.id, overrideVersion) : [];
    const aligned = decision.topicCandidateId
      ? stored.find((row) => row.id === decision.topicCandidateId)
        ?? stored.find((row) => row.sourceOrder === decision.candidates.find((candidate) => candidate.id === decision.topicCandidateId)?.sourceOrder)
      : null;
    const topicCandidateId = decision.status === "recommended" ? aligned?.id ?? null : null;
    if (decision.status === "recommended" && !topicCandidateId) throw new SourceError("invalid-topic");
    const inserted = await db
      .insert(recommendationRuns)
      .values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        collectionId: collection?.id ?? null,
        documentVersionId: version.id,
        extractionId: extraction.id,
        detectionVersion: TOPIC_DETECTION_VERSION,
        overrideVersion,
        audienceLabel: input.audienceLabel,
        ageBand: input.ageBand,
        status: topicCandidateId ? decision.status : decision.status === "recommended" ? "insufficient-support" : decision.status,
        topicCandidateId,
        reason: decision.reason,
        reasons: decision.reasons,
        sourceSpanIds: aligned ? asStringArray(aligned.sourceSpanIds) : [],
        understood: decision.understood,
        candidateCount: stored.length || decision.candidates.length,
        processedChars: decision.processedChars,
        durationMs,
        failureCount: 0,
        generatesExperience: false,
        experienceVersionId: null,
        aiGenerationAuthorized: false,
        active: true,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();
    const run = inserted[0];
    if (!run) throw new SourceError("transient");
    return present(run, stored.length > 0 ? stored : [], 0, false);
  });
}

export async function correctTopicHeading(input: {
  sql: Sql;
  identity: VerifiedIdentity;
  workspaceId: string;
  documentVersionId: string;
  nodeId: string;
  correctedTitle: string;
}) {
  const title = plainText(200).safeParse(input.correctedTitle);
  if (!title.success) throw new SourceError("invalid-topic");
  return withWorkspace(input.sql, input.identity, input.workspaceId, async ({ db, tx, userId }) => {
    const nodes = await db
      .select()
      .from(knowledgeNodes)
      .where(and(eq(knowledgeNodes.workspaceId, input.workspaceId), eq(knowledgeNodes.id, input.nodeId)));
    const node = nodes[0];
    if (!node || (node.role !== "chapter" && node.role !== "section")) throw new SourceError("invalid-topic");
    const versions = await db
      .select()
      .from(sourceDocumentVersions)
      .where(and(eq(sourceDocumentVersions.workspaceId, input.workspaceId), eq(sourceDocumentVersions.id, input.documentVersionId)));
    if (!versions[0]) throw new SourceError("cross-workspace");
    const collections = await db
      .select()
      .from(knowledgeCollections)
      .where(and(eq(knowledgeCollections.id, node.collectionId), eq(knowledgeCollections.documentVersionId, input.documentVersionId)));
    if (!collections[0]) throw new SourceError("invalid-topic");
    const prior = await db
      .select()
      .from(topicOverrides)
      .where(and(eq(topicOverrides.workspaceId, input.workspaceId), eq(topicOverrides.documentVersionId, input.documentVersionId)));
    const nodePrior = prior.filter((row) => row.nodeId === node.id);
    const effective = nodePrior.sort((a, b) => b.version - a.version)[0]?.correctedTitle ?? node.title;
    if (effective === title.data) {
      return { override: null, invalidated: 0, generatesExperience: false as const };
    }
    const version = prior.reduce((max, row) => Math.max(max, row.version), 0) + 1;
    const inserted = await db
      .insert(topicOverrides)
      .values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        documentVersionId: input.documentVersionId,
        collectionId: node.collectionId,
        nodeId: node.id,
        version,
        correctedTitle: title.data,
        createdBy: userId,
      })
      .returning();
    const saved = inserted[0];
    if (!saved) throw new SourceError("transient");
    const invalidated = await tx<{ id: string }[]>`
      update recommendation_runs
      set active = false
      where workspace_id = ${input.workspaceId}::uuid
        and document_version_id = ${input.documentVersionId}::uuid
        and active = true
      returning id
    `;
    const unchanged = await tx<{ title: string | null }[]>`
      select title from knowledge_nodes
      where id = ${node.id}::uuid and workspace_id = ${input.workspaceId}::uuid
    `;
    if (unchanged[0]?.title !== node.title) throw new SourceError("invalid-topic");
    const override = TopicOverride.parse({
      contract: "TOPIC-OVERRIDE-v1",
      id: saved.id,
      workspaceId: saved.workspaceId,
      documentVersionId: saved.documentVersionId,
      collectionId: saved.collectionId,
      nodeId: saved.nodeId,
      version: saved.version,
      correctedTitle: saved.correctedTitle,
      createdBy: saved.createdBy,
      generatesExperience: false,
    });
    return { override, invalidated: invalidated.length, generatesExperience: false as const };
  });
}
