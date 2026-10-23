import { TOPIC_DETECTION_VERSION } from "@/contracts/topic";
import type { TopicDecision } from "./analyze";

export type ExtractedSourceSummary = {
  documentVersionId: string;
  filename: string;
  extractionStatus: "complete" | "partial" | "failed" | "pending";
  rightsStatus: "unverified" | "cleared" | "blocked";
  permissionDeclared: boolean;
  byteCount: number;
};

export type CreatorUploadView = {
  documentVersionId: string;
  filename: string;
  byteCount: number;
  rightsStatus: "unverified" | "cleared" | "blocked";
  extractionStatus: "complete" | "partial" | "failed" | "pending" | "not-queued";
  jobStatus: "queued" | "processing" | "complete" | "partial" | "failed" | null;
  failureCode: string | null;
  replayed: boolean;
  spanCount: number;
  issueCodes: string[];
  cost: {
    uploadedBytes: number;
    storedBytes: number;
    processedPages: number | null;
    durationMs: number;
    outcome: "complete" | "partial" | "failed";
    aiGenerationAuthorized: false;
  } | null;
  generatesExperience: false;
  aiGenerationAuthorized: false;
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
    sensitivityScreen: "title-and-excerpt" | "not-run";
    safetyClearance: "none" | "independent-validation";
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
