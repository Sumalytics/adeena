import { z } from "zod";
import { Uuid } from "@/contracts/common";

export const PublishRelease = z.object({
  experienceVersionId: Uuid,
}).strict();

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
