import { TOPIC_DETECTION_VERSION } from "@/contracts/topic";
import type { TopicDecision } from "./analyze";

export type ExtractedSourceSummary = {
  documentVersionId: string;
  filename: string;
  extractionStatus: "complete" | "partial" | "failed" | "pending";
};

export type TopicCandidateView = {
  id: string;
  title: string;
  sourceOrder: number;
  detectionMethod: "explicit-heading" | "document-structure" | "bounded-text";
  uncertainty: "stated" | "uncertain";
  eligibility: "eligible" | "needs-review" | "insufficient-support";
  reasons: string[];
  primaryNodeId: string;
  supportChars: number;
};

export type TopicRecommendationView = {
  recommendation: {
    id: string;
    status: TopicDecision["status"];
    reason: string;
    topicTitle: string | null;
    topicCandidateId: string | null;
    understood: TopicDecision["understood"];
    generatesExperience: false;
    experienceVersionId: null;
    aiGenerationAuthorized: false;
    candidateCount: number;
    processedChars: number;
    durationMs: number;
    failureCount: 0;
    detectionVersion: typeof TOPIC_DETECTION_VERSION;
    overrideVersion: number;
    replayed: boolean;
  } | null;
  candidates: TopicCandidateView[];
  page: { offset: number; limit: number; total: number };
};
