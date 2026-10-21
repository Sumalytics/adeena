import type { PlayableGame, RuntimeFact } from "@adeena/player-core";
import type {
  ExperiencePresentation,
  IllustrationCue,
  PlayerMeter,
  PlayerSession,
  PlayerSummaryItem,
  PlayerView,
} from "./types";
import { EXPERIENCE_UNAVAILABLE } from "./types";

/**
 * Builds a view from engine state. It does not apply effects or decide transitions.
 * Variables without an explicit presentation entry are omitted. Their ids are not rewritten into labels.
 */
export function presentPlayer(session: PlayerSession, presentation: ExperiencePresentation): PlayerView {
  if (session.phase === "unavailable" || !session.game || !session.state) {
    return { kind: "unavailable", message: EXPERIENCE_UNAVAILABLE };
  }
  if (!session.started) {
    return {
      kind: "cover",
      locale: session.game.manifest.locale,
      title: session.game.manifest.title,
      intro: presentation.intro,
      meters: meters(session, presentation),
    };
  }

  const scene = session.game.scenes.get(session.state.sceneId);
  if (!scene) return { kind: "unavailable", message: EXPERIENCE_UNAVAILABLE };

  const cue = presentation.scenes[scene.id];
  const illustration: IllustrationCue = cue
    ? { sceneId: scene.id, description: cue.description, decorative: cue.decorative, missing: false }
    : { sceneId: scene.id, description: "", decorative: false, missing: true };

  const choices =
    scene.role === "dialogue" && session.state.status === "playing"
      ? scene.choices.map((choice) => ({ id: choice.id, label: choice.text }))
      : [];

  return {
    kind: session.state.status === "completed" ? "ending" : "scene",
    locale: session.game.manifest.locale,
    title: session.game.manifest.title,
    sceneId: scene.id,
    sceneTitle: scene.title,
    narrative: scene.text,
    choices,
    meters: meters(session, presentation),
    changes: changes(session, presentation),
    chosenText: session.previousVariables ? latestChoiceText(session.game, session.facts) : null,
    summary: session.state.status === "completed" ? summarize(session.game, session.facts) : [],
    progress: progressLabel(session.facts),
    illustration,
    notice: session.notice,
    busy: session.busy,
    revision: session.state.revision,
  };
}

function meters(session: PlayerSession, presentation: ExperiencePresentation): PlayerMeter[] {
  if (!session.state) return [];
  const items: PlayerMeter[] = [];
  for (const variable of presentation.variables) {
    const value = session.state.variables[variable.id];
    if (typeof value !== "number") continue;
    items.push({ id: variable.id, label: variable.label, value });
  }
  return items;
}

function changes(session: PlayerSession, presentation: ExperiencePresentation): string[] {
  if (!session.previousVariables || !session.state) return [];
  const lines: string[] = [];
  for (const variable of presentation.variables) {
    const before = session.previousVariables[variable.id];
    const after = session.state.variables[variable.id];
    if (typeof before !== "number" || typeof after !== "number" || before === after) continue;
    lines.push(variable.changeText(before, after));
  }
  return lines;
}

function latestChoiceText(game: PlayableGame, facts: readonly RuntimeFact[]): string | null {
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const fact = facts[index];
    if (!fact || fact.kind !== "choice_applied" || !fact.choiceId) continue;
    const scene = game.scenes.get(fact.sceneId);
    if (!scene || scene.role !== "dialogue") return null;
    return scene.choices.find((choice) => choice.id === fact.choiceId)?.text ?? null;
  }
  return null;
}

function summarize(game: PlayableGame, facts: readonly RuntimeFact[]): PlayerSummaryItem[] {
  const items: PlayerSummaryItem[] = [];
  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index];
    if (!fact || fact.kind !== "choice_applied" || !fact.choiceId) continue;
    const scene = game.scenes.get(fact.sceneId);
    if (!scene || scene.role !== "dialogue") continue;
    const choice = scene.choices.find((item) => item.id === fact.choiceId);
    const next = facts.slice(index + 1).find((item) => item.kind === "scene_entered");
    const outcome = next ? game.scenes.get(next.sceneId) : undefined;
    if (!choice || !outcome) continue;
    items.push({ choice: choice.text, outcome: outcome.title });
  }
  return items;
}

function progressLabel(facts: readonly RuntimeFact[]): string {
  const count = facts.filter((fact) => fact.kind === "choice_applied").length;
  return count === 1 ? "1 choice made" : `${count} choices made`;
}
