import type { TopicCandidateView, TopicRecommendationView } from "@/topic/public";

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
  "provider-unavailable": "The model did not finish. No fixture was substituted. Start a new experience to explicitly authorize another attempt.",
  "generation-unavailable": "AI generation is not configured. No experience was created.",
  "budget-unavailable": "Generation spending is not authorized. No experience was created.",
  "review-required": "Generation is unavailable for this topic. Choose another eligible topic or upload a focused ordinary source.",
  "sensitive-topic": "The selected topic contains high-risk material that this workflow cannot generate. Choose a different eligible topic or upload a source focused on ordinary learning content.",
  "unsafe-topic": "The selected topic has an unsafe heading. Correct the source structure or choose another eligible topic.",
  "source-structure-required": "The selected topic is incomplete or not clearly bounded. Correct the source headings, choose another eligible topic or upload a more focused source.",
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
  liveModel: boolean;
  visualStatus?: "not-requested" | "queued" | "planning" | "reviewing" | "ready" | "unsupported" | "failed";
  stageLabel?: "Creating your experience" | "Preparing animated explanation" | "Checking the learning content" | "Ready to preview" | "Visual generation unavailable";
  visualMessage?: string | null;
  legacyOnly?: boolean;
};

export function generationFailureCopy(code: string | null | undefined) {
  if (!code) return "That experience could not be created.";
  return GENERATION_COPY[code] ?? "That experience could not be created.";
}

export function topicRecommendationFailureCopy(code: string | null | undefined) {
  if (code === "invalid-topic") return "This content is not ready for a topic yet. Return to content and finish processing it, or choose another extracted file.";
  if (code === "cross-workspace") return "This content is not available in your workspace. Choose another extracted file.";
  if (code === "unauthenticated") return "Your session ended. Sign in again, then continue this experience.";
  return "The topic recommendation could not be prepared. Check that the selected content finished processing and try again.";
}

export function topicGenerationGate(candidate: TopicCandidateView | undefined) {
  if (!candidate) {
    return { allowed: false, message: "Recommend the topic again, then choose an eligible topic before generation." };
  }
  if (candidate.reasons.includes("sensitive-domain")) {
    return { allowed: false, message: GENERATION_COPY["sensitive-topic"] };
  }
  if (candidate.reasons.includes("unsafe-title")) {
    return { allowed: false, message: GENERATION_COPY["unsafe-topic"] };
  }
  if (candidate.eligibility === "insufficient-support") {
    return { allowed: false, message: "This topic does not have enough source support. Choose a fuller section or upload a more complete source." };
  }
  if (candidate.eligibility !== "eligible") {
    return { allowed: false, message: GENERATION_COPY["source-structure-required"] };
  }
  return { allowed: true, message: null };
}

export function topicRestrictionCopy(candidate: TopicCandidateView) {
  return topicGenerationGate(candidate).message ?? "Eligible for a private draft.";
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
