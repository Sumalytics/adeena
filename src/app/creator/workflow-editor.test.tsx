import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TopicRecommendationView } from "@/topic/public";
import { WorkflowEditor } from "./workflow-editor";
import { topicGenerationGate, topicRecommendationFailureCopy, topicSavePlan, workflowUpdateFailure, type CreatorWorkflowView } from "./workflow-state";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
}));

const workflow: CreatorWorkflowView = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  version: 3,
  documentVersionId: "33333333-3333-4333-8333-333333333333",
  audienceLabel: "Primary learners",
  ageBand: "8-10",
  recommendationRunId: "44444444-4444-4444-8444-444444444444",
  recommendationIdempotencyKey: null,
  selectedTopicCandidateId: "55555555-5555-4555-8555-555555555555",
  generationIdempotencyKey: null,
  generationJobId: null,
  experienceVersionId: null,
};

const recommendation = {
  recommendation: {
    id: "44444444-4444-4444-8444-444444444444",
    status: "recommended",
    reason: "Rivers is a clear starting topic.",
    topicTitle: "Rivers",
    topicCandidateId: "55555555-5555-4555-8555-555555555555",
    understood: "full",
    generatesExperience: false,
    experienceVersionId: null,
    aiGenerationAuthorized: false,
    sensitivityScreen: "title-and-excerpt",
    safetyClearance: "none",
    candidateCount: 1,
    processedChars: 20,
    durationMs: 1,
    failureCount: 0,
    detectionVersion: "1",
    overrideVersion: 0,
    replayed: false,
  },
  candidates: [{
    id: "55555555-5555-4555-8555-555555555555",
    title: "Rivers",
    sourceOrder: 0,
    detectionMethod: "explicit-heading",
    uncertainty: "stated",
    eligibility: "eligible",
    reasons: [],
    primaryNodeId: "66666666-6666-4666-8666-666666666666",
    supportChars: 180,
  }],
  page: { offset: 0, limit: 12, total: 1 },
} as TopicRecommendationView;

describe("creator workflow screen", () => {
  it("shows only the first required stage for a new experience", () => {
    const html = renderToStaticMarkup(
      <WorkflowEditor
        workflow={{ ...workflow, version: 1, documentVersionId: null, audienceLabel: null, ageBand: null, selectedTopicCandidateId: null }}
        sources={[]}
        recommendation={null}
      />,
    );
    expect(html).toContain("Step 1 of 4");
    expect(html).toContain("Add your content");
    expect(html).toContain("Upload new content");
    expect(html).not.toContain("Who will play?");
    expect(html).not.toContain("What should the game teach?");
    expect(html).not.toContain("Create your playable game");
  });

  it("restores the saved topic and does not start generation", () => {
    const html = renderToStaticMarkup(
      <WorkflowEditor
        workflow={workflow}
        sources={[{
          documentVersionId: workflow.documentVersionId ?? "",
          filename: "rivers.md",
          extractionStatus: "complete",
          rightsStatus: "unverified",
          permissionDeclared: true,
          byteCount: 128,
        }]}
        recommendation={recommendation}
      />,
    );
    expect(html).toContain("Your choices");
    expect(html).toContain("Rivers");
    expect(html).toContain("Generate my experience");
    expect(html).toContain("deterministic fixture");
    expect(html).toContain("Step 4 of 4");
    expect(html).toContain("rivers.md");
    expect(html).not.toContain("/api/creator/experiences");
    const source = readFileSync("src/app/creator/workflow-editor.tsx", "utf8");
    expect(source).not.toContain("/api/creator/experiences");
  });

  it("shows a finished private draft", () => {
    const html = renderToStaticMarkup(
      <WorkflowEditor
        workflow={{ ...workflow, experienceVersionId: "77777777-7777-4777-8777-777777777777" }}
        sources={[]}
        recommendation={recommendation}
        generation={{
          jobId: "88888888-8888-4888-8888-888888888888",
          status: "ready",
          experienceVersionId: "77777777-7777-4777-8777-777777777777",
          failureCode: null,
          previewPath: "/creator/preview/77777777-7777-4777-8777-777777777777",
          liveModel: false,
        }}
      />,
    );
    expect(html).toContain("Your game is ready");
    expect(html).toContain("Play your private draft");
    expect(html).toContain("/creator/preview/77777777-7777-4777-8777-777777777777");
  });

  it("resolves only an automatically recommended topic", () => {
    expect(topicSavePlan(recommendation)).toBe("resolve");
    expect(topicSavePlan({
      ...recommendation,
      recommendation: recommendation.recommendation
        ? { ...recommendation.recommendation, status: "needs-creator-selection", topicCandidateId: null, topicTitle: null }
        : null,
    })).toBe("choose");
    expect(topicSavePlan(null)).toBe("unavailable");
    expect(workflowUpdateFailure(409)).toMatchObject({ stale: true });
  });

  it("allows a safe selected topic from a mixed document and explains unavailable topics", () => {
    const mixed = {
      ...recommendation,
      recommendation: recommendation.recommendation
        ? { ...recommendation.recommendation, status: "needs-creator-selection" as const, topicCandidateId: null, topicTitle: null }
        : null,
      candidates: [
        ...recommendation.candidates,
        {
          ...recommendation.candidates[0],
          id: "77777777-7777-4777-8777-777777777777",
          title: "Safeguarding duties",
          eligibility: "needs-review" as const,
          reasons: ["sensitive-domain"],
        },
      ],
    };
    const html = renderToStaticMarkup(<WorkflowEditor workflow={{ ...workflow, selectedTopicCandidateId: null }} sources={[{
      documentVersionId: workflow.documentVersionId ?? "",
      filename: "rivers.md",
      extractionStatus: "complete",
      rightsStatus: "unverified",
      permissionDeclared: true,
      byteCount: 128,
    }]} recommendation={mixed} />);
    expect(html).toContain("Suggested topic");
    expect(html).toContain("Use this topic");
    expect(html).toContain("Choose a different topic");
    expect(html).toContain("high-risk material");
    expect(html).toContain("Choose a different eligible topic");
    expect(html).not.toContain("A person needs to review them first");
    expect(topicGenerationGate(mixed.candidates[0]).allowed).toBe(true);
    expect(topicGenerationGate(mixed.candidates[1])).toMatchObject({ allowed: false });
  });

  it("offers recovery for unsupported source material", () => {
    const unsupported = { ...recommendation.candidates[0], eligibility: "insufficient-support" as const, reasons: ["short-span"] };
    expect(topicGenerationGate(unsupported)).toEqual({
      allowed: false,
      message: "This topic does not have enough source support. Choose a fuller section or upload a more complete source.",
    });
  });

  it("returns a pending saved source to processing instead of enabling topic work", () => {
    const html = renderToStaticMarkup(<WorkflowEditor workflow={{ ...workflow, selectedTopicCandidateId: null }} sources={[{
      documentVersionId: workflow.documentVersionId ?? "",
      filename: "still-processing.md",
      extractionStatus: "pending",
      rightsStatus: "unverified",
      permissionDeclared: true,
      byteCount: 128,
    }]} recommendation={null} />);
    expect(html).toContain("Add your content");
    expect(html).toContain("Continue processing");
    expect(html).not.toContain("Suggest a topic");
    expect(topicRecommendationFailureCopy("invalid-topic")).toContain("finish processing");
  });
});
