import type { PoseName } from "./poses";

/**
 * Presentation-only reactions. These names do not score the learner.
 * Scene ids arrive from the player. This module does not read variables.
 * The card-ending scene uses celebrate as its authored closing pose.
 * The other endings stay on idle, so finishing is not treated as a win.
 */
export type CharacterReaction =
  | "idle"
  | "greet"
  | "think"
  | "explain"
  | "encourage"
  | "react-positive"
  | "react-concerned"
  | "celebrate"
  | "listen";

const SCENE_REACTION: Record<string, CharacterReaction> = {
  ask: "greet",
  purpose: "think",
  record: "think",
  board: "think",
  "card-ending": "celebrate",
  "hand-tool-ending": "idle",
  "posted-ending": "idle",
  "keeper-ending": "idle",
};

export type CharacterMotion = "tween" | "hold";

export type CharacterCue = {
  pose: PoseName;
  motion: CharacterMotion;
  stand: number;
  revision: number;
};

export function reactionForScene(sceneId: string): CharacterReaction {
  return SCENE_REACTION[sceneId] ?? "idle";
}

const SUPPORTED_POSE: Partial<Record<CharacterReaction, PoseName>> = {
  idle: "idle",
  greet: "greet",
  think: "think",
  celebrate: "celebrate",
};

export function animationFor(reaction: CharacterReaction): { name: PoseName; supported: boolean } {
  const name = SUPPORTED_POSE[reaction];
  if (name) return { name, supported: true };
  return { name: "idle", supported: false };
}

export function characterCue(input: {
  sceneId: string;
  reducedMotion: boolean;
  revision: number;
  stand: number;
}): CharacterCue {
  const animation = animationFor(reactionForScene(input.sceneId));
  return {
    pose: animation.name,
    motion: input.reducedMotion || !animation.supported ? "hold" : "tween",
    stand: input.stand,
    revision: input.revision,
  };
}

export function characterCueChanged(previous: CharacterCue | null, next: CharacterCue) {
  if (!previous) return true;
  return (
    previous.pose !== next.pose ||
    previous.motion !== next.motion ||
    previous.stand !== next.stand ||
    previous.revision !== next.revision
  );
}
