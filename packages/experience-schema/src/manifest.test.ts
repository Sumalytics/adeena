import { describe, expect, it } from "vitest";
import { parseManifest } from "./index";
import { sharedShelf } from "./shared-shelf";

const experienceId = "10000000-0000-4000-8000-000000000001";
const versionId = "10000000-0000-4000-8000-000000000002";
const sourceId = "10000000-0000-4000-8000-000000000003";

function codes(result: { diagnostics: { code: string }[] }) {
  return result.diagnostics.map((item) => item.code);
}

function graphStory(scenes: unknown[], initialSceneId = "start") {
  return {
    schema: "adeena.experience-manifest",
    schemaVersion: "1",
    experienceId,
    versionId,
    title: "Graph check",
    locale: "en",
    mechanics: ["branching-dialogue@1"],
    initialSceneId,
    scenes,
    state: { variables: [] },
    assets: [],
    sources: [
      {
        sourceId,
        locator: "synthetic:graph-check",
        note: "Illustrative graph check, not approved source material.",
      },
    ],
    events: { schemaVersion: "1" },
    accessibility: { textAlternative: "not-applicable", motion: "none" },
  };
}

describe("experience manifest", () => {
  it("accepts the shared-shelf fixture and its distinct consequences", () => {
    const result = parseManifest(sharedShelf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dialogue = result.manifest.scenes.filter((scene) => scene.role === "dialogue");
    expect(dialogue.length).toBeGreaterThanOrEqual(3);
    expect(result.manifest.scenes.filter((scene) => scene.role === "ending").length).toBeGreaterThan(1);
    expect(JSON.stringify(result.manifest)).not.toContain("mastery");
    expect(JSON.stringify(result.manifest)).not.toContain("Rainmaker");
    const effects = dialogue.flatMap((scene) => scene.choices.flatMap((choice) => choice.effects));
    expect(new Set(effects.map((effect) => JSON.stringify(effect))).size).toBeGreaterThan(1);
  });

  it("rejects unknown fields, executable text, and unsupported versions", () => {
    const unknown = parseManifest({ ...sharedShelf, script: "alert(1)" });
    expect(codes(unknown)).toContain("schema.unknown-field");

    const executable = parseManifest({
      ...sharedShelf,
      title: "<script>alert(1)</script>",
    });
    expect(codes(executable)).toContain("content.executable");

    const version = parseManifest({ ...sharedShelf, schemaVersion: "2" });
    expect(codes(version)).toContain("schema.unsupported-version");

    const mechanic = parseManifest({ ...sharedShelf, mechanics: ["phaser@1"] });
    expect(codes(mechanic)).toContain("mechanic.unsupported");

    const events = parseManifest({ ...sharedShelf, events: { schemaVersion: "9" } });
    expect(codes(events)).toContain("events.unsupported-version");

    const malformed = parseManifest({ schema: "adeena.experience-manifest" });
    expect(malformed.ok).toBe(false);
    expect(codes(malformed)).toContain("schema.invalid");

    const effect = parseManifest({
      ...sharedShelf,
      scenes: sharedShelf.scenes.map((scene) => {
        if (scene.role !== "dialogue" || scene.id !== "ask" || !scene.choices) return scene;
        return {
          ...scene,
          choices: scene.choices.map((choice) =>
            choice.id === "share-now"
              ? { ...choice, effects: [{ type: "exec", code: "process.exit(1)" }] }
              : choice,
          ),
        };
      }),
    });
    expect(codes(effect)).toContain("state.effect-unsupported");
  });

  it("rejects duplicate scenes, broken references, bad assets, and effect bounds", () => {
    const duplicate = structuredClone(sharedShelf);
    duplicate.scenes[1] = { ...duplicate.scenes[1], id: "ask" };
    expect(codes(parseManifest(duplicate))).toContain("scene.duplicate");

    const broken = structuredClone(sharedShelf);
    const ask = broken.scenes[0];
    if (ask.role !== "dialogue" || !ask.choices) throw new Error("expected dialogue");
    ask.choices[0] = { ...ask.choices[0], nextSceneId: "missing-scene" };
    expect(codes(parseManifest(broken))).toContain("scene.transition-missing");

    const asset = structuredClone(sharedShelf);
    asset.assets[0] = { ...asset.assets[0], locator: "javascript:alert(1)" };
    expect(codes(parseManifest(asset))).toContain("asset.invalid");

    const remote = structuredClone(sharedShelf);
    remote.assets[0] = { ...remote.assets[0], locator: "https://example.com/app.js" };
    expect(codes(parseManifest(remote))).toContain("asset.invalid");

    const bounded = structuredClone(sharedShelf);
    const record = bounded.scenes.find((scene) => scene.id === "record");
    if (!record || record.role !== "dialogue" || !record.choices?.[1]) throw new Error("expected record");
    record.choices[1] = {
      ...record.choices[1],
      effects: [{ type: "adjust", variableId: "keepers", delta: 50 }],
    };
    expect(codes(parseManifest(bounded))).toContain("state.out-of-bounds");

    const unknownAsset = structuredClone(sharedShelf);
    unknownAsset.scenes[0] = { ...unknownAsset.scenes[0], assetIds: ["missing-art"] };
    expect(codes(parseManifest(unknownAsset))).toContain("asset.unknown");
  });

  it("allows a cycle with an exit and rejects a closed loop", () => {
    const withExit = parseManifest(
      graphStory([
        {
          role: "dialogue",
          id: "start",
          title: "Start",
          text: "A request can be posted or taken back to the shelf.",
          assetIds: [],
          required: true,
          choices: [
            { id: "again", text: "Look at the board again.", effects: [], nextSceneId: "board" },
            { id: "finish", text: "Leave the note posted.", effects: [], nextSceneId: "done" },
          ],
        },
        {
          role: "dialogue",
          id: "board",
          title: "Board",
          text: "The board points back to the shelf.",
          assetIds: [],
          required: true,
          choices: [{ id: "back", text: "Return to the shelf.", effects: [], nextSceneId: "start" }],
        },
        {
          role: "ending",
          id: "done",
          title: "Posted",
          text: "The note stays on the board.",
          assetIds: [],
          required: true,
        },
      ]),
    );
    expect(withExit.ok).toBe(true);

    const closed = parseManifest(
      graphStory([
        {
          role: "dialogue",
          id: "start",
          title: "Start",
          text: "The conversation only returns to itself.",
          assetIds: [],
          required: true,
          choices: [{ id: "again", text: "Repeat the question.", effects: [], nextSceneId: "loop" }],
        },
        {
          role: "dialogue",
          id: "loop",
          title: "Loop",
          text: "There is no way out.",
          assetIds: [],
          required: true,
          choices: [{ id: "back", text: "Ask again.", effects: [], nextSceneId: "start" }],
        },
      ]),
    );
    expect(closed.ok).toBe(false);
    expect(codes(closed)).toContain("graph.cycle-without-exit");
    expect(codes(closed)).toContain("ending.missing");
  });

  it("accepts a bounded retry that exits to an ending", () => {
    const result = parseManifest(
      graphStory([
        {
          role: "dialogue",
          id: "start",
          title: "Start",
          text: "The same question can be asked only a few times.",
          assetIds: [],
          required: true,
          retry: { policy: "bounded-retry", maxAttempts: 2, onExhaustedSceneId: "done" },
          choices: [{ id: "again", text: "Ask once more.", effects: [], nextSceneId: "start" }],
        },
        {
          role: "ending",
          id: "done",
          title: "Stopped",
          text: "The conversation stops after the allowed retries.",
          assetIds: [],
          required: true,
        },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an unreachable required scene", () => {
    const story = structuredClone(sharedShelf);
    story.scenes.push({
      role: "ending",
      id: "unlinked",
      title: "Unlinked",
      text: "Nothing leads here.",
      assetIds: [],
      required: true,
    });
    const result = parseManifest(story);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("scene.unreachable-required");
  });
});
