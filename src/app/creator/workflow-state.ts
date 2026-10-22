import type { TopicRecommendationView } from "@/topic/public";

export type CreatorWorkflowView = {
  id: string;
  workspaceId: string;
  version: number;
  documentVersionId: string | null;
  audienceLabel: string | null;
  ageBand: string | null;
  recommendationRunId: string | null;
  recommendationIdempotencyKey: string | null;
  selectedTopicCandidateId: string | null;
  generationIdempotencyKey: string | null;
  generationJobId: string | null;
  experienceVersionId: string | null;
};

export function topicSavePlan(view: TopicRecommendationView | null): "resolve" | "choose" | "unavailable" {
  const recommendation = view?.recommendation;
  if (!recommendation) return "unavailable";
  if (recommendation.status === "recommended" && recommendation.topicCandidateId) return "resolve";
  if (recommendation.status === "needs-creator-selection") return "choose";
  return "unavailable";
}

const GENERATION_COPY: Record<string, string> = {
  "generation-unavailable": "AI generation is not configured. No experience was created.",
  "budget-unavailable": "Generation spending is not authorized. No experience was created.",
  "review-required": "This source needs review before an experience can be created.",
  "rights-blocked": "Source rights are blocked, so no experience was created.",
  "insufficient-source": "This topic does not have enough source support for a playable experience.",
  "invalid-experience": "The generated experience did not pass validation.",
  "invalid-generation": "That generation request could not be accepted.",
  "invalid-workflow": "That generation request could not be accepted.",
  "stale-extraction": "The source extraction changed. Recommend the topic again before creating an experience.",
  "cross-workspace": "That source belongs to another workspace.",
  "generation-denied": "This source cannot be used to generate an experience.",
};

export type WorkflowGenerationState = {
  jobId: string;
  status: "queued" | "planning" | "compiling" | "validating" | "ready" | "failed" | "cancelled";
  experienceVersionId: string | null;
  failureCode: string | null;
  previewPath: string | null;
  liveModel: false;
};

export function generationFailureCopy(code: string | null | undefined) {
  if (!code) return "That experience could not be created.";
  return GENERATION_COPY[code] ?? "That experience could not be created.";
}

export function generationStatusCopy(status: WorkflowGenerationState["status"]) {
  if (status === "ready") return "Your experience is ready.";
  if (status === "failed" || status === "cancelled") return "Generation did not finish.";
  return `Generation is ${status}.`;
}

export function workflowUpdateFailure(status: number) {
  if (status === 409) {
    return {
      stale: true,
      message: "This workflow was updated somewhere else. Reload the saved progress and try again.",
    };
  }
  if (status === 422) {
    return { stale: false, message: "The source changed. Recommend the topic again before saving it." };
  }
  return { stale: false, message: "That change could not be saved." };
}
