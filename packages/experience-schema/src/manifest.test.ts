import { describe, expect, it } from "vitest";
import { diagnostic } from "./diagnostics";
import {
  DIAGNOSTIC_CODES,
  EXECUTION_RULES,
  EXECUTION_SEMANTICS,
  MANIFEST_LIMITS,
  parseManifest,
  sortDiagnostics,
} from "./index";
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
    runtime: {
      compatibility: "adeena.experience-runtime@1",
      profile: "lightweight",
      requiresLlm: false,
      executableScripts: false,
    },
  };
}

const keepers = { id: "keepers", type: "integer", min: 0, max: 3, initial: 1 };

function storyWith(variables: unknown[], effects: unknown[]) {
  return {
    ...graphStory([
      {
        role: "dialogue",
        id: "start",
        title: "Start",
        text: "A neighbor asks for the shared drill.",
        assetIds: [],
        required: true,
        choices: [{ id: "go", text: "Continue toward the ending.", effects, nextSceneId: "done" }],
      },
      {
        role: "ending",
        id: "done",
        title: "Done",
        text: "The conversation ends.",
        assetIds: [],
        required: true,
      },
    ]),
    state: { variables },
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

describe("experience manifest", () => {
  it("accepts the shared-shelf fixture and its distinct consequences", () => {
    const result = parseManifest(sharedShelf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.schemaVersion).toBe("1");
    expect(result.manifest.mechanics).toEqual(["branching-dialogue@1"]);
    expect(result.manifest.runtime).toEqual({
      compatibility: "adeena.experience-runtime@1",
      profile: "lightweight",
      requiresLlm: false,
      executableScripts: false,
    });
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

  it("records execution rules without interpreting effects", () => {
    expect(EXECUTION_SEMANTICS).toEqual({
      effectOrder: "array-order",
      effectAtomicity: "per-accepted-learner-action",
      outOfRangeEffect: "reject-action-do-not-clamp",
      invalidAction: "no-state-mutation",
      retryLimitEnforcement: "eng-003-gameplay-engine",
      endingReachability: "structural-graph-only",
    });
    expect(EXECUTION_RULES).toEqual([
      "Effects apply in array order.",
      "Effects are atomic for one accepted learner action.",
      "An effect that would leave its variable outside the declared bounds rejects the action. The value is not clamped.",
      "An invalid action does not mutate game state.",
      "Retry limits are enforced by the gameplay engine. Manifest validation only checks that a bounded retry names an exit scene.",
      "Structural reachability does not mean an ending is achievable under every gameplay state.",
    ]);
    expect(DIAGNOSTIC_CODES).toEqual([
      "asset.duplicate",
      "asset.invalid",
      "asset.unknown",
      "asset.unused",
      "bound.exceeded",
      "choice.duplicate",
      "content.executable",
      "ending.missing",
      "ending.unreachable",
      "events.unsupported-version",
      "graph.cycle-without-exit",
      "mechanic.unsupported",
      "runtime.defaulted",
      "runtime.unsupported",
      "scene.duplicate",
      "scene.initial-missing",
      "scene.transition-missing",
      "scene.unreachable-optional",
      "scene.unreachable-required",
      "schema.invalid",
      "schema.unknown-field",
      "schema.unsupported-version",
      "source.invalid",
      "state.duplicate",
      "state.effect-unsupported",
      "state.out-of-bounds",
      "state.unknown-variable",
    ]);
  });

  it("rejects duplicate choice, asset, and state-variable ids in their scopes", () => {
    const choices = structuredClone(sharedShelf);
    const ask = choices.scenes[0];
    if (ask.role !== "dialogue" || !ask.choices) throw new Error("expected dialogue");
    ask.choices[1] = { ...ask.choices[1], id: ask.choices[0].id };
    expect(codes(parseManifest(choices))).toContain("choice.duplicate");

    const assets = structuredClone(sharedShelf);
    assets.assets.push({ ...assets.assets[0] });
    expect(codes(parseManifest(assets))).toContain("asset.duplicate");

    const variables = structuredClone(sharedShelf);
    variables.state.variables.push({ ...variables.state.variables[0] });
    expect(codes(parseManifest(variables))).toContain("state.duplicate");
  });

  it("allows the same choice id in different scenes", () => {
    const story = structuredClone(sharedShelf);
    const purpose = story.scenes[1];
    if (purpose.role !== "dialogue" || !purpose.choices?.[0]) throw new Error("expected dialogue");
    purpose.choices[0] = { ...purpose.choices[0], id: "share-now" };
    expect(parseManifest(story).ok).toBe(true);
  });

  it("rejects an initial value outside the declared bounds", () => {
    const initial = parseManifest(storyWith([{ ...keepers, initial: 9 }], []));
    expect(initial.ok).toBe(false);
    expect(codes(initial)).toContain("state.out-of-bounds");

    const reversed = parseManifest(storyWith([{ ...keepers, min: 4, max: 1, initial: 4 }], []));
    expect(reversed.ok).toBe(false);
    expect(codes(reversed)).toContain("state.out-of-bounds");

    const missingStart = parseManifest(graphStory([
      {
        role: "ending",
        id: "done",
        title: "Done",
        text: "The conversation ends.",
        assetIds: [],
        required: true,
      },
    ], "missing"));
    expect(codes(missingStart)).toContain("scene.initial-missing");
  });

  it("rejects a zero adjustment and accepts positive and negative adjustments", () => {
    expect(parseManifest(storyWith([keepers], [{ type: "adjust", variableId: "keepers", delta: 1 }])).ok).toBe(true);
    expect(parseManifest(storyWith([keepers], [{ type: "adjust", variableId: "keepers", delta: -1 }])).ok).toBe(true);
    const zero = parseManifest(storyWith([keepers], [{ type: "adjust", variableId: "keepers", delta: 0 }]));
    expect(zero.ok).toBe(false);
    expect(codes(zero)).toContain("state.out-of-bounds");
  });

  it("keeps duplicate state effects in deterministic array order", () => {
    const effects = [
      { type: "adjust", variableId: "keepers", delta: 1 },
      { type: "adjust", variableId: "keepers", delta: 1 },
    ];
    const result = parseManifest(storyWith([keepers], effects));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const start = result.manifest.scenes[0];
    if (start.role !== "dialogue") throw new Error("expected dialogue");
    expect(start.choices[0].effects).toEqual(effects);
  });

  it("preserves multiple ordered effects that target the same variable", () => {
    const forward = [
      { type: "set", variableId: "keepers", value: 0 },
      { type: "adjust", variableId: "keepers", delta: 1 },
    ];
    const reverse = [
      { type: "adjust", variableId: "keepers", delta: 1 },
      { type: "set", variableId: "keepers", value: 0 },
    ];
    const first = parseManifest(storyWith([keepers], forward));
    const second = parseManifest(storyWith([keepers], reverse));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const firstStart = first.manifest.scenes[0];
    const secondStart = second.manifest.scenes[0];
    if (firstStart.role !== "dialogue" || secondStart.role !== "dialogue") throw new Error("expected dialogue");
    expect(firstStart.choices[0].effects).toEqual(forward);
    expect(secondStart.choices[0].effects).toEqual(reverse);
    expect(JSON.stringify(first.manifest)).not.toBe(JSON.stringify(second.manifest));
  });

  it("rejects effect sequences and assignments that cannot stay inside declared bounds", () => {
    const assigned = parseManifest(storyWith([keepers], [{ type: "set", variableId: "keepers", value: 4 }]));
    expect(codes(assigned)).toContain("state.out-of-bounds");

    const overflow = parseManifest(
      storyWith(
        [keepers],
        [
          { type: "adjust", variableId: "keepers", delta: 2 },
          { type: "adjust", variableId: "keepers", delta: 2 },
        ],
      ),
    );
    expect(overflow.ok).toBe(false);
    expect(codes(overflow)).toContain("state.out-of-bounds");

    const negativeOverflow = parseManifest(
      storyWith(
        [keepers],
        [
          { type: "adjust", variableId: "keepers", delta: -2 },
          { type: "adjust", variableId: "keepers", delta: -2 },
        ],
      ),
    );
    expect(codes(negativeOverflow)).toContain("state.out-of-bounds");

    const boundedSet = parseManifest(
      storyWith(
        [keepers],
        [
          { type: "set", variableId: "keepers", value: 3 },
          { type: "adjust", variableId: "keepers", delta: 1 },
        ],
      ),
    );
    expect(codes(boundedSet)).toContain("state.out-of-bounds");
  });

  it("accepts a structurally reachable ending without proving every gameplay state can reach it", () => {
    const result = parseManifest(
      storyWith([{ ...keepers, initial: 3 }], [{ type: "adjust", variableId: "keepers", delta: 1 }]),
    );
    expect(result.ok).toBe(true);
    expect(codes(result)).not.toContain("ending.unreachable");
  });

  it("rejects a graph whose endings are not structurally reachable", () => {
    const result = parseManifest(
      graphStory([
        {
          role: "dialogue",
          id: "start",
          title: "Start",
          text: "The conversation only returns to itself.",
          assetIds: [],
          required: true,
          choices: [{ id: "again", text: "Ask again.", effects: [], nextSceneId: "loop" }],
        },
        {
          role: "dialogue",
          id: "loop",
          title: "Loop",
          text: "There is still no way out.",
          assetIds: [],
          required: true,
          choices: [{ id: "back", text: "Return to the start.", effects: [], nextSceneId: "start" }],
          retry: { policy: "bounded-retry", maxAttempts: 2, onExhaustedSceneId: "start" },
        },
        {
          role: "ending",
          id: "done",
          title: "Unused ending",
          text: "Nothing in the graph leads here.",
          assetIds: [],
          required: true,
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining(["ending.unreachable", "graph.cycle-without-exit", "scene.unreachable-required"]),
    );
  });

  it("warns for an optional unreachable scene when another ending is reachable", () => {
    const result = parseManifest(
      graphStory([
        {
          role: "dialogue",
          id: "start",
          title: "Start",
          text: "The note can be left on the board.",
          assetIds: [],
          required: true,
          choices: [{ id: "finish", text: "Leave the note posted.", effects: [], nextSceneId: "done" }],
        },
        {
          role: "ending",
          id: "done",
          title: "Posted",
          text: "The note stays on the board.",
          assetIds: [],
          required: true,
        },
        {
          role: "ending",
          id: "aside",
          title: "Aside",
          text: "Nothing leads to this ending.",
          assetIds: [],
          required: false,
        },
      ]),
    );
    expect(result.ok).toBe(true);
    expect(codes(result)).toContain("scene.unreachable-optional");
    expect(codes(result)).not.toContain("ending.unreachable");
  });

  it("rejects asset and source locators outside the allowlist", () => {
    const traversal = structuredClone(sharedShelf);
    traversal.assets[0] = { ...traversal.assets[0], locator: "assets/../shelf.svg" };
    expect(codes(parseManifest(traversal))).toContain("asset.invalid");

    const remoteSource = structuredClone(sharedShelf);
    remoteSource.sources[0] = { ...remoteSource.sources[0], locator: "https://example.com/source.txt" };
    expect(codes(parseManifest(remoteSource))).toContain("source.invalid");
  });

  it("rejects unknown executable fields without calling them", () => {
    let called = false;
    const executable = {
      ...sharedShelf,
      run: () => {
        called = true;
      },
    };
    const result = parseManifest(executable);
    expect(called).toBe(false);
    expect(codes(result)).toContain("content.executable");

    const expression = parseManifest({
      ...sharedShelf,
      scenes: sharedShelf.scenes.map((scene) =>
        scene.role === "dialogue" && scene.id === "ask"
          ? { ...scene, expression: "state.keepers += 1" }
          : scene,
      ),
    });
    expect(codes(expression)).toContain("schema.unknown-field");
  });

  it("defaults an omitted v1 runtime through the compatibility adapter", () => {
    const input = structuredClone(sharedShelf);
    delete (input as { runtime?: unknown }).runtime;
    const before = structuredClone(input);
    const result = parseManifest(input);
    expect(input).toEqual(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.runtime.compatibility).toBe("adeena.experience-runtime@1");
    expect(result.manifest.runtime.requiresLlm).toBe(false);
    expect(result.manifest.runtime.executableScripts).toBe(false);
    expect(codes(result)).toContain("runtime.defaulted");
  });

  it("rejects an unsupported runtime compatibility", () => {
    const profile = parseManifest({
      ...sharedShelf,
      runtime: { ...sharedShelf.runtime, profile: "phaser" },
    });
    expect(codes(profile)).toContain("runtime.unsupported");

    const llm = parseManifest({
      ...sharedShelf,
      runtime: { ...sharedShelf.runtime, requiresLlm: true },
    });
    expect(codes(llm)).toContain("runtime.unsupported");

    const scripts = parseManifest({
      ...sharedShelf,
      runtime: { ...sharedShelf.runtime, executableScripts: true },
    });
    expect(codes(scripts)).toContain("runtime.unsupported");
  });

  it("rejects excessively large or deeply nested manifests", () => {
    const endings = Array.from({ length: MANIFEST_LIMITS.maxScenes + 1 }, (_, index) => ({
      role: "ending",
      id: `end-${index}`,
      title: "Ending",
      text: "The scene ends here.",
      assetIds: [],
      required: true,
    }));
    const tooManyScenes = parseManifest({ ...graphStory(endings), initialSceneId: "end-0" });
    expect(tooManyScenes.ok).toBe(false);
    expect(codes(tooManyScenes)).toContain("bound.exceeded");

    const wideScenes = structuredClone(sharedShelf) as { scenes: unknown[] };
    wideScenes.scenes = Array.from({ length: MANIFEST_LIMITS.maxArrayLength + 1 }, () => ({}));
    expect(codes(parseManifest(wideScenes))).toContain("bound.exceeded");

    let nested: unknown = { leaf: true };
    for (let depth = 0; depth < 12; depth += 1) nested = { child: nested };
    expect(codes(parseManifest(nested))).toContain("bound.exceeded");

    const wide: Record<string, number> = {};
    for (let index = 0; index < MANIFEST_LIMITS.maxNodes + 1; index += 1) wide[`k${index}`] = 1;
    expect(codes(parseManifest(wide))).toContain("bound.exceeded");

    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(codes(parseManifest(cycle))).toContain("bound.exceeded");

    const huge = structuredClone(sharedShelf);
    huge.title = "a".repeat(MANIFEST_LIMITS.maxStringLength + 1);
    expect(codes(parseManifest(huge))).toContain("bound.exceeded");
  });

  it("returns diagnostics in a stable path order", () => {
    const scenes: Array<Record<string, unknown>> = [
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
    ];
    scenes[1] = { ...scenes[1], id: "start" };
    const story = {
      ...graphStory(scenes),
      assets: [{ id: "card", kind: "image", locator: "https://example.com/app.js" }],
    };
    const result = parseManifest(story);
    const again = parseManifest(structuredClone(story));
    expect(again.diagnostics).toEqual(result.diagnostics);
    expect(result.diagnostics[0]).toMatchObject({ code: "asset.unused", path: ["assets", 0, "id"] });
    expect(result.diagnostics[1]).toMatchObject({ code: "asset.invalid", path: ["assets", 0, "locator"] });
    const duplicateAt = result.diagnostics.findIndex((item) => item.code === "scene.duplicate");
    expect(duplicateAt).toBeGreaterThan(1);
    expect(sortDiagnostics([...result.diagnostics].reverse())).toEqual(result.diagnostics);
    expect(
      sortDiagnostics([
        diagnostic("scene.duplicate", ["scenes", 10, "id"], "later"),
        diagnostic("scene.duplicate", ["scenes", 2, "id"], "earlier"),
      ]).map((item) => item.path[1]),
    ).toEqual([2, 10]);
  });

  it("does not mutate the manifest input", () => {
    const valid = deepFreeze(structuredClone(sharedShelf));
    const validBefore = JSON.stringify(valid);
    expect(parseManifest(valid).ok).toBe(true);
    expect(JSON.stringify(valid)).toBe(validBefore);

    const trimmed = structuredClone(sharedShelf);
    trimmed.title = "  Shared shelf  ";
    const trimmedBefore = structuredClone(trimmed);
    const trimmedResult = parseManifest(trimmed);
    expect(trimmed).toEqual(trimmedBefore);
    expect(trimmedResult.ok).toBe(true);
    if (trimmedResult.ok) expect(trimmedResult.manifest.title).toBe("Shared shelf");

    const invalid = structuredClone(sharedShelf);
    (invalid as { schemaVersion: string }).schemaVersion = "2";
    const invalidBefore = JSON.stringify(invalid);
    deepFreeze(invalid);
    expect(parseManifest(invalid).ok).toBe(false);
    expect(JSON.stringify(invalid)).toBe(invalidBefore);
  });

  it("round-trips a valid manifest through JSON", () => {
    const result = parseManifest(sharedShelf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const again = parseManifest(JSON.parse(JSON.stringify(result.manifest)));
    expect(again).toEqual(result);
    expect(parseManifest(JSON.parse(JSON.stringify(sharedShelf)))).toEqual(result);
  });
});
