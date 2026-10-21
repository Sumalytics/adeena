import { createGame, createInitialState, replay, transition, type GameAction } from "@adeena/player-core";
import type { ExperienceManifest } from "@adeena/experience-schema";

const STEP_LIMIT = 32;

export type SimulationReport = {
  ok: true;
  startSceneId: string;
  endingSceneIds: string[];
  longestChoicePath: number;
  endingValues: number[];
  replayReset: true;
  requiresLlm: false;
  steps: number;
};

export function simulateExperience(manifest: ExperienceManifest): { ok: true; report: SimulationReport } | { ok: false; code: string } {
  const created = createGame(manifest);
  if (!created.ok) return { ok: false, code: "simulation.invalid-manifest" };
  const game = created.game;
  if (game.manifest.runtime.requiresLlm !== false || game.manifest.runtime.executableScripts !== false) {
    return { ok: false, code: "simulation.runtime" };
  }
  const start = createInitialState(game);
  if (start.sceneId !== game.manifest.initialSceneId || start.variables.understanding !== 0) {
    return { ok: false, code: "simulation.start" };
  }

  const seen = new Set<string>();
  const endings: { sceneId: string; understanding: number; choices: number }[] = [];
  const visited = new Set<string>();
  const queue: { sceneId: string; variables: Readonly<Record<string, number>>; choices: number; state: typeof start }[] = [
    { sceneId: start.sceneId, variables: start.variables, choices: 0, state: start },
  ];
  let steps = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    steps += 1;
    if (steps > STEP_LIMIT) return { ok: false, code: "simulation.limit" };
    const key = `${current.sceneId}:${current.variables.understanding ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    visited.add(current.sceneId);
    const scene = game.scenes.get(current.sceneId);
    if (!scene) return { ok: false, code: "simulation.missing-scene" };
    if (scene.role === "ending") {
      endings.push({
        sceneId: current.sceneId,
        understanding: current.variables.understanding ?? 0,
        choices: current.choices,
      });
      continue;
    }
    for (const choice of scene.choices) {
      const result = transition(game, current.state, { type: "choose", choiceId: choice.id });
      if (!result.accepted) return { ok: false, code: "simulation.transition" };
      if (result.state.sceneId !== choice.nextSceneId) return { ok: false, code: "simulation.target" };
      queue.push({
        sceneId: result.state.sceneId,
        variables: result.state.variables,
        choices: current.choices + 1,
        state: result.state,
      });
    }
  }

  const endingIds = [...new Set(endings.map((ending) => ending.sceneId))];
  const values = [...new Set(endings.map((ending) => ending.understanding))];
  const longest = endings.reduce((max, ending) => Math.max(max, ending.choices), 0);
  if (endingIds.length < 2 || values.length < 2 || longest < 2) return { ok: false, code: "simulation.quality" };
  for (const scene of game.manifest.scenes) {
    if (!visited.has(scene.id)) return { ok: false, code: "simulation.unreachable" };
  }

  const longPath = pathTo(game.manifest, (choices) => choices >= 2);
  if (!longPath) return { ok: false, code: "simulation.path" };
  const actions: GameAction[] = [...longPath, { type: "restart" }];
  const reset = replay(game, actions);
  if (reset.state.sceneId !== game.manifest.initialSceneId || reset.state.variables.understanding !== 0 || reset.state.status !== "playing") {
    return { ok: false, code: "simulation.replay" };
  }
  return {
    ok: true,
    report: {
      ok: true,
      startSceneId: start.sceneId,
      endingSceneIds: endingIds,
      longestChoicePath: longest,
      endingValues: values,
      replayReset: true,
      requiresLlm: false,
      steps,
    },
  };
}

function pathTo(manifest: ExperienceManifest, accept: (choices: number) => boolean) {
  const scenes = new Map(manifest.scenes.map((scene) => [scene.id, scene]));
  const queue: { sceneId: string; actions: GameAction[] }[] = [{ sceneId: manifest.initialSceneId, actions: [] }];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(`${current.sceneId}:${current.actions.length}`)) continue;
    seen.add(`${current.sceneId}:${current.actions.length}`);
    const scene = scenes.get(current.sceneId);
    if (!scene) return null;
    if (scene.role === "ending") {
      if (accept(current.actions.length)) return current.actions;
      continue;
    }
    for (const choice of scene.choices) {
      queue.push({
        sceneId: choice.nextSceneId,
        actions: [...current.actions, { type: "choose", choiceId: choice.id }],
      });
    }
  }
  return null;
}
