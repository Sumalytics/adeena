export type GenerationStatus = "queued" | "planning" | "compiling" | "validating" | "ready" | "failed" | "cancelled";

export type GenerationUsage = {
  kind: "actual" | "estimate" | "none";
  currency: "USD";
  pricingVersion: string;
  inputTokens: number;
  outputTokens: number;
  callCount: number;
  retryCount: number;
  estimatedCostMicros: number | null;
  actualCostMicros: number | null;
};

/** Creator-facing generation result. It omits plans, diagnostics, and source text. */
export type CreatorExperienceView = {
  jobId: string;
  status: GenerationStatus;
  experienceVersionId: string | null;
  title: string | null;
  reviewStatus: "ready-for-review" | "review-required" | null;
  publicationStatus: "unpublished" | null;
  rightsStatus: "unverified" | "cleared" | "blocked" | null;
  failureCode: string | null;
  replayed: boolean;
  provider: "deterministic-fixture";
  liveModel: false;
  aiGenerationAuthorized: false;
  usage: GenerationUsage | null;
  previewPath: string | null;
};

export type CreatorDraftSummary = {
  id: string;
  title: string;
  reviewStatus: "ready-for-review" | "review-required";
  publicationStatus: "unpublished";
  liveModel: false;
};
