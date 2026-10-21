import type { ReactNode } from "react";
import type { GameState, PlayableGame, RuntimeFact } from "@adeena/player-core";

export const EXPERIENCE_UNAVAILABLE = "This experience cannot be played.";

export type PlayerSession = {
  phase: "playing" | "completed" | "unavailable";
  started: boolean;
  game: PlayableGame | null;
  state: GameState | null;
  facts: readonly RuntimeFact[];
  previousVariables: Readonly<Record<string, number>> | null;
  notice: string | null;
  busy: boolean;
};

export type PlayerController = {
  snapshot: () => PlayerSession;
  beginPlay: () => PlayerSession;
  beginChoice: (choiceId: string) => PlayerSession;
  beginRestart: () => PlayerSession;
  settle: () => PlayerSession;
  dispose: () => void;
};

/** Learner-facing copy supplied beside the manifest. Labels are not derived from ids. */
export type ExperiencePresentation = {
  intro: string;
  variables: readonly VariablePresentation[];
  scenes: Readonly<Record<string, SceneCue>>;
};

export type VariablePresentation = {
  id: string;
  label: string;
  changeText: (before: number, after: number) => string;
};

export type SceneCue = {
  description: string;
  decorative: boolean;
};

export type IllustrationCue = {
  sceneId: string;
  description: string;
  decorative: boolean;
  missing: boolean;
};

export type PlayerChoice = {
  id: string;
  label: string;
};

export type PlayerMeter = {
  id: string;
  label: string;
  value: number;
};

export type PlayerSummaryItem = {
  choice: string;
  outcome: string;
};

export type PlayerView =
  | { kind: "unavailable"; message: string }
  | { kind: "cover"; locale: string; title: string; intro: string; meters: readonly PlayerMeter[] }
  | {
      kind: "scene" | "ending";
      locale: string;
      title: string;
      sceneId: string;
      sceneTitle: string;
      narrative: string;
      choices: readonly PlayerChoice[];
      meters: readonly PlayerMeter[];
      changes: readonly string[];
      chosenText: string | null;
      summary: readonly PlayerSummaryItem[];
      progress: string;
      illustration: IllustrationCue;
      notice: string | null;
      busy: boolean;
      revision: number;
    };

export type SceneChoice = {
  id: string;
  text: string;
};

export type SceneVisualProps = {
  sceneId: string;
  title: string;
  description: string;
  decorative: boolean;
  missing: boolean;
  /** Present when the screen can offer the current choices to a visual world. */
  choices?: readonly SceneChoice[];
  /** Variable ids already shown to the learner. The renderer does not score them. */
  variables?: Readonly<Record<string, number>>;
  completed?: boolean;
  revision?: number;
  onChoose?: (choiceId: string) => void;
};

export type RendererKind = "css" | "phaser" | "rive";

export type ExperienceRenderer = {
  kind: RendererKind;
  Visual: (props: SceneVisualProps) => ReactNode;
};
