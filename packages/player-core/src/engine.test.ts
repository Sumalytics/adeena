import { sharedShelf } from "@adeena/experience-schema";
import { describe, expect, it } from "vitest";
import { createGame, createInitialState, replay, transition } from "./index";
import type { GameAction, GameState, PlayableGame } from "./types";

const experienceId = "10000000-0000-4000-8000-000000000001";
const versionId = "10000000-0000-4000-8000-000000000002";
const sourceId = "10000000-0000-4000-8000-000000000003";

function manifest(scenes: unknown[], variables: unknown[] = [], initialSceneId = "start") {
  return {
    schema: "adeena.experience-manifest",
    schemaVersion: "1",
    experienceId,
    versionId,
    title: "Engine check",
    locale: "en",
    mechanics: ["branching-dialogue@1"],
    initialSceneId,
    scenes,
    state: { variables },
    assets: [],
    sources: [
      {
        sourceId,
        locator: "synthetic:engine-check",
        note: "Synthetic engine fixture, not approved source material.",
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

function dialogue(
  id: string,
  choices: unknown[],
  retry?: { policy: "bounded-retry"; maxAttempts: number; onExhaustedSceneId: string },
) {
  return {
    role: "dialogue",
    id,
    title: "Scene",
    text: "A neighbor asks what should happen next.",
    assetIds: [],
    required: true,
    choices,
    ...(retry ? { retry } : {}),
  };
}

function ending(id: string) {
  return {
    role: "ending",
    id,
    title: "Ending",
    text: "The conversation ends.",
    assetIds: [],
    required: true,
  };
}

function choice(id: string, nextSceneId: string, effects: unknown[] = []) {
  return { id, text: "Take this action.", effects, nextSceneId };
}

function meters(initial = 0, min = 0, max = 3) {
  return [{ id: "meters", type: "integer", min, max, initial }];
}

function playable(input: unknown): PlayableGame {
  const created = createGame(input);
  if (!created.ok) throw new Error(created.diagnostics.map((item) => item.code).join(","));
  return created.game;
}

function choose(choiceId: string): GameAction {
  return { type: "choose", choiceId };
}

function step(game: PlayableGame, state: GameState, choiceId: string) {
  const result = transition(game, state, choose(choiceId));
  expect(result.accepted).toBe(true);
  if (!result.accepted) throw new Error("expected an accepted action");
  return result;
}

describe("player-core", () => {
  it("initializes from the validated manifest", () => {
    const game = playable(sharedShelf);
    const state = createInitialState(game);
    expect(state).toEqual({
      sceneId: "ask",
      variables: { "shared-tools": 3, repairs: 0, keepers: 0 },
      retryAttempts: {},
      status: "playing",
      revision: 0,
    });
    expect(game.scenes.has("ask")).toBe(true);
    expect(game.variables.get("keepers")?.max).toBe(3);
  });

  it("follows different choices to different outcomes", () => {
    const game = playable(sharedShelf);
    const start = createInitialState(game);
    const recorded = step(game, step(game, start, "share-now").state, "write-card");
    const keeper = step(game, step(game, start, "share-now").state, "tell-keeper");
    const handTool = step(game, step(game, start, "ask-purpose").state, "offer-hand-tool");

    expect(recorded.state).toMatchObject({
      sceneId: "card-ending",
      status: "completed",
      revision: 2,
      variables: { "shared-tools": 2, repairs: 0, keepers: 0 },
    });
    expect(keeper.state).toMatchObject({
      sceneId: "keeper-ending",
      status: "completed",
      variables: { "shared-tools": 2, repairs: 0, keepers: 1 },
    });
    expect(handTool.state).toMatchObject({
      sceneId: "hand-tool-ending",
      status: "completed",
      variables: { "shared-tools": 3, repairs: 0, keepers: 0 },
    });
    expect(start.revision).toBe(0);
    expect(start.variables["shared-tools"]).toBe(3);
  });

  it("applies ordered effects on one variable and rolls back an invalid intermediate", () => {
    const ordered = playable(
      manifest(
        [
          dialogue("start", [
            choice("set-then-add", "done", [
              { type: "set", variableId: "meters", value: 0 },
              { type: "adjust", variableId: "meters", delta: 1 },
            ]),
            choice("add-then-set", "done", [
              { type: "adjust", variableId: "meters", delta: 1 },
              { type: "set", variableId: "meters", value: 0 },
            ]),
          ]),
          ending("done"),
        ],
        meters(1),
      ),
    );
    const start = createInitialState(ordered);
    expect(step(ordered, start, "set-then-add").state.variables.meters).toBe(1);
    expect(step(ordered, start, "add-then-set").state.variables.meters).toBe(0);

    const atomic = playable(
      manifest(
        [
          dialogue("start", [
            choice("overflow", "done", [
              { type: "adjust", variableId: "meters", delta: -1 },
              { type: "adjust", variableId: "meters", delta: 1 },
              { type: "adjust", variableId: "meters", delta: 1 },
            ]),
          ]),
          ending("done"),
        ],
        meters(3),
      ),
    );
    const before = createInitialState(atomic);
    const rejected = transition(atomic, before, choose("overflow"));
    expect(rejected).toEqual({ accepted: false, state: before, reason: "STATE_OUT_OF_BOUNDS", facts: [] });
    expect(rejected.state).toBe(before);
  });

  it("accepts the declared bounds and rejects movement past them", () => {
    const low = playable(
      manifest(
        [
          dialogue("start", [
            choice("down", "done", [{ type: "adjust", variableId: "meters", delta: -1 }]),
            choice("up", "done", [{ type: "adjust", variableId: "meters", delta: 1 }]),
          ]),
          ending("done"),
        ],
        meters(0),
      ),
    );
    const atMin = createInitialState(low);
    expect(transition(low, atMin, choose("down"))).toMatchObject({ accepted: false, reason: "STATE_OUT_OF_BOUNDS" });
    expect(step(low, atMin, "up").state.variables.meters).toBe(1);

    const high = playable(
      manifest(
        [
          dialogue("start", [
            choice("down", "done", [{ type: "adjust", variableId: "meters", delta: -1 }]),
            choice("up", "done", [{ type: "adjust", variableId: "meters", delta: 1 }]),
            choice("top", "done", [{ type: "set", variableId: "meters", value: 3 }]),
            choice("bottom", "done", [{ type: "set", variableId: "meters", value: 0 }]),
          ]),
          ending("done"),
        ],
        meters(3),
      ),
    );
    const atMax = createInitialState(high);
    expect(transition(high, atMax, choose("up"))).toMatchObject({ accepted: false, reason: "STATE_OUT_OF_BOUNDS" });
    expect(step(high, atMax, "down").state.variables.meters).toBe(2);
    expect(step(high, atMax, "top").state.variables.meters).toBe(3);
    expect(step(high, atMax, "bottom").state.variables.meters).toBe(0);
  });

  it("rejects unknown choices and malformed scenes without changing state", () => {
    const game = playable(sharedShelf);
    const state = createInitialState(game);
    const missing = transition(game, state, choose("not-a-choice"));
    expect(missing).toEqual({ accepted: false, state, reason: "INVALID_ACTION", facts: [] });
    expect(transition(game, state, { type: "jump" })).toEqual({
      accepted: false,
      state,
      reason: "INVALID_ACTION",
      facts: [],
    });
    const broken = { ...state, sceneId: "missing-scene" };
    expect(transition(game, broken, choose("share-now"))).toEqual({
      accepted: false,
      state: broken,
      reason: "INVALID_TRANSITION",
      facts: [],
    });
    expect(state.revision).toBe(0);
  });

  it("counts the first visit as zero and later re-entries as attempts", () => {
    const game = playable(
      manifest(
        [
          dialogue("start", [choice("enter", "gate")]),
          dialogue(
            "gate",
            [
              choice("again", "gate", [{ type: "adjust", variableId: "meters", delta: 1 }]),
              choice("leave", "done"),
            ],
            { policy: "bounded-retry", maxAttempts: 2, onExhaustedSceneId: "done" },
          ),
          ending("done"),
        ],
        meters(0, 0, 5),
      ),
    );
    const start = createInitialState(game);
    expect(start.retryAttempts).toEqual({});
    const entered = step(game, start, "enter");
    expect(entered.state).toMatchObject({ sceneId: "gate", retryAttempts: { gate: 0 }, revision: 1 });
    const first = step(game, entered.state, "again");
    const second = step(game, first.state, "again");
    expect(first.state.retryAttempts.gate).toBe(1);
    expect(second.state.retryAttempts.gate).toBe(2);
    expect(second.state.variables.meters).toBe(2);
  });

  it("redirects a self-loop on exhaustion and suppresses that choice's effects", () => {
    const game = playable(
      manifest(
        [
          dialogue(
            "start",
            [
              choice("again", "start", [{ type: "adjust", variableId: "meters", delta: 1 }]),
              choice("leave", "done", [{ type: "adjust", variableId: "meters", delta: 1 }]),
            ],
            { policy: "bounded-retry", maxAttempts: 2, onExhaustedSceneId: "done" },
          ),
          ending("done"),
        ],
        meters(0, 0, 5),
      ),
    );
    let state = createInitialState(game);
    expect(state.retryAttempts).toEqual({ start: 0 });
    state = step(game, state, "again").state;
    state = step(game, state, "again").state;
    expect(state).toMatchObject({ sceneId: "start", retryAttempts: { start: 2 }, variables: { meters: 2 } });
    const exhausted = step(game, state, "again");
    expect(exhausted.state).toMatchObject({
      sceneId: "done",
      status: "completed",
      retryAttempts: { start: 2 },
      variables: { meters: 2 },
      revision: 3,
    });
    expect(exhausted.facts.map((item) => item.kind)).toEqual([
      "retry_exhausted",
      "scene_entered",
      "experience_completed",
    ]);
    expect(exhausted.facts[0]).toMatchObject({ sceneId: "start", choiceId: "again" });
  });

  it("counts retries across a multi-scene cycle and redirects without applying the return effects", () => {
    const game = playable(
      manifest(
        [
          dialogue(
            "a",
            [choice("to-b", "b")],
            { policy: "bounded-retry", maxAttempts: 1, onExhaustedSceneId: "done" },
          ),
          dialogue("b", [
            choice("back", "a", [{ type: "adjust", variableId: "meters", delta: 1 }]),
            choice("finish", "done"),
          ]),
          ending("done"),
        ],
        meters(0, 0, 5),
        "a",
      ),
    );
    let state = createInitialState(game);
    expect(state.retryAttempts).toEqual({ a: 0 });
    state = step(game, state, "to-b").state;
    const returned = step(game, state, "back");
    expect(returned.state).toMatchObject({
      sceneId: "a",
      retryAttempts: { a: 1 },
      variables: { meters: 1 },
    });
    state = step(game, returned.state, "to-b").state;
    const exhausted = step(game, state, "back");
    expect(exhausted.state).toMatchObject({
      sceneId: "done",
      status: "completed",
      retryAttempts: { a: 1 },
      variables: { meters: 1 },
    });
    expect(exhausted.facts[0]?.kind).toBe("retry_exhausted");
  });

  it("completes only on an ending and then rejects further choices", () => {
    const game = playable(sharedShelf);
    const done = step(game, step(game, createInitialState(game), "ask-purpose").state, "offer-hand-tool");
    expect(done.state.status).toBe("completed");
    expect(done.facts.map((item) => item.kind)).toEqual(["choice_applied", "scene_entered", "experience_completed"]);
    const rejected = transition(game, done.state, choose("offer-hand-tool"));
    expect(rejected).toEqual({ accepted: false, state: done.state, reason: "ALREADY_COMPLETED", facts: [] });
  });

  it("restarts to the initial state and replays the same actions identically", () => {
    const game = playable(sharedShelf);
    const started = createInitialState(game);
    const moved = step(game, started, "point-to-board").state;
    const restarted = transition(game, moved, { type: "restart" });
    expect(restarted.accepted).toBe(true);
    if (!restarted.accepted) return;
    expect(restarted.state).toEqual(started);
    expect(restarted.facts.map((item) => item.kind)).toEqual(["experience_restarted", "scene_entered"]);
    expect(restarted.state.revision).toBe(0);

    const actions: GameAction[] = [
      choose("share-now"),
      choose("not-real"),
      choose("tell-keeper"),
      { type: "restart" },
      choose("point-to-board"),
      choose("walk-back"),
    ];
    const first = replay(game, actions);
    const second = replay(game, actions);
    expect(second).toEqual(first);
    let state = createInitialState(game);
    for (const action of actions) state = transition(game, state, action).state;
    expect(first.state).toEqual(state);
    expect(first.facts.map((item) => item.sequence)).toEqual(first.facts.map((_, index) => index));
    expect(first.facts[0]).toMatchObject({
      schemaVersion: "1",
      experienceId: sharedShelf.experienceId,
      versionId: sharedShelf.versionId,
      mechanic: "branching-dialogue@1",
      kind: "experience_started",
      revision: 0,
    });
    expect(JSON.stringify(first.facts)).not.toMatch(/timestamp|mastery|learner|ipAddress/i);
    expect(first.facts.some((item) => item.kind === "experience_restarted")).toBe(true);
    expect(first.state.sceneId).toBe("ask");
  });

  it("does not mutate the manifest or a rejected state's objects", () => {
    const input = structuredClone(sharedShelf);
    const before = structuredClone(input);
    let called = false;
    const hostile = {
      ...input,
      run: () => {
        called = true;
      },
    };
    expect(createGame(hostile).ok).toBe(false);
    expect(called).toBe(false);
    expect(input).toEqual(before);

    const created = createGame(input);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const state = createInitialState(created.game);
    const snapshot = structuredClone(state);
    transition(created.game, state, choose("share-now"));
    expect(state).toEqual(snapshot);
    expect(input).toEqual(before);
    expect(Object.isFrozen(created.game.manifest)).toBe(true);
  });

  it("rejects unvalidated, unsupported, and legacy manifests", () => {
    expect(createGame({ schema: "adeena.experience-manifest" }).ok).toBe(false);
    expect(createGame({ ...sharedShelf, schemaVersion: "2" }).ok).toBe(false);
    expect(createGame({ ...sharedShelf, mechanics: ["phaser@1"] }).ok).toBe(false);
    expect(
      createGame({
        ...sharedShelf,
        runtime: { ...sharedShelf.runtime, profile: "phaser" },
      }).ok,
    ).toBe(false);
    expect(createGame({ contract: "PLAYER-v1", scenes: [], script: "alert(1)" }).ok).toBe(false);
    const brokenState = createInitialState(playable(sharedShelf));
    const game = playable(sharedShelf);
    expect(
      transition(game, { ...brokenState, variables: { ...brokenState.variables, keepers: 9 } }, choose("share-now")),
    ).toMatchObject({ accepted: false, reason: "INVALID_TRANSITION" });
  });

  it("keeps a representative action loop inexpensive on this machine", () => {
    const game = playable(
      manifest([
        dialogue("start", [choice("leave", "done")]),
        ending("done"),
      ]),
    );
    const started = performance.now();
    let state = createInitialState(game);
    for (let index = 0; index < 20000; index += 1) {
      const left = transition(game, state, choose("leave"));
      if (!left.accepted) break;
      const restarted = transition(game, left.state, { type: "restart" });
      if (!restarted.accepted) break;
      state = restarted.state;
    }
    const elapsed = performance.now() - started;
    console.info(`player-core local sample: 20000 leave/restart cycles in ${elapsed.toFixed(1)}ms`);
    expect(state.revision).toBe(0);
    expect(elapsed).toBeLessThan(5000);
  });
});
