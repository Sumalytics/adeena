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
  provider: "deterministic-fixture" | "configured-provider";
  liveModel: boolean;
  aiGenerationAuthorized: boolean;
  usage: GenerationUsage | null;
  previewPath: string | null;
};

export type CreatorGenerationJourney = CreatorExperienceView & {
  visualStatus: "not-requested" | "queued" | "planning" | "reviewing" | "ready" | "unsupported" | "failed";
  stageLabel: "Creating your experience" | "Preparing animated explanation" | "Checking the learning content" | "Ready to preview" | "Visual generation unavailable";
  visualMessage: string | null;
  legacyOnly: boolean;
};

export type CreatorDraftSummary = {
  id: string;
  title: string;
  reviewStatus: "ready-for-review" | "review-required";
  publicationStatus: "unpublished";
  liveModel: boolean;
};

export {
  ARCHETYPE_REGISTRY,
  NarrationAudioAssetV1,
  NarrationCacheIdentityV1,
  NarrationPlaybackTrackV1,
  VoiceSynthesisRequestV1,
  VoiceSynthesisResultMetadataV1,
  validateVisualBlueprint,
  VISUAL_BLUEPRINT_LIMITS,
  VISUAL_STAGE_CONTRACT,
  VisualLearningBlueprintV1,
  type VisualArchetypeId,
  type VisualBlueprintContext,
  type VisualBlueprintDiagnostic,
  type VisualLearningBlueprint,
  type VisualScene,
  type VisualObject,
  type VisualCue,
  type NarrationProvider,
  type VoiceSynthesisRequest,
  type VoiceSynthesisResult,
} from "./visual-director/schema";
