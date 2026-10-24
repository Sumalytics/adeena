import { createHash } from "node:crypto";
import { NarrationCacheIdentityV1 } from "@/experience/visual-director/schema";

export const NARRATION_NORMALIZATION_VERSION = "narration-text-nfkc-ws@1";
export function normalizeNarrationText(text: string) { return text.normalize("NFKC").replace(/\s+/g, " ").trim(); }
export function narrationCacheKey(input: { text: string; locale: string; voiceProfileId: string; style: string; rate: number; providerId: string; modelId: string; outputFormat: string }) {
  const identity = NarrationCacheIdentityV1.parse({ normalizedText: normalizeNarrationText(input.text), locale: input.locale, voiceProfileId: input.voiceProfileId, style: input.style, rate: input.rate, providerId: input.providerId, modelId: input.modelId });
  return createHash("sha256").update(JSON.stringify({ normalizationVersion: NARRATION_NORMALIZATION_VERSION, ...identity, outputFormat: input.outputFormat })).digest("hex");
}
