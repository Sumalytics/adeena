import { z } from "zod";
import { Uuid } from "@/contracts/common";

/** A deliberate, version-specific human decision, never inferred from readiness. */
export const ReleaseApproval = z.object({
  experienceVersionId: Uuid,
  decision: z.literal("approved"),
  contentReviewed: z.literal(true),
  privacy: z.literal("no-identifiable-learner"),
  unresolvedHighRisk: z.literal(false),
  note: z.string().trim().min(10).max(1000),
}).strict();

export const PublishRelease = z.object({
  experienceVersionId: Uuid,
  approval: ReleaseApproval,
}).strict().refine((value) => value.experienceVersionId === value.approval.experienceVersionId);

export const RELEASE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

export class ReleaseError extends Error {
  constructor(readonly code: "invalid-publication" | "publication-denied" | "release-unavailable") {
    super(code);
  }
}
