import type { NarrationMediaTrack } from "./audio-playback";

export const processDemoNarration: readonly NarrationMediaTrack[] = [
  {
    playback: { contract: "ADEENA-NARRATION-PLAYBACK-v1", segmentId: "air-start", audioAssetId: "a1111111-1111-4111-8111-111111111111", durationMs: 3_364, captions: [{ startMs: 0, endMs: 3_364, text: "Breathing moves air into and out of the lungs." }], cueTimepoints: [{ cueId: "show-entry", atMs: 0 }] },
    source: "/api/dev/visual-director-audio/air-start",
    plannedStartMs: 0,
    plannedDurationMs: 4_000,
  },
  {
    playback: { contract: "ADEENA-NARRATION-PLAYBACK-v1", segmentId: "air-route", audioAssetId: "a2222222-2222-4222-8222-222222222222", durationMs: 5_379, captions: [{ startMs: 0, endMs: 5_379, text: "Air travels through the trachea, bronchi and smaller bronchioles." }], cueTimepoints: [{ cueId: "trace-airway", atMs: 179 }] },
    source: "/api/dev/visual-director-audio/air-route",
    plannedStartMs: 4_000,
    plannedDurationMs: 6_000,
  },
  {
    playback: { contract: "ADEENA-NARRATION-PLAYBACK-v1", segmentId: "gas-exchange", audioAssetId: "a3333333-3333-4333-8333-333333333333", durationMs: 7_878, captions: [{ startMs: 0, endMs: 7_878, text: "Near the alveoli, oxygen enters nearby blood and carbon dioxide moves into the alveoli to be exhaled." }], cueTimepoints: [{ cueId: "show-exchange", atMs: 98 }] },
    source: "/api/dev/visual-director-audio/gas-exchange",
    plannedStartMs: 10_000,
    plannedDurationMs: 8_000,
  },
] as const;
