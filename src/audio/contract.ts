import { z } from "zod";
import { IsoDateTime, Sha256, Uuid } from "@/contracts/common";
import { VISUAL_BLUEPRINT_LIMITS } from "@/experience/visual-director/schema";

export const AUDIO_ASSET_LIMITS = { maxBytes: 8 * 1024 * 1024, maxDurationMs: VISUAL_BLUEPRINT_LIMITS.maxNarrationSegmentDurationMs } as const;
export const ApprovedAudioMime = z.enum(["audio/wav", "audio/mpeg", "audio/ogg"]);
export const AudioAssetStatus = z.enum(["active", "retired"]);

export const AudioAssetProvenanceV1 = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("authorized-test-asset"), generator: z.string().trim().min(1).max(120), generatedAt: IsoDateTime }).strict(),
  z.object({ kind: z.literal("voice-provider"), providerId: z.string().trim().min(1).max(80), modelId: z.string().trim().min(1).max(80), settingsHash: Sha256, cacheKey: Sha256.optional() }).strict(),
]);

/** Server-only record. storageLocator and provenance must never be serialized to a learner. */
export const PrivateAudioAssetV1 = z.object({
  contract: z.literal("ADEENA-PRIVATE-AUDIO-ASSET-v1"),
  assetId: Uuid,
  workspaceId: Uuid,
  experienceVersionId: Uuid,
  narrationSegmentId: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
  contentHash: Sha256,
  storageLocator: z.string().regex(/^private-audio:\/\/[0-9a-f-]{36}\/[a-f0-9]{64}\/audio\.(wav|mp3|ogg)$/),
  mimeType: ApprovedAudioMime,
  byteCount: z.number().int().positive().max(AUDIO_ASSET_LIMITS.maxBytes),
  durationMs: z.number().int().positive().max(AUDIO_ASSET_LIMITS.maxDurationMs),
  locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
  voiceProfileRef: z.string().trim().min(1).max(120),
  status: AudioAssetStatus,
  createdAt: IsoDateTime,
  retiredAt: IsoDateTime.nullable(),
  provenance: AudioAssetProvenanceV1,
}).strict();

export type PrivateAudioAsset = z.infer<typeof PrivateAudioAssetV1>;
export type ApprovedAudioMime = z.infer<typeof ApprovedAudioMime>;
export type AudioAssetProvenance = z.infer<typeof AudioAssetProvenanceV1>;

/** The only browser-visible projection of a private asset record. */
export function creatorAudioSource(assetId: string) {
  return `/api/creator/audio/${Uuid.parse(assetId)}` as const;
}
