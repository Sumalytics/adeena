import { parseManifest, type ExperienceManifest } from "@adeena/experience-schema";
import type { CreateGameResult, GameState, PlayableGame, RuntimeFact, TransitionResult } from "./types";

const NO_FACTS = [] as const;

/**
 * Retry edge cases for branching-dialogue@1:
 * - The first entry into a retry-governed scene records 0. That visit is not an attempt.
 * - A later choice whose next scene is that same scene counts one attempt.
 * - A self-loop is a re-entry. A path through other scenes counts only when it returns.
 * - When the next attempt would be greater than maxAttempts, that choice is redirected to
 *   onExhaustedSceneId and its effects are not applied. The counter stays at maxAttempts.
 * - The redirect is one hop. The target scene is not checked for its own retry in the same action.
 *   An unvisited retry target records its initial 0. An already visited target keeps its counter.
 * - Restart restores the initial scene, variables, retry counters, and revision 0.
 */
export function createGame(manifestInput: unknown): CreateGameResult {
  const parsed = parseManifest(manifestInput);
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  return { ok: true, game: indexManifest(parsed.manifest) };
}

export function createInitialState(game: PlayableGame): GameState {
  const scene = game.scenes.get(game.manifest.initialSceneId);
  if (!scene) {
    throw new Error("Validated manifest is missing its initial scene");
  }
  const variables: Record<string, number> = {};
  for (const variable of game.manifest.state.variables) {
    variables[variable.id] = variable.initial;
  }
  const retryAttempts: Record<string, number> = {};
  if (scene.role === "dialogue" && scene.retry) {
    retryAttempts[scene.id] = 0;
  }
  return sealState({
    sceneId: scene.id,
    variables,
    retryAttempts,
    status: scene.role === "ending" ? "completed" : "playing",
    revision: 0,
  });
}

export function openingFacts(game: PlayableGame, state: GameState): RuntimeFact[] {
  const facts = [
    fact(game, state.revision, 0, "experience_started", state.sceneId),
    fact(game, state.revision, 1, "scene_entered", state.sceneId),
  ];
  if (state.status === "completed") {
    facts.push(fact(game, state.revision, facts.length, "experience_completed", state.sceneId));
  }
  return facts;
}

export function transition(game: PlayableGame, state: GameState, action: unknown): TransitionResult {
  if (!isIntactState(game, state)) {
    return { accepted: false, state, reason: "INVALID_TRANSITION", facts: NO_FACTS };
  }
  if (isRestart(action)) {
    return restart(game);
  }
  if (!isChoose(action)) {
    return { accepted: false, state, reason: "INVALID_ACTION", facts: NO_FACTS };
  }
  if (state.status === "completed") {
    return { accepted: false, state, reason: "ALREADY_COMPLETED", facts: NO_FACTS };
  }

  const scene = game.scenes.get(state.sceneId);
  if (!scene || scene.role !== "dialogue") {
    return { accepted: false, state, reason: "INVALID_TRANSITION", facts: NO_FACTS };
  }
  const choice = game.choices.get(scene.id)?.get(action.choiceId);
  if (!choice) {
    return { accepted: false, state, reason: "INVALID_ACTION", facts: NO_FACTS };
  }
  const chosenScene = game.scenes.get(choice.nextSceneId);
  if (!chosenScene) {
    return { accepted: false, state, reason: "INVALID_TRANSITION", facts: NO_FACTS };
  }

  const resolved = resolveDestination(game, state, chosenScene);
  if (!resolved.ok) {
    return { accepted: false, state, reason: "INVALID_TRANSITION", facts: NO_FACTS };
  }

  let variables = state.variables;
  if (!resolved.suppressEffects) {
    const applied = applyEffects(game, state.variables, choice.effects);
    if (applied === "invalid") {
      return { accepted: false, state, reason: "INVALID_TRANSITION", facts: NO_FACTS };
    }
    if (applied === "bounds") {
      return { accepted: false, state, reason: "STATE_OUT_OF_BOUNDS", facts: NO_FACTS };
    }
    variables = applied;
  }

  const next = sealState({
    sceneId: resolved.destination.id,
    variables,
    retryAttempts: resolved.retryAttempts,
    status: resolved.destination.role === "ending" ? "completed" : "playing",
    revision: state.revision + 1,
  });
  return {
    accepted: true,
    state: next,
    facts: actionFacts(game, state.sceneId, action.choiceId, resolved, next),
  };
}

type DialogueChoice = Extract<ExperienceManifest["scenes"][number], { role: "dialogue" }>["choices"][number];

function indexManifest(manifest: ExperienceManifest): PlayableGame {
  const scenes = new Map<string, ExperienceManifest["scenes"][number]>();
  const choices = new Map<string, ReadonlyMap<string, DialogueChoice>>();
  for (const scene of manifest.scenes) {
    scenes.set(scene.id, scene);
    if (scene.role !== "dialogue") continue;
    const byId = new Map<string, DialogueChoice>();
    for (const choice of scene.choices) byId.set(choice.id, choice);
    choices.set(scene.id, byId);
  }
  const variables = new Map<string, ExperienceManifest["state"]["variables"][number]>();
  for (const variable of manifest.state.variables) variables.set(variable.id, variable);
  return {
    manifest: deepFreeze(manifest),
    scenes,
    variables,
    choices,
  };
}

function resolveDestination(
  game: PlayableGame,
  state: GameState,
  chosen: ExperienceManifest["scenes"][number],
):
  | {
      ok: true;
      destination: ExperienceManifest["scenes"][number];
      retryAttempts: GameState["retryAttempts"];
      suppressEffects: boolean;
      exhaustedSceneId?: string;
    }
  | { ok: false } {
  if (chosen.role !== "dialogue" || !chosen.retry) {
    return { ok: true, destination: chosen, retryAttempts: state.retryAttempts, suppressEffects: false };
  }

  const policy = chosen.retry;
  if (!Object.hasOwn(state.retryAttempts, chosen.id)) {
    return {
      ok: true,
      destination: chosen,
      retryAttempts: { ...state.retryAttempts, [chosen.id]: 0 },
      suppressEffects: false,
    };
  }

  const nextCount = (state.retryAttempts[chosen.id] ?? 0) + 1;
  if (nextCount <= policy.maxAttempts) {
    return {
      ok: true,
      destination: chosen,
      retryAttempts: { ...state.retryAttempts, [chosen.id]: nextCount },
      suppressEffects: false,
    };
  }

  const exhaust = game.scenes.get(policy.onExhaustedSceneId);
  if (!exhaust) return { ok: false };
  let retryAttempts = state.retryAttempts;
  if (exhaust.role === "dialogue" && exhaust.retry && !Object.hasOwn(retryAttempts, exhaust.id)) {
    retryAttempts = { ...retryAttempts, [exhaust.id]: 0 };
  }
  return {
    ok: true,
    destination: exhaust,
    retryAttempts,
    suppressEffects: true,
    exhaustedSceneId: chosen.id,
  };
}

type StateEffect =
  | { type: "adjust"; variableId: string; delta: number }
  | { type: "set"; variableId: string; value: number };

function applyEffects(
  game: PlayableGame,
  variables: GameState["variables"],
  effects: readonly StateEffect[],
): GameState["variables"] | "bounds" | "invalid" {
  if (effects.length === 0) return variables;
  const draft: Record<string, number> = { ...variables };
  for (const effect of effects) {
    const spec = game.variables.get(effect.variableId);
    const current = draft[effect.variableId];
    if (!spec || !Number.isInteger(current)) return "invalid";
    const updated = effect.type === "set" ? effect.value : current + effect.delta;
    if (!Number.isInteger(updated) || updated < spec.min || updated > spec.max) return "bounds";
    draft[effect.variableId] = updated;
  }
  return draft;
}

function actionFacts(
  game: PlayableGame,
  fromSceneId: string,
  choiceId: string,
  resolved: { destination: { id: string; role: string }; exhaustedSceneId?: string },
  next: GameState,
): RuntimeFact[] {
  const facts: RuntimeFact[] = [];
  if (resolved.exhaustedSceneId) {
    facts.push(fact(game, next.revision, facts.length, "retry_exhausted", resolved.exhaustedSceneId, choiceId));
  } else {
    facts.push(fact(game, next.revision, facts.length, "choice_applied", fromSceneId, choiceId));
  }
  facts.push(fact(game, next.revision, facts.length, "scene_entered", resolved.destination.id));
  if (resolved.destination.role === "ending") {
    facts.push(fact(game, next.revision, facts.length, "experience_completed", resolved.destination.id));
  }
  return facts;
}

function restart(game: PlayableGame): TransitionResult {
  const state = createInitialState(game);
  const facts = [
    fact(game, state.revision, 0, "experience_restarted", state.sceneId),
    fact(game, state.revision, 1, "scene_entered", state.sceneId),
  ];
  if (state.status === "completed") {
    facts.push(fact(game, state.revision, facts.length, "experience_completed", state.sceneId));
  }
  return { accepted: true, state, facts };
}

function fact(
  game: PlayableGame,
  revision: number,
  sequence: number,
  kind: RuntimeFact["kind"],
  sceneId: string,
  choiceId?: string,
): RuntimeFact {
  const event: RuntimeFact = {
    schemaVersion: "1",
    experienceId: game.manifest.experienceId,
    versionId: game.manifest.versionId,
    mechanic: game.manifest.mechanics[0],
    revision,
    sequence,
    kind,
    sceneId,
  };
  if (choiceId !== undefined) event.choiceId = choiceId;
  return event;
}

function isIntactState(game: PlayableGame, state: GameState): boolean {
  if (!state || typeof state !== "object") return false;
  if (state.status !== "playing" && state.status !== "completed") return false;
  if (!Number.isInteger(state.revision) || state.revision < 0) return false;
  if (typeof state.sceneId !== "string") return false;
  const scene = game.scenes.get(state.sceneId);
  if (!scene) return false;
  if (scene.role === "ending" && state.status !== "completed") return false;
  if (scene.role === "dialogue" && state.status !== "playing") return false;
  if (!state.variables || typeof state.variables !== "object" || Array.isArray(state.variables)) return false;
  if (!state.retryAttempts || typeof state.retryAttempts !== "object" || Array.isArray(state.retryAttempts)) return false;

  const keys = Object.keys(state.variables);
  if (keys.length !== game.variables.size) return false;
  for (const [id, spec] of game.variables) {
    const value = state.variables[id];
    if (!Number.isInteger(value) || value < spec.min || value > spec.max) return false;
  }
  for (const key of keys) {
    if (!game.variables.has(key)) return false;
  }

  for (const [sceneId, count] of Object.entries(state.retryAttempts)) {
    const retryScene = game.scenes.get(sceneId);
    if (!retryScene || retryScene.role !== "dialogue" || !retryScene.retry) return false;
    if (!Number.isInteger(count) || count < 0 || count > retryScene.retry.maxAttempts) return false;
  }
  return true;
}

function isRestart(action: unknown): action is { type: "restart" } {
  return !!action && typeof action === "object" && (action as { type?: unknown }).type === "restart";
}

function isChoose(action: unknown): action is { type: "choose"; choiceId: string } {
  if (!action || typeof action !== "object") return false;
  const candidate = action as { type?: unknown; choiceId?: unknown };
  return candidate.type === "choose" && typeof candidate.choiceId === "string" && candidate.choiceId.length > 0;
}

function sealState(state: GameState): GameState {
  return Object.freeze({
    sceneId: state.sceneId,
    variables: Object.freeze({ ...state.variables }),
    retryAttempts: Object.freeze({ ...state.retryAttempts }),
    status: state.status,
    revision: state.revision,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as object)) deepFreeze(nested);
  }
  return value;
}
