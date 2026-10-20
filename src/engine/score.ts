import type { PlayerV1 } from "@/contracts/player";

export type ScoreResult =
  | { status: "scored"; correct: boolean; points: 0 | 1 }
  | { status: "unknown-scene" }
  | { status: "unknown-option" };

/** Content-independent rule: one point when the selected option is marked correct. */
export function scoreChoice(
  manifest: PlayerV1,
  sceneId: string,
  optionId: string,
): ScoreResult {
  const scene = manifest.scenes.find((item) => item.id === sceneId);
  if (!scene || scene.interaction?.type !== "choice") {
    return { status: "unknown-scene" };
  }
  const option = scene.interaction.options.find((item) => item.id === optionId);
  if (!option) return { status: "unknown-option" };
  return {
    status: "scored",
    correct: option.correct,
    points: option.correct ? 1 : 0,
  };
}
