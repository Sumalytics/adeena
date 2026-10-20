import { DEFAULT_RUNTIME, SCHEMA_ID, SCHEMA_VERSION } from "./semantics";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Schema v1 may omit runtime. The adapter fills the lightweight runtime and
 * leaves every other contract, including PLAYER-v1, unchanged.
 * The input object is not modified.
 */
export function adaptManifestInput(input: unknown): { value: unknown; defaultedRuntime: boolean } {
  if (!isRecord(input)) return { value: input, defaultedRuntime: false };
  if (input.schema !== SCHEMA_ID || input.schemaVersion !== SCHEMA_VERSION) {
    return { value: input, defaultedRuntime: false };
  }
  if (Object.prototype.hasOwnProperty.call(input, "runtime")) {
    return { value: input, defaultedRuntime: false };
  }
  return {
    value: {
      ...input,
      runtime: {
        compatibility: DEFAULT_RUNTIME.compatibility,
        profile: DEFAULT_RUNTIME.profile,
        requiresLlm: DEFAULT_RUNTIME.requiresLlm,
        executableScripts: DEFAULT_RUNTIME.executableScripts,
      },
    },
    defaultedRuntime: true,
  };
}
