import type { ExperienceManifest } from "@adeena/experience-schema";

export type GameStatus = "playing" | "completed";

export type GameState = {
  sceneId: string;
  variables: Readonly<Record<string, number>>;
  retryAttempts: Readonly<Record<string, number>>;
  status: GameStatus;
  revision: number;
};

export type GameAction =
  | { type: "choose"; choiceId: string }
  | { type: "restart" };

export type RejectionReason =
  | "INVALID_ACTION"
  | "ALREADY_COMPLETED"
  | "STATE_OUT_OF_BOUNDS"
  | "INVALID_TRANSITION";

export type RuntimeFactKind =
  | "experience_started"
  | "choice_applied"
  | "scene_entered"
  | "retry_exhausted"
  | "experience_completed"
  | "experience_restarted";

/** Gameplay fact. No learner identity, timestamp, or mastery claim. */
export type RuntimeFact = {
  schemaVersion: "1";
  experienceId: string;
  versionId: string;
  mechanic: ExperienceManifest["mechanics"][number];
  revision: number;
  sequence: number;
  kind: RuntimeFactKind;
  sceneId: string;
  choiceId?: string;
};

export type TransitionResult =
  | {
      accepted: true;
      state: GameState;
      facts: readonly RuntimeFact[];
    }
  | {
      accepted: false;
      state: GameState;
      reason: RejectionReason;
      facts: readonly [];
    };

type ManifestScene = ExperienceManifest["scenes"][number];
type DialogueScene = Extract<ManifestScene, { role: "dialogue" }>;
type VariableSpec = ExperienceManifest["state"]["variables"][number];

export type PlayableGame = {
  readonly manifest: ExperienceManifest;
  readonly scenes: ReadonlyMap<string, ManifestScene>;
  readonly variables: ReadonlyMap<string, VariableSpec>;
  readonly choices: ReadonlyMap<string, ReadonlyMap<string, DialogueScene["choices"][number]>>;
};

export type CreateGameResult =
  | { ok: true; game: PlayableGame }
  | { ok: false; diagnostics: readonly { code: string; path: ReadonlyArray<string | number>; message: string }[] };

export type ReplayResult = {
  state: GameState;
  facts: readonly RuntimeFact[];
};
