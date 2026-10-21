import { randomUUID } from "node:crypto";
import {
  TOPIC_DETECTION_VERSION,
  TopicCandidate,
  type TopicCandidate as TopicCandidateRecord,
  type TopicReasonCode,
} from "@/contracts/topic";
import type { AgeBand } from "@/contracts/common";
import type { KnowledgeNode, SourceSpan } from "@/contracts/source";
import { SourceError } from "@/source/errors";

/**
 * Suitability points are ordering weights, not a measure of educational accuracy.
 * A higher total only means the candidate is a better automatic starting point.
 */
export const TOPIC_RANKING = {
  detectionVersion: TOPIC_DETECTION_VERSION,
  weights: {
    explicitHeading: 40,
    documentStructure: 28,
    boundedText: 12,
    eligible: 20,
    focusedLength: 30,
    usableLength: 16,
    wideLength: 10,
    completeExtraction: 10,
    missingContext: -12,
  },
  clearMargin: 15,
  lengths: { short: 80, eligible: 180, focusedMax: 4000, broad: 8000 },
} as const;

/**
 * Keyword signals for headings and short excerpts. This is not a classifier
 * and it does not read the rest of a source.
 */
export const SENSITIVITY_SCREEN = {
  coverage: "title-and-excerpt",
  excerptChars: 280,
  comprehensive: false,
} as const;

const SENSITIVE = /\b(diagnos(?:is|es|e)|dosage|prescription|medication|clinical|vaccine|surgery|safeguarding|child protection|disciplinary|termination|regulated)\b/i;

/** Same limited heading and excerpt screen used by topic recommendation. Not a safety clearance. */
export function limitedSensitivityMatch(text: string) {
  return SENSITIVE.test(text);
}
const UNSAFE = /<script|javascript:/i;

export type TopicExtraction = {
  id: string;
  status: "complete" | "partial" | "failed";
  issues: { code: string }[];
};

export type TopicDecision = {
  understood: "full" | "partial" | "unreadable";
  candidates: TopicCandidateRecord[];
  status: "recommended" | "needs-creator-selection" | "insufficient-support";
  topicCandidateId: string | null;
  reason: string;
  reasons: TopicReasonCode[];
  sourceSpanIds: string[];
  processedChars: number;
  sensitivityScreen: "title-and-excerpt" | "not-run";
  safetyClearance: "none" | "independent-validation";
  generationAuthorized: false;
};

export type IndependentSourceClearance = {
  scope: "source";
  method: "independent-validation";
  reference: string;
};

type HeadingOverride = { nodeId: string; title: string };

function titleOf(node: KnowledgeNode, overrides: Map<string, string>) {
  return overrides.get(node.id) ?? node.title ?? "";
}

function childrenOf(nodes: KnowledgeNode[]) {
  const children = new Map<string, KnowledgeNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.order - b.order);
  return children;
}

function subtree(root: KnowledgeNode, children: Map<string, KnowledgeNode[]>) {
  const ordered: KnowledgeNode[] = [];
  const pending = [...(children.get(root.id) ?? [])];
  const seen = new Set<string>([root.id]);
  while (pending.length > 0) {
    const node = pending.shift();
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    ordered.push(node);
    pending.unshift(...(children.get(node.id) ?? []));
  }
  return ordered;
}

function supportChars(nodes: KnowledgeNode[], spans: Map<string, SourceSpan>) {
  return nodes.reduce((total, node) => {
    const span = spans.get(node.spanId);
    return total + (span ? span.end - span.start : 0);
  }, 0);
}

function sensitive(title: string, excerpts: string[]) {
  return SENSITIVE.test(title) || excerpts.some((excerpt) => SENSITIVE.test(excerpt));
}

function classify(input: {
  method: TopicCandidateRecord["detectionMethod"];
  chars: number;
  extraction: TopicExtraction;
  flagged: boolean;
  cleared: boolean;
  unsafe: boolean;
  corrected: boolean;
}) {
  const reasons: TopicReasonCode[] = [];
  const { lengths } = TOPIC_RANKING;
  if (input.method === "explicit-heading") reasons.push("clear-heading");
  if (input.method === "document-structure") reasons.push("chapter-boundary");
  if (input.method === "bounded-text") reasons.push("missing-heading");
  if (input.corrected) reasons.push("creator-corrected");
  if (input.extraction.status === "partial") reasons.push("partial-extraction");
  if (input.extraction.issues.some((issue) => issue.code === "ambiguous-structure" || issue.code === "no-heading-style")) {
    reasons.push("ambiguous-structure");
  }
  if (input.extraction.issues.some((issue) => issue.code === "unreadable-page")) reasons.push("missing-context");
  if (input.flagged) reasons.push("sensitive-domain");
  if (input.unsafe) reasons.push("unsafe-title");
  if (input.chars < lengths.short) reasons.push("short-span");
  else if (input.chars > lengths.broad) reasons.push("broad-span");
  else reasons.push("lesson-sized");

  const tooBroadForALesson = input.method === "bounded-text" && input.chars > lengths.focusedMax;
  const blocked =
    input.unsafe ||
    (input.flagged && !input.cleared) ||
    input.extraction.status !== "complete" ||
    tooBroadForALesson ||
    reasons.includes("ambiguous-structure") ||
    reasons.includes("missing-context") ||
    reasons.includes("short-span") ||
    reasons.includes("broad-span");

  let eligibility: TopicCandidateRecord["eligibility"] = "eligible";
  if (input.chars < lengths.short || input.unsafe) eligibility = "insufficient-support";
  else if (blocked || input.chars < lengths.eligible) eligibility = "needs-review";
  return { eligibility, reasons: [...new Set(reasons)] };
}

function suitability(candidate: TopicCandidateRecord, extractionComplete: boolean) {
  if (candidate.eligibility !== "eligible") return null;
  const { weights, lengths } = TOPIC_RANKING;
  let score = candidate.eligibility === "eligible" ? weights.eligible : 0;
  if (candidate.detectionMethod === "explicit-heading") score += weights.explicitHeading;
  if (candidate.detectionMethod === "document-structure") score += weights.documentStructure;
  if (candidate.detectionMethod === "bounded-text") score += weights.boundedText;
  if (candidate.supportChars <= lengths.focusedMax) score += weights.focusedLength;
  else if (candidate.supportChars <= lengths.broad) score += weights.wideLength;
  else score += weights.usableLength;
  if (extractionComplete) score += weights.completeExtraction;
  if (candidate.reasons.includes("missing-context")) score += weights.missingContext;
  return score;
}

function clip(title: string) {
  const clean = title.replace(/\s+/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

function recommendationCopy(input: {
  status: TopicDecision["status"];
  title: string | null;
  reasons: TopicReasonCode[];
  ageBand: AgeBand;
  rightsStatus: "unverified" | "cleared" | "blocked";
}) {
  const notes: string[] = [];
  if (input.ageBand === "unspecified") notes.push("The age band is unspecified.");
  if (input.rightsStatus === "unverified") notes.push("Source rights are not cleared.");
  if (input.reasons.includes("review-required")) {
    return "A heading or short excerpt matched a high-risk subject. This is not a safety screening of the whole source. A person must review it before generation can be authorized. Nothing was generated.";
  }
  notes.push("Only headings and short excerpts were scanned.");
  if (input.reasons.includes("sensitive-domain")) notes.push("An independent source clearance is recorded. Generation is still not authorized.");
  const note = notes.length > 0 ? ` ${notes.join(" ")}` : "";
  if (input.status === "recommended" && input.title) {
    return `Start with “${clip(input.title)}”. It has a clear source boundary and enough text for one focused experience. This is not a finished game and has not been checked as educationally effective.${note}`;
  }
  if (input.reasons.includes("rights-blocked")) return "Source rights are blocked, so no topic can be recommended. Nothing was generated.";
  if (input.reasons.includes("unreadable-source")) return "The source could not be read, so no topic can be recommended. Nothing was generated.";
  if (input.status === "needs-creator-selection") {
    return `No topic was selected automatically. Explore the list and choose one. Nothing was generated.${note}`;
  }
  return `This source does not have enough reliable text to recommend a starting topic. Nothing was generated.${note}`;
}

function candidateFrom(input: {
  node: KnowledgeNode;
  related: KnowledgeNode[];
  spans: Map<string, SourceSpan>;
  extraction: TopicExtraction;
  method: TopicCandidateRecord["detectionMethod"];
  title: string;
  corrected: boolean;
  excerpts: ReadonlyMap<string, string>;
  sourceOrder: number;
  cleared: boolean;
}) {
  const nodes = [input.node, ...input.related];
  const spanIds = [...new Set(nodes.map((node) => node.spanId))];
  const chars = supportChars(nodes, input.spans);
  const excerptText = spanIds.flatMap((id) => {
    const excerpt = input.excerpts.get(id);
    return excerpt ? [excerpt] : [];
  });
  const uncertain = input.method === "bounded-text" || input.node.headingCertainty !== "reliable";
  const judged = classify({
    method: input.method,
    chars,
    extraction: input.extraction,
    flagged: sensitive(input.title, excerptText),
    cleared: input.cleared,
    unsafe: UNSAFE.test(input.title),
    corrected: input.corrected,
  });
  return TopicCandidate.parse({
    contract: "TOPIC-CANDIDATE-v1",
    id: randomUUID(),
    collectionId: input.node.collectionId,
    documentVersionId: input.node.documentVersionId,
    extractionId: input.extraction.id,
    workspaceId: input.node.workspaceId,
    primaryNodeId: input.node.id,
    nodeIds: nodes.map((node) => node.id),
    sourceSpanIds: spanIds,
    title: input.title,
    sourceOrder: input.sourceOrder,
    detectionMethod: input.method,
    detectionVersion: TOPIC_DETECTION_VERSION,
    confidence: null,
    uncertainty: uncertain ? "uncertain" : "stated",
    eligibility: judged.eligibility,
    reasons: judged.reasons,
    supportChars: chars,
    educationalValidation: "none",
  });
}

export function analyzeTopics(input: {
  nodes: KnowledgeNode[];
  spans: SourceSpan[];
  extraction: TopicExtraction;
  canonicalTextLength: number;
  audienceLabel: string;
  ageBand: AgeBand;
  rightsStatus: "unverified" | "cleared" | "blocked";
  excerpts?: ReadonlyMap<string, string>;
  overrides?: HeadingOverride[];
  safetyClearance?: IndependentSourceClearance | null;
}): TopicDecision {
  const safetyClearance = acceptedClearance(input.safetyClearance) ? "independent-validation" as const : "none" as const;
  const cleared = safetyClearance === "independent-validation";
  if (!input.audienceLabel.trim()) throw new SourceError("invalid-topic");
  const runReasons: TopicReasonCode[] = [];
  if (input.ageBand === "unspecified") runReasons.push("age-unspecified");
  if (input.rightsStatus === "unverified") runReasons.push("rights-unverified");
  if (input.rightsStatus === "blocked") runReasons.push("rights-blocked");
  if (input.extraction.status === "failed" || input.rightsStatus === "blocked") {
    if (input.extraction.status === "failed") runReasons.push("unreadable-source");
    const reason = recommendationCopy({
      status: "insufficient-support",
      title: null,
      reasons: runReasons,
      ageBand: input.ageBand,
      rightsStatus: input.rightsStatus,
    });
    return {
      understood: input.extraction.status === "failed" ? "unreadable" : input.extraction.status === "partial" ? "partial" : "full",
      candidates: [],
      status: "insufficient-support",
      topicCandidateId: null,
      reason: reason.slice(0, 400),
      reasons: runReasons,
      sourceSpanIds: [],
      processedChars: input.canonicalTextLength,
      sensitivityScreen: "not-run",
      safetyClearance,
      generationAuthorized: false,
    };
  }

  const nodes = [...input.nodes].sort((a, b) => a.order - b.order);
  const spans = new Map(input.spans.map((span) => [span.id, span]));
  const excerpts = input.excerpts ?? new Map<string, string>();
  const overrides = new Map((input.overrides ?? []).map((override) => [override.nodeId, override.title.trim()]));
  const document = nodes.find((node) => node.kind === "document");
  if (!document) throw new SourceError("invalid-topic");
  for (const node of nodes) {
    if (node.collectionId !== document.collectionId || node.workspaceId !== document.workspaceId) {
      throw new SourceError("invalid-topic");
    }
    if (node.documentVersionId !== document.documentVersionId) throw new SourceError("invalid-topic");
    if (!spans.has(node.spanId)) throw new SourceError("invalid-topic");
  }

  const children = childrenOf(nodes);
  const chapters = nodes.filter((node) => node.kind === "chapter" && node.headingCertainty === "reliable" && titleOf(node, overrides));
  const sections = nodes.filter((node) => node.kind === "section" && node.headingCertainty === "reliable" && titleOf(node, overrides));
  const drafted: TopicCandidateRecord[] = [];
  const usedSections = new Set<string>();

  for (const chapter of chapters) {
    const nested = sections.filter((section) => section.parentId === chapter.id);
    if (nested.length > 0) {
      for (const section of nested) {
        usedSections.add(section.id);
        const related = subtree(section, children).filter((node) => node.kind === "block");
        drafted.push(candidateFrom({
          node: section,
          related,
          spans,
          extraction: input.extraction,
          method: "explicit-heading",
          title: titleOf(section, overrides),
          corrected: overrides.has(section.id),
          excerpts,
          cleared,
          sourceOrder: section.order,
        }));
      }
      const usable = drafted.filter((candidate) => nested.some((section) => section.id === candidate.primaryNodeId) && candidate.eligibility !== "insufficient-support");
      if (usable.length === 0) {
        drafted.push(candidateFrom({
          node: chapter,
          related: subtree(chapter, children).filter((node) => node.kind !== "document"),
          spans,
          extraction: input.extraction,
          method: "document-structure",
          title: titleOf(chapter, overrides),
          corrected: overrides.has(chapter.id),
          excerpts,
          cleared,
          sourceOrder: chapter.order,
        }));
      }
    } else {
      drafted.push(candidateFrom({
        node: chapter,
        related: subtree(chapter, children).filter((node) => node.kind === "block"),
        spans,
        extraction: input.extraction,
        method: "document-structure",
        title: titleOf(chapter, overrides),
        corrected: overrides.has(chapter.id),
        excerpts,
        cleared,
        sourceOrder: chapter.order,
      }));
    }
  }

  for (const section of sections) {
    if (usedSections.has(section.id)) continue;
    drafted.push(candidateFrom({
      node: section,
      related: subtree(section, children).filter((node) => node.kind === "block"),
      spans,
      extraction: input.extraction,
      method: "explicit-heading",
      title: titleOf(section, overrides),
      corrected: overrides.has(section.id),
      excerpts,
      cleared,
      sourceOrder: section.order,
    }));
  }

  if (drafted.length === 0) {
    const blocks = nodes.filter((node) => node.kind === "block");
    drafted.push(candidateFrom({
      node: document,
      related: blocks,
      spans,
      extraction: input.extraction,
      method: "bounded-text",
      title: "Untitled source",
      corrected: false,
      excerpts,
      cleared,
      sourceOrder: 0,
    }));
  }

  const candidates = drafted.sort((a, b) => a.sourceOrder - b.sourceOrder || a.id.localeCompare(b.id));
  const complete = input.extraction.status === "complete";
  const ranked = candidates
    .map((candidate) => ({ candidate, score: suitability(candidate, complete) }))
    .filter((item): item is { candidate: TopicCandidateRecord; score: number } => item.score !== null)
    .sort((a, b) => b.score - a.score || a.candidate.sourceOrder - b.candidate.sourceOrder || a.candidate.id.localeCompare(b.candidate.id));

  let status: TopicDecision["status"] = "insufficient-support";
  let winner: TopicCandidateRecord | null = null;
  const lead = ranked[0];
  const next = ranked[1];
  if (lead && (!next || lead.score - next.score >= TOPIC_RANKING.clearMargin)) {
    status = "recommended";
    winner = lead.candidate;
  } else if (ranked.length > 1 || candidates.some((candidate) => candidate.eligibility === "needs-review")) {
    status = "needs-creator-selection";
  }
  const highRisk = candidates.some((candidate) => candidate.reasons.includes("sensitive-domain"));
  if (highRisk && !cleared) {
    status = "needs-creator-selection";
    winner = null;
    runReasons.push("review-required");
  }
  runReasons.push("partial-sensitivity-screen");

  const siblingConcerns = candidates.flatMap((candidate) => candidate.reasons);
  const decisionReasons = [...new Set([
    ...runReasons,
    ...(winner ? winner.reasons : siblingConcerns),
    ...(!winner && siblingConcerns.includes("sensitive-domain") ? ["sensitive-domain" as const] : []),
  ])];
  const reason = recommendationCopy({
    status,
    title: winner?.title ?? null,
    reasons: decisionReasons,
    ageBand: input.ageBand,
    rightsStatus: input.rightsStatus,
  }).slice(0, 400);
  const structuralGap = winner ? winner.uncertainty === "uncertain" : candidates.some((candidate) => candidate.uncertainty === "uncertain");
  const understood = input.extraction.status === "partial" || structuralGap ? "partial" : "full";
  return {
    understood,
    candidates,
    status,
    topicCandidateId: winner?.id ?? null,
    reason,
    reasons: decisionReasons,
    sourceSpanIds: winner?.sourceSpanIds ?? [],
    processedChars: input.canonicalTextLength,
    sensitivityScreen: "title-and-excerpt",
    safetyClearance,
    generationAuthorized: false,
  };
}

function acceptedClearance(value: IndependentSourceClearance | null | undefined) {
  const reference = value?.reference.trim() ?? "";
  return Boolean(
    value
    && value.scope === "source"
    && value.method === "independent-validation"
    && reference.length >= 8
    && reference.length <= 80
    && !SENSITIVE.test(reference)
    && !UNSAFE.test(reference),
  );
}
