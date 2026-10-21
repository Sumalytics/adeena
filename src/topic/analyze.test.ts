import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FirstExperienceRecommendation } from "@/contracts/topic";
import { buildKnowledge } from "@/source/knowledge";
import type { ExtractedBlock } from "@/source/extract-text";
import { SourceError } from "@/source/errors";
import { analyzeTopics, SENSITIVITY_SCREEN, TOPIC_RANKING } from "./analyze";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const documentVersionId = "22222222-2222-4222-8222-222222222222";
const extractionId = "33333333-3333-4333-8333-333333333333";
const lesson = "Learners compare two careful choices and explain the result using only this passage. ".repeat(6);

function chapter(title: string, certainty: ExtractedBlock["headingCertainty"] = "reliable"): ExtractedBlock {
  return { kind: "chapter", text: title, title, headingCertainty: certainty, page: null };
}

function section(title: string, certainty: ExtractedBlock["headingCertainty"] = "reliable"): ExtractedBlock {
  return { kind: "section", text: title, title, headingCertainty: certainty, page: null };
}

function paragraph(text: string): ExtractedBlock {
  return { kind: "block", text, title: null, headingCertainty: "none", page: null };
}

function decide(
  blocks: ExtractedBlock[],
  extra: {
    status?: "complete" | "partial" | "failed";
    issues?: { code: string }[];
    ageBand?: "8-10" | "unspecified";
    rightsStatus?: "unverified" | "cleared" | "blocked";
    safetyClearance?: { scope: "source"; method: "independent-validation"; reference: string } | null;
    excerpts?: Map<string, string>;
    overrides?: { nodeId: string; title: string }[];
    nodes?: ReturnType<typeof buildKnowledge>["nodes"];
    spans?: ReturnType<typeof buildKnowledge>["spans"];
  } = {},
) {
  const knowledge = buildKnowledge({ documentVersionId, workspaceId, extracted: blocks });
  return {
    knowledge,
    decision: analyzeTopics({
      nodes: extra.nodes ?? knowledge.nodes,
      spans: extra.spans ?? knowledge.spans,
      extraction: { id: extractionId, status: extra.status ?? "complete", issues: extra.issues ?? [] },
      canonicalTextLength: knowledge.canonical.text.length,
      audienceLabel: "Primary learners",
      ageBand: extra.ageBand ?? "8-10",
      rightsStatus: extra.rightsStatus ?? "unverified",
      safetyClearance: extra.safetyClearance,
      excerpts: extra.excerpts,
      overrides: extra.overrides,
    }),
  };
}

describe("topic detection and first recommendation", () => {
  it("recommends one heading in a single-topic lesson", () => {
    const { decision } = decide([
      chapter("Rivers"),
      paragraph(lesson),
    ]);
    expect(decision.status).toBe("recommended");
    expect(decision.candidates.map((candidate) => candidate.title)).toEqual(["Rivers"]);
    expect(decision.topicCandidateId).toBe(decision.candidates[0]?.id);
    expect(decision.sourceSpanIds.length).toBeGreaterThan(0);
    expect(decision.reason).toContain("Start with");
    expect(decision.reason).toContain("not a finished game");
    expect(decision.reason).toContain("short excerpts");
    expect(decision.sensitivityScreen).toBe("title-and-excerpt");
    expect(decision.generationAuthorized).toBe(false);
    expect(decision.reason).not.toMatch(/\d+%/);
  });

  it("keeps several sections available when none is a clear winner", () => {
    const { decision } = decide([
      chapter("Tools"),
      section("Hammer"),
      paragraph(lesson),
      section("Saw"),
      paragraph(lesson),
    ]);
    expect(decision.status).toBe("needs-creator-selection");
    expect(decision.topicCandidateId).toBeNull();
    expect(decision.candidates.map((candidate) => candidate.title)).toEqual(["Hammer", "Saw"]);
    expect(decision.candidates[0]?.sourceOrder).toBeLessThan(decision.candidates[1]?.sourceOrder ?? 0);
  });

  it("does not prefer the first chapter when a later section is the supported topic", () => {
    const { decision } = decide([
      chapter("Opening"),
      section("Label"),
      paragraph("Too small."),
      chapter("Practice"),
      section("Clouds"),
      paragraph(lesson),
    ]);
    expect(decision.status).toBe("recommended");
    expect(decision.candidates.find((candidate) => candidate.id === decision.topicCandidateId)?.title).toBe("Clouds");
  });

  it("uses a curriculum heading and a training heading as explicit topics", () => {
    const curriculum = decide([
      chapter("Map course"),
      section("Learning objective: Read a map"),
      paragraph(lesson),
    ]);
    const manual = decide([
      chapter("Shift handover"),
      section("Close the workshop"),
      paragraph(lesson),
    ]);
    expect(curriculum.decision.status).toBe("recommended");
    expect(curriculum.decision.candidates[0]?.detectionMethod).toBe("explicit-heading");
    expect(manual.decision.candidates[0]?.title).toBe("Close the workshop");
  });

  it("treats a headingless lesson as one bounded topic and refuses an ambiguous outline", () => {
    const plain = decide([paragraph(lesson)]);
    expect(plain.decision.candidates).toHaveLength(1);
    expect(plain.decision.candidates[0]).toMatchObject({
      title: "Untitled source",
      detectionMethod: "bounded-text",
      confidence: null,
    });
    expect(plain.decision.status).toBe("recommended");
    const ambiguous = decide(
      [paragraph(`Chapter 1\n\n${lesson}`)],
      { status: "partial", issues: [{ code: "ambiguous-structure" }] },
    );
    expect(ambiguous.decision.status).toBe("needs-creator-selection");
    expect(ambiguous.decision.topicCandidateId).toBeNull();
  });

  it("refuses a partial page, an unreadable source, a short heading, and blocked rights", () => {
    const partial = decide(
      [section("Diagram"), paragraph(lesson)],
      { status: "partial", issues: [{ code: "unreadable-page" }] },
    );
    expect(partial.decision.status).toBe("needs-creator-selection");
    expect(partial.decision.candidates[0]?.reasons).toContain("missing-context");
    const unreadable = analyzeTopics({
      nodes: [],
      spans: [],
      extraction: { id: extractionId, status: "failed", issues: [] },
      canonicalTextLength: 0,
      audienceLabel: "Primary learners",
      ageBand: "8-10",
      rightsStatus: "unverified",
    });
    expect(unreadable).toMatchObject({ status: "insufficient-support", topicCandidateId: null, understood: "unreadable" });
    const short = decide([section("Note"), paragraph("Hi")]);
    expect(short.decision.status).toBe("insufficient-support");
    const blocked = decide([section("Rivers"), paragraph(lesson)], { rightsStatus: "blocked" });
    expect(blocked.decision.reason).toContain("rights are blocked");
    expect(blocked.decision.candidates).toHaveLength(0);
  });

  it("requires review for high-risk signals and does not treat the scan as complete", () => {
    const medical = decide([section("Dosage safety"), paragraph(lesson)]);
    const safeguarding = decide([section("Child protection duties"), paragraph(lesson)]);
    const regulated = decide([section("Regulated conduct"), paragraph(lesson)]);
    for (const result of [medical, safeguarding, regulated]) {
      expect(result.decision.status).toBe("needs-creator-selection");
      expect(result.decision.topicCandidateId).toBeNull();
      expect(result.decision.reasons).toContain("review-required");
      expect(result.decision.reasons).toContain("partial-sensitivity-screen");
      expect(result.decision.generationAuthorized).toBe(false);
      expect(result.decision.reason).toContain("not a safety screening");
    }
    const hidden = decide([section("Rivers"), paragraph(lesson)]);
    const excerptOnly = analyzeTopics({
      nodes: hidden.knowledge.nodes,
      spans: hidden.knowledge.spans,
      extraction: { id: extractionId, status: "complete", issues: [] },
      canonicalTextLength: hidden.knowledge.canonical.text.length,
      audienceLabel: "Primary learners",
      ageBand: "8-10",
      rightsStatus: "unverified",
      excerpts: new Map(hidden.knowledge.spans.map((span) => [span.id, "Learners compare a dosage record with the source note."])),
    });
    expect(excerptOnly.reasons).toContain("review-required");
    const clearedRights = decide([section("Clinical handover"), paragraph(lesson)], { rightsStatus: "cleared" });
    expect(clearedRights.decision.safetyClearance).toBe("none");
    expect(clearedRights.decision.topicCandidateId).toBeNull();
    const mixed = decide([
      section("Rivers"),
      paragraph(lesson),
      section("Safeguarding note"),
      paragraph(lesson),
    ]);
    expect(mixed.decision.topicCandidateId).toBeNull();
    expect(mixed.decision.status).toBe("needs-creator-selection");
  });

  it("keeps generation unauthorized when an independent source clearance exists", () => {
    const { decision } = decide([section("Medication review"), paragraph(lesson)], {
      safetyClearance: {
        scope: "source",
        method: "independent-validation",
        reference: "review-board-2026-014",
      },
    });
    expect(decision.safetyClearance).toBe("independent-validation");
    expect(decision.status).toBe("recommended");
    expect(decision.generationAuthorized).toBe(false);
    expect(decision.reason).toContain("not authorized");
  });

  it("does not see a high-risk phrase that sits past the excerpt window", () => {
    const built = decide([section("Rivers"), paragraph(`${"Learners compare two careful choices. ".repeat(20)}dosage record`)]);
    const spanId = built.decision.candidates[0]?.sourceSpanIds.at(-1) ?? "";
    const full = built.knowledge.canonical.text;
    const excerpt = full.slice(0, SENSITIVITY_SCREEN.excerptChars);
    expect(excerpt.toLowerCase()).not.toContain("dosage");
    const screened = analyzeTopics({
      nodes: built.knowledge.nodes,
      spans: built.knowledge.spans,
      extraction: { id: extractionId, status: "complete", issues: [] },
      canonicalTextLength: full.length,
      audienceLabel: "Primary learners",
      ageBand: "8-10",
      rightsStatus: "unverified",
      excerpts: new Map([[spanId, excerpt]]),
    });
    expect(screened.reasons).not.toContain("review-required");
    expect(screened.sensitivityScreen).toBe("title-and-excerpt");
    expect(SENSITIVITY_SCREEN.comprehensive).toBe(false);
  });

  it("repeats the same ranking and keeps tie order stable", () => {
    const blocks = [chapter("Tools"), section("Hammer"), paragraph(lesson), section("Saw"), paragraph(lesson)];
    const first = decide(blocks).decision;
    const second = decide(blocks).decision;
    expect(first.status).toBe(second.status);
    expect(first.candidates.map((candidate) => [candidate.title, candidate.sourceOrder, candidate.eligibility])).toEqual(
      second.candidates.map((candidate) => [candidate.title, candidate.sourceOrder, candidate.eligibility]),
    );
    expect(TOPIC_RANKING.clearMargin).toBe(15);
    expect(TOPIC_RANKING.weights.explicitHeading).toBeGreaterThan(TOPIC_RANKING.weights.boundedText);
  });

  it("applies a heading correction without changing the extracted node", () => {
    const built = decide([section("Wrnog title"), paragraph(lesson)]);
    const nodeId = built.decision.candidates[0]?.primaryNodeId ?? "";
    const corrected = analyzeTopics({
      nodes: built.knowledge.nodes,
      spans: built.knowledge.spans,
      extraction: { id: extractionId, status: "complete", issues: [] },
      canonicalTextLength: built.knowledge.canonical.text.length,
      audienceLabel: "Primary learners",
      ageBand: "8-10",
      rightsStatus: "unverified",
      overrides: [{ nodeId, title: "River speed" }],
    });
    expect(corrected.candidates[0]?.title).toBe("River speed");
    expect(corrected.candidates[0]?.reasons).toContain("creator-corrected");
    expect(corrected.status).toBe("recommended");
    expect(built.knowledge.nodes.find((node) => node.id === nodeId)?.title).toBe("Wrnog title");
  });

  it("rejects a node that crosses a workspace or source version", () => {
    const { knowledge } = decide([section("Rivers"), paragraph(lesson)]);
    const crossed = knowledge.nodes.map((node, index) => index === 0 ? { ...node, workspaceId: randomUUID() } : node);
    expect(() => analyzeTopics({
      nodes: crossed,
      spans: knowledge.spans,
      extraction: { id: extractionId, status: "complete", issues: [] },
      canonicalTextLength: knowledge.canonical.text.length,
      audienceLabel: "Primary learners",
      ageBand: "8-10",
      rightsStatus: "unverified",
    })).toThrow(SourceError);
    const otherVersion = knowledge.nodes.map((node, index) => index === 1 ? { ...node, documentVersionId: randomUUID() } : node);
    expect(() => analyzeTopics({
      nodes: otherVersion,
      spans: knowledge.spans,
      extraction: { id: extractionId, status: "complete", issues: [] },
      canonicalTextLength: knowledge.canonical.text.length,
      audienceLabel: "Primary learners",
      ageBand: "8-10",
      rightsStatus: "unverified",
    })).toThrow(SourceError);
  });

  it("records no experience version and no paid generation flag", () => {
    const { decision } = decide([section("Rivers"), paragraph(lesson)]);
    const recommendation = FirstExperienceRecommendation.parse({
      contract: "FIRST-RECOMMENDATION-v1",
      id: randomUUID(),
      collectionId: decision.candidates[0]?.collectionId,
      documentVersionId,
      extractionId,
      workspaceId,
      topicCandidateId: decision.topicCandidateId,
      audienceLabel: "Primary learners",
      ageBand: "unspecified",
      status: decision.status,
      reason: decision.reason,
      reasons: decision.reasons.includes("age-unspecified") ? decision.reasons : [...decision.reasons, "age-unspecified"],
      sourceSpanIds: decision.sourceSpanIds,
      understood: decision.understood,
      candidateCount: decision.candidates.length,
      processedChars: decision.processedChars,
      durationMs: 1,
      failureCount: 0,
      detectionVersion: "1",
      overrideVersion: 0,
      generatesExperience: false,
      experienceVersionId: null,
      aiGenerationAuthorized: false,
      sensitivityScreen: decision.sensitivityScreen,
      safetyClearance: decision.safetyClearance,
      educationalValidation: "none",
    });
    expect(recommendation.generatesExperience).toBe(false);
    expect(recommendation.experienceVersionId).toBeNull();
    expect(recommendation.aiGenerationAuthorized).toBe(false);
  });

  it("analyzes a larger structured source quickly", () => {
    const blocks: ExtractedBlock[] = [chapter("Textbook")];
    for (let index = 0; index < 40; index += 1) {
      blocks.push(section(`Section ${index + 1}`), paragraph(lesson));
    }
    const started = performance.now();
    const { decision } = decide(blocks);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(decision.candidates.length).toBe(40);
    expect(decision.status).toBe("needs-creator-selection");
    expect(decision.topicCandidateId).toBeNull();
  });
});
