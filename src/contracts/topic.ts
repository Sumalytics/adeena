import { z } from "zod";
import { AgeBand, Uuid } from "./common";

/** Documented detection revision. Ranking weights live in the topic policy module. */
export const TOPIC_DETECTION_VERSION = "1";

export const TOPIC_REASON_CODES = [
  "clear-heading",
  "chapter-boundary",
  "lesson-sized",
  "short-span",
  "broad-span",
  "partial-extraction",
  "missing-heading",
  "ambiguous-structure",
  "missing-context",
  "sensitive-domain",
  "partial-sensitivity-screen",
  "review-required",
  "creator-corrected",
  "unsafe-title",
  "age-unspecified",
  "rights-unverified",
  "rights-blocked",
  "unreadable-source",
] as const;

export const TopicReasonCode = z.enum(TOPIC_REASON_CODES);

export type TopicReasonCode = z.infer<typeof TopicReasonCode>;

export const TopicCandidate = z
  .object({
    contract: z.literal("TOPIC-CANDIDATE-v1"),
    id: Uuid,
    collectionId: Uuid,
    documentVersionId: Uuid,
    extractionId: Uuid,
    workspaceId: Uuid,
    primaryNodeId: Uuid,
    nodeIds: z.array(Uuid).min(1).max(500),
    sourceSpanIds: z.array(Uuid).min(1).max(500),
    title: z.string().trim().min(1).max(200),
    sourceOrder: z.number().int().nonnegative(),
    detectionMethod: z.enum(["explicit-heading", "document-structure", "bounded-text"]),
    detectionVersion: z.literal(TOPIC_DETECTION_VERSION),
    confidence: z.null(),
    uncertainty: z.enum(["stated", "uncertain"]),
    eligibility: z.enum(["eligible", "needs-review", "insufficient-support"]),
    reasons: z.array(TopicReasonCode).max(12),
    supportChars: z.number().int().nonnegative(),
    educationalValidation: z.literal("none"),
  })
  .strict();

export type TopicCandidate = z.infer<typeof TopicCandidate>;

export const TopicDetectionResult = z
  .object({
    contract: z.literal("TOPIC-DETECTION-v1"),
    id: Uuid,
    collectionId: Uuid,
    documentVersionId: Uuid,
    extractionId: Uuid,
    workspaceId: Uuid,
    detectionVersion: z.literal(TOPIC_DETECTION_VERSION),
    candidateIds: z.array(Uuid).max(500),
    understood: z.enum(["full", "partial", "unreadable"]),
    educationalValidation: z.literal("none"),
  })
  .strict();

export type TopicDetectionResult = z.infer<typeof TopicDetectionResult>;

export const FirstExperienceRecommendation = z
  .object({
    contract: z.literal("FIRST-RECOMMENDATION-v1"),
    id: Uuid,
    collectionId: Uuid,
    documentVersionId: Uuid,
    extractionId: Uuid,
    workspaceId: Uuid,
    topicCandidateId: Uuid.nullable(),
    audienceLabel: z.string().trim().min(1).max(80),
    ageBand: AgeBand,
    status: z.enum(["recommended", "needs-creator-selection", "insufficient-support"]),
    reason: z.string().trim().min(1).max(400),
    reasons: z.array(TopicReasonCode).max(12),
    sourceSpanIds: z.array(Uuid).max(500),
    understood: z.enum(["full", "partial", "unreadable"]),
    candidateCount: z.number().int().nonnegative(),
    processedChars: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    failureCount: z.literal(0),
    detectionVersion: z.literal(TOPIC_DETECTION_VERSION),
    overrideVersion: z.number().int().nonnegative(),
    generatesExperience: z.literal(false),
    experienceVersionId: z.null(),
    aiGenerationAuthorized: z.literal(false),
    sensitivityScreen: z.enum(["title-and-excerpt", "not-run"]),
    safetyClearance: z.enum(["none", "independent-validation"]),
    educationalValidation: z.literal("none"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "recommended" && !value.topicCandidateId) {
      ctx.addIssue({ code: "custom", message: "A recommendation needs one topic." });
    }
    if (value.status !== "recommended" && value.topicCandidateId) {
      ctx.addIssue({ code: "custom", message: "Only a recommended result may name a topic." });
    }
  });

export type FirstExperienceRecommendation = z.infer<typeof FirstExperienceRecommendation>;

export const TopicOverride = z
  .object({
    contract: z.literal("TOPIC-OVERRIDE-v1"),
    id: Uuid,
    workspaceId: Uuid,
    documentVersionId: Uuid,
    collectionId: Uuid,
    nodeId: Uuid,
    version: z.number().int().positive(),
    correctedTitle: z.string().trim().min(1).max(200),
    createdBy: Uuid,
    generatesExperience: z.literal(false),
  })
  .strict();

export type TopicOverride = z.infer<typeof TopicOverride>;
