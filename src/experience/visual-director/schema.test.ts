import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authoredFixtureContexts, authoredHistoryFixture, authoredProcessFixture, authoredTwoSetFixture } from "./fixtures";
import { NarrationAudioAssetV1, NarrationCacheIdentityV1, NarrationPlaybackTrackV1, validateVisualBlueprint, VISUAL_STAGE_CONTRACT, VoiceSynthesisRequestV1 } from "./schema";

const clone = <T>(value: T): T => structuredClone(value);
const codes = (result: ReturnType<typeof validateVisualBlueprint>) => result.ok ? [] : result.diagnostics.map((item) => item.code);

describe("Visual Director v1 contract", () => {
  it("accepts authored fixtures and reports renderer support accurately", () => {
    const cases = [
      [authoredProcessFixture, authoredFixtureContexts.process],
      [authoredTwoSetFixture, authoredFixtureContexts.sets],
      [authoredHistoryFixture, authoredFixtureContexts.history],
    ] as const;
    for (const [fixture, context] of cases) {
      const result = validateVisualBlueprint(fixture, context);
      expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
      if (result.ok) {
        const expected = fixture === authoredHistoryFixture ? "not-implemented" : "implemented";
        expect(result.rendererRequirements.every((item) => item.status === expected)).toBe(true);
      }
    }
    expect(JSON.stringify(authoredHistoryFixture)).not.toMatch(/lung|bronch|venn|intersection/i);
  });

  it("fails explicitly when the selected runtime has no registered renderer implementation", () => {
    const result = validateVisualBlueprint(authoredProcessFixture, { ...authoredFixtureContexts.process, implementedArchetypes: [] });
    expect(codes(result)).toContain("archetype.not-implemented");
  });

  it("rejects unregistered archetypes and animation commands", () => {
    const unknownArchetype = clone(authoredProcessFixture) as unknown as { scenes: Array<{ archetype: string }> };
    unknownArchetype.scenes[0].archetype = "subject-specific-organ-animation@1";
    expect(codes(validateVisualBlueprint(unknownArchetype, authoredFixtureContexts.process))).toContain("schema.invalid");

    const unknownAction = clone(authoredProcessFixture) as unknown as { scenes: Array<{ cues: Array<{ action: unknown }> }> };
    unknownAction.scenes[0].cues[0].action = { kind: "execute-script", source: "doSomething()" };
    expect(codes(validateVisualBlueprint(unknownAction, authoredFixtureContexts.process))).toContain("schema.invalid");
  });

  it("rejects unknown cues, objects, choices and narration segments", () => {
    const unknownCue = clone(authoredProcessFixture);
    unknownCue.scenes[0].narration[0].cueIds = ["missing-cue"];
    expect(codes(validateVisualBlueprint(unknownCue, authoredFixtureContexts.process))).toContain("reference.cue");

    const unknownObject = clone(authoredProcessFixture);
    unknownObject.scenes[0].cues[0].targetId = "missing-object";
    expect(codes(validateVisualBlueprint(unknownObject, authoredFixtureContexts.process))).toContain("reference.object");

    const unknownChoice = clone(authoredProcessFixture);
    const choiceCue = unknownChoice.scenes[0].cues.find((cue) => cue.trigger.kind === "choice-applied");
    if (choiceCue?.trigger.kind === "choice-applied") choiceCue.trigger.choiceId = "unknown-choice";
    expect(codes(validateVisualBlueprint(unknownChoice, authoredFixtureContexts.process))).toContain("reference.choice");

    const unknownSegment = clone(authoredProcessFixture);
    unknownSegment.scenes[0].cues[0].trigger = { kind: "narration-segment", segmentId: "missing-segment", offsetMs: 0 };
    expect(codes(validateVisualBlueprint(unknownSegment, authoredFixtureContexts.process))).toContain("reference.narration");
  });

  it("rejects duplicate ids and invalid references inside drawable groups and edges", () => {
    const duplicate = clone(authoredProcessFixture);
    duplicate.scenes[0].visualObjects[1].id = duplicate.scenes[0].visualObjects[0].id;
    expect(codes(validateVisualBlueprint(duplicate, authoredFixtureContexts.process))).toContain("id.duplicate");
    const edge = clone(authoredProcessFixture);
    const firstEdge = edge.scenes[0].visualObjects.find((object) => object.kind === "edge");
    if (firstEdge?.kind === "edge") firstEdge.toId = "missing-node";
    expect(codes(validateVisualBlueprint(edge, authoredFixtureContexts.process))).toContain("reference.object");
  });

  it("enforces bounded text, scene time, synchronized narration and stage coordinates", () => {
    const long = clone(authoredProcessFixture);
    long.scenes[0].narration[0].text = "x".repeat(601);
    expect(codes(validateVisualBlueprint(long, authoredFixtureContexts.process))).toContain("schema.invalid");
    const duration = clone(authoredProcessFixture);
    duration.scenes[0].durationMs = 121_000;
    expect(codes(validateVisualBlueprint(duration, authoredFixtureContexts.process))).toContain("schema.invalid");
    const overlap = clone(authoredProcessFixture);
    overlap.scenes[0].narration[1].startMs = 3_000;
    expect(codes(validateVisualBlueprint(overlap, authoredFixtureContexts.process))).toContain("timeline.overlap");
    const nonVerbatimCaption = clone(authoredProcessFixture);
    nonVerbatimCaption.scenes[0].narration[0].caption = "A shorter summary.";
    expect(codes(validateVisualBlueprint(nonVerbatimCaption, authoredFixtureContexts.process))).toContain("narration.caption");
    const lateCue = clone(authoredProcessFixture);
    lateCue.scenes[0].cues[0].durationMs = lateCue.scenes[0].narration[0].durationMs + 1;
    expect(codes(validateVisualBlueprint(lateCue, authoredFixtureContexts.process))).toContain("timeline.duration");
    const outside = clone(authoredProcessFixture);
    outside.scenes[0].visualObjects[0].geometry = { x: 950, y: 0, width: 100, height: 100 };
    expect(codes(validateVisualBlueprint(outside, authoredFixtureContexts.process))).toContain("geometry.out-of-bounds");
  });

  it("validates two-set arithmetic deterministically", () => {
    const badUnion = clone(authoredTwoSetFixture);
    const interaction = badUnion.scenes[0].interaction;
    if (interaction?.kind === "calculate" && interaction.answerSpec.operation === "two-set-cardinality") interaction.answerSpec.unionCount = 27;
    expect(codes(validateVisualBlueprint(badUnion, authoredFixtureContexts.sets))).toContain("math.two-set-cardinality");
    const badIntersection = clone(authoredTwoSetFixture);
    const second = badIntersection.scenes[0].interaction;
    if (second?.kind === "calculate" && second.answerSpec.operation === "two-set-cardinality") second.answerSpec.intersectionCount = 20;
    expect(codes(validateVisualBlueprint(badIntersection, authoredFixtureContexts.sets))).toContain("math.two-set-cardinality");
  });

  it("rejects executable text, locators, missing provenance and mismatched audience context", () => {
    for (const text of ["<script>alert(1)</script>", "javascript:alert(1)", "https://untrusted.example/asset.png"]) {
      const unsafe = clone(authoredProcessFixture);
      unsafe.scenes[0].narration[0].text = text;
      expect(codes(validateVisualBlueprint(unsafe, authoredFixtureContexts.process))).toContain("schema.invalid");
    }
    const noEvidence = clone(authoredProcessFixture);
    noEvidence.scenes[0].sourceSpanIds = [];
    expect(codes(validateVisualBlueprint(noEvidence, authoredFixtureContexts.process))).toContain("schema.invalid");
    expect(codes(validateVisualBlueprint(authoredProcessFixture, { ...authoredFixtureContexts.process, ageBand: "adult" }))).toContain("context.age-band");
    expect(codes(validateVisualBlueprint(authoredProcessFixture, { ...authoredFixtureContexts.process, locale: "fr" }))).toContain("context.locale");
  });

  it("bounds arbitrary input before schema parsing", () => {
    const value: Record<string, unknown> = {};
    let current = value;
    for (let index = 0; index < 20; index += 1) { const next = {}; current.next = next; current = next; }
    expect(codes(validateVisualBlueprint(value, authoredFixtureContexts.process))).toContain("bound.exceeded");
  });

  it("defines provider-neutral cache, production metadata and guest playback seams without URLs", () => {
    expect(NarrationCacheIdentityV1.safeParse({ normalizedText: "A short source-grounded explanation.", locale: "en-GH", voiceProfileId: "educator-warm-1", style: "warm", rate: 0.95, providerId: "provider-one", modelId: "voice-model-one" }).success).toBe(true);
    expect(VoiceSynthesisRequestV1.safeParse({ text: "A short source-grounded explanation.", locale: "en-GH", voiceProfileId: "untrusted-cloned-voice", style: "warm", rate: 0.95, idempotencyKey: randomUUID() }).success).toBe(false);
    const assetId = randomUUID();
    expect(NarrationAudioAssetV1.safeParse({ contract: "ADEENA-NARRATION-AUDIO-v1", segmentId: "air-start", audioAssetId: assetId, cacheKey: "a".repeat(64), checksum: "b".repeat(64), mimeType: "audio/mpeg", durationMs: 4_000, timingCues: [{ cueId: "show-entry", atMs: 0 }], usage: { characterCount: 48, audioDurationMs: 4_000, cache: "miss", retryCount: 0 } }).success).toBe(true);
    expect(NarrationPlaybackTrackV1.safeParse({ contract: "ADEENA-NARRATION-PLAYBACK-v1", segmentId: "air-start", audioAssetId: assetId, durationMs: 4_000, captions: [{ startMs: 0, endMs: 4_000, text: "Breathing moves air into and out of the lungs." }], cueTimepoints: [{ cueId: "show-entry", atMs: 0 }], url: "https://untrusted.example/audio.mp3" }).success).toBe(false);
    expect(NarrationPlaybackTrackV1.safeParse({ contract: "ADEENA-NARRATION-PLAYBACK-v1", segmentId: "air-start", audioAssetId: assetId, durationMs: 4_000, captions: [{ startMs: 0, endMs: 5_000, text: "Too late." }], cueTimepoints: [] }).success).toBe(false);
    expect(VISUAL_STAGE_CONTRACT.playbackInference).toBe("none");
    expect(VISUAL_STAGE_CONTRACT.requiredInputModes).toEqual(["keyboard", "touch"]);
  });
});
