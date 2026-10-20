/** Identifiers for the ENG-002 manifest. Incompatible changes bump schemaVersion or add an adapter. */
export const SCHEMA_ID = "adeena.experience-manifest" as const;
export const SCHEMA_VERSION = "1" as const;
export const MECHANIC_ID = "branching-dialogue@1" as const;
export const EVENT_SCHEMA_VERSION = "1" as const;
export const RUNTIME_COMPATIBILITY = "adeena.experience-runtime@1" as const;
export const RUNTIME_PROFILE = "lightweight" as const;

export const DEFAULT_RUNTIME = {
  compatibility: RUNTIME_COMPATIBILITY,
  profile: RUNTIME_PROFILE,
  requiresLlm: false,
  executableScripts: false,
} as const;

/**
 * How a validated manifest is meant to run.
 * Validation records and checks this contract. It does not execute it.
 */
export const EXECUTION_SEMANTICS = {
  effectOrder: "array-order",
  effectAtomicity: "per-accepted-learner-action",
  outOfRangeEffect: "reject-action-do-not-clamp",
  invalidAction: "no-state-mutation",
  retryLimitEnforcement: "eng-003-gameplay-engine",
  endingReachability: "structural-graph-only",
} as const;

export const EXECUTION_RULES = [
  "Effects apply in array order.",
  "Effects are atomic for one accepted learner action.",
  "An effect that would leave its variable outside the declared bounds rejects the action. The value is not clamped.",
  "An invalid action does not mutate game state.",
  "Retry limits are enforced by the gameplay engine. Manifest validation only checks that a bounded retry names an exit scene.",
  "Structural reachability does not mean an ending is achievable under every gameplay state.",
] as const;

/** Uniqueness boundary for each identifier family. */
export const ID_SCOPES = {
  scene: "manifest",
  choice: "scene",
  asset: "manifest",
  stateVariable: "manifest",
} as const;

export const CONTRACT_BOUNDARY = {
  schemaVersion: SCHEMA_VERSION,
  legacyContract: "PLAYER-v1",
  adaptation: "schema-v1-omitted-runtime-defaults-to-lightweight",
  incompatibleChange: "bump-schema-version-or-add-adapter",
} as const;
