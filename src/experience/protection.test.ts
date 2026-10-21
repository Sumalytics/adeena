import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileExperiencePlan } from "./compile";
import { applyModelOutput, prepareDialogueTarget } from "./edit";
import { mapGroqGraphTransport, mapGroqTransport } from "./groq-edit";
import { simulateExperience } from "./simulate";

const lesson = "Learners compare two careful choices and explain the result using only this passage. ".repeat(4);
const instruction = "Rewrite the opening dialogue in clearer, more engaging everyday English. Keep the learning objective, facts, choices and consequences unchanged.";

function draft() {
  const compiled = compileExperiencePlan({
    documentVersionId: randomUUID(),
    topicTitle: "Clouds",
    audienceLabel: "Primary learners",
    ageBand: "8-10",
    spans: [{ id: randomUUID(), excerpt: lesson }],
    experienceId: randomUUID(),
    versionId: randomUUID(),
  });
  if (!compiled.ok) throw new Error("fixture");
  return compiled.manifest;
}

function objectiveSentence(text: string) {
  return text.split(/(?<=\.)\s/).find((sentence) => /\b(goal|objective)\b/i.test(sentence))?.trim();
}

describe("protected dialogue editing", () => {
  it("keeps the learning objective when the model omits it from the editable text", () => {
    const manifest = draft();
    const before = structuredClone(manifest);
    const target = prepareDialogueTarget(manifest, "opening");
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const objective = objectiveSentence(manifest.scenes.find((scene) => scene.id === "opening")?.text ?? "");
    expect(objective).toBeTruthy();
    expect(target.target.protectedSpans.some((span) => span.includes(objective ?? ""))).toBe(true);
    expect(target.target.editableParts.join(" ")).not.toContain(objective ?? "");
    const mapped = mapGroqTransport({ sceneId: "opening", text: "This room is not part of the source." }, target.target);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const revised = applyModelOutput(manifest, instruction, mapped.edit, randomUUID(), "opening");
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    const opening = revised.manifest.scenes.find((scene) => scene.id === "opening");
    expect(opening?.text).toContain(objective);
    expect(opening?.text).toContain("This room is not part of the source.");
    expect(opening?.text).not.toBe(before.scenes.find((scene) => scene.id === "opening")?.text);
    expect(manifest).toEqual(before);
  });

  it("still rejects a full-scene rewrite that drops the objective", () => {
    const manifest = draft();
    const opening = manifest.scenes.find((scene) => scene.id === "opening");
    if (!opening) throw new Error("opening");
    const dropped = opening.text.split(/(?<=\.)\s/).filter((sentence) => !/\b(goal|objective)\b/i.test(sentence)).join(" ");
    const revised = applyModelOutput(manifest, instruction, {
      intent: "Rewrite the opening.",
      scope: "scene",
      gameplayChange: false,
      factualChange: false,
      objectiveChange: false,
      uncertainty: null,
      reviewRequirements: [],
      operations: [{ op: "rewrite-text", sceneId: "opening", text: dropped }],
    }, randomUUID(), "opening");
    expect(revised.ok).toBe(false);
    if (revised.ok) return;
    expect(revised.diagnostic).toBe("preservation.objective");
  });

  it("rejects a changed quoted claim and accepts a paraphrase of editable text", () => {
    const manifest = draft();
    const target = prepareDialogueTarget(manifest, "opening");
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const quoted = mapGroqTransport({ sceneId: "opening", text: "The note is titled “A different claim”." }, target.target);
    expect(quoted.ok).toBe(false);
    if (quoted.ok) return;
    expect(quoted.diagnostic).toBe("grounding.quote");
    const paraphrased = mapGroqTransport({ sceneId: "opening", text: "Nothing in the source describes this room." }, target.target);
    expect(paraphrased.ok).toBe(true);
    if (!paraphrased.ok) return;
    const revised = applyModelOutput(manifest, instruction, paraphrased.edit, randomUUID(), "opening");
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    const opening = revised.manifest.scenes.find((scene) => scene.id === "opening");
    expect(opening?.text).toContain("Nothing in the source describes this room.");
    expect(opening?.text).toContain(objectiveSentence(manifest.scenes[0]?.text ?? ""));
    expect(revised.manifest.sources).toEqual(manifest.sources);
    expect(revised.manifest.accessibility).toEqual(manifest.accessibility);
    expect(revised.manifest.experienceId).toBe(manifest.experienceId);
    expect(revised.manifest.runtime).toEqual(manifest.runtime);
    expect(revised.validation.simulation).toMatchObject({ ok: true, replayReset: true });
  });

  it("keeps the same reachable choices when only editable text changes", () => {
    const manifest = draft();
    const target = prepareDialogueTarget(manifest, "opening");
    if (!target.ok) throw new Error("target");
    const mapped = mapGroqTransport({ sceneId: "opening", text: "The source never describes this room." }, target.target);
    if (!mapped.ok) throw new Error("map");
    const revised = applyModelOutput(manifest, instruction, mapped.edit, randomUUID(), "opening");
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    const edges = (source: typeof manifest) => source.scenes.flatMap((scene) => scene.role === "dialogue" ? scene.choices.map((choice) => [scene.id, choice.id, choice.nextSceneId]) : []);
    expect(edges(revised.manifest)).toEqual(edges(manifest));
    const before = simulateExperience(manifest);
    const after = simulateExperience(revised.manifest);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.report.endingSceneIds).toEqual(before.report.endingSceneIds);
    expect(after.report.replayReset).toBe(true);
  });

  it("separates protected and editable sentences and refuses a fused sentence", () => {
    const manifest = draft();
    const separated = prepareDialogueTarget(manifest, "opening");
    expect(separated.ok).toBe(true);
    if (!separated.ok) return;
    expect(separated.target.editableParts.length).toBeGreaterThan(0);
    expect(separated.target.protectedSpans.length).toBeGreaterThan(0);
    const fused = structuredClone(manifest);
    const opening = fused.scenes.find((scene) => scene.id === "opening");
    if (!opening) throw new Error("opening");
    opening.text = "Walk to the window and remember your goal is to use the source note before you choose.";
    expect(prepareDialogueTarget(fused, "opening")).toEqual({ ok: false, diagnostic: "protection.unseparable" });
    const protectedOnly = structuredClone(manifest);
    const decision = protectedOnly.scenes.find((scene) => scene.id === "decision");
    if (!decision) throw new Error("decision");
    expect(prepareDialogueTarget(protectedOnly, "decision")).toEqual({ ok: false, diagnostic: "protection.no-editable-text" });
  });

  it("rejects model fields that would change protected metadata", () => {
    const manifest = draft();
    const target = prepareDialogueTarget(manifest, "opening");
    if (!target.ok) throw new Error("target");
    const extra = mapGroqTransport({ sceneId: "opening", text: "A clearer room.", experienceId: manifest.experienceId, publicationStatus: "published" }, target.target);
    expect(extra.ok).toBe(false);
    if (extra.ok) return;
    expect(extra.diagnostic).toContain("unrecognized_keys");
  });

  it("accepts one retarget and rejects a retarget that leaves a scene unreachable", () => {
    const manifest = draft();
    const before = simulateExperience(manifest);
    expect(before.ok).toBe(true);
    const valid = mapGroqGraphTransport({ sceneId: "opening", choiceId: "set-aside", nextSceneId: "decision" });
    expect(valid.ok).toBe(true);
    if (!valid.ok || !before.ok) return;
    const applied = applyModelOutput(manifest, "Retarget the set-aside choice.", valid.edit, randomUUID(), "opening");
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const after = simulateExperience(applied.manifest);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.report.endingSceneIds.slice().sort()).toEqual(before.report.endingSceneIds.slice().sort());
    const saved = structuredClone(manifest);
    const invalid = mapGroqGraphTransport({ sceneId: "decision", choiceId: "keep-note", nextSceneId: "ending-revisit" });
    expect(invalid.ok).toBe(true);
    if (!invalid.ok) return;
    const rejected = applyModelOutput(manifest, "Retarget the kept note.", invalid.edit, randomUUID(), "decision");
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.diagnostic).toBe("scene.unreachable-required");
    expect(manifest).toEqual(saved);
  });
});
