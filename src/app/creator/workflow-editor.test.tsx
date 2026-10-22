import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TopicRecommendationView } from "@/topic/public";
import { WorkflowEditor } from "./workflow-editor";
import { topicSavePlan, workflowUpdateFailure, type CreatorWorkflowView } from "./workflow-state";

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
  it("restores the saved topic and does not start generation", () => {
    const html = renderToStaticMarkup(
      <WorkflowEditor
        workflow={workflow}
        sources={[{
          documentVersionId: workflow.documentVersionId ?? "",
          filename: "rivers.md",
          extractionStatus: "complete",
          rightsStatus: "unverified",
          byteCount: 128,
        }]}
        recommendation={recommendation}
      />,
    );
    expect(html).toContain("Selected topic: Rivers");
    expect(html).toContain("Create playable experience");
    expect(html).toContain("Development fixture");
    expect(html).toContain("not live AI generation");
    expect(html).toContain("Public sharing is not available yet.");
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
    expect(html).toContain("Your experience is ready.");
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
});
