import { diagnostic, type Diagnostic } from "./diagnostics";

export const MANIFEST_LIMITS = {
  maxDepth: 8,
  maxNodes: 5000,
  maxArrayLength: 32,
  maxStringLength: 4096,
  maxScenes: 16,
  maxChoicesPerScene: 4,
  maxEffectsPerChoice: 4,
  maxAssetIdsPerScene: 4,
  maxVariables: 8,
  maxAssets: 8,
  maxSources: 4,
  maxAbsoluteInteger: 100,
  maxRetryAttempts: 5,
} as const;

function isRecord(value: object): value is Record<string, unknown> {
  return !Array.isArray(value);
}

/**
 * Rejects inputs that could exhaust validation before the schema runs.
 * The walk only reads values. Function-valued fields fail closed and are not called.
 */
export function inputBoundDiagnostics(input: unknown): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let nodes = 0;
  let stopped = false;
  const seen = new Set<object>();

  function stop(path: Array<string | number>, code: "bound.exceeded" | "content.executable", message: string) {
    diagnostics.push(diagnostic(code, path, message));
    stopped = true;
  }

  function walk(value: unknown, depth: number, path: Array<string | number>) {
    if (stopped) return;
    nodes += 1;
    if (nodes > MANIFEST_LIMITS.maxNodes) {
      stop(path, "bound.exceeded", "Manifest exceeds the node limit");
      return;
    }
    if (depth > MANIFEST_LIMITS.maxDepth) {
      stop(path, "bound.exceeded", "Manifest exceeds the nesting limit");
      return;
    }
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      stop(path, "content.executable", "Executable content is not allowed");
      return;
    }
    if (value === null || typeof value !== "object") {
      if (typeof value === "string" && value.length > MANIFEST_LIMITS.maxStringLength) {
        stop(path, "bound.exceeded", "Manifest exceeds the string length limit");
      }
      return;
    }
    if (seen.has(value)) {
      stop(path, "bound.exceeded", "Manifest contains a circular reference");
      return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > MANIFEST_LIMITS.maxArrayLength) {
        stop(path, "bound.exceeded", "Manifest exceeds the array length limit");
        return;
      }
      for (let index = 0; index < value.length; index += 1) {
        walk(value[index], depth + 1, [...path, index]);
        if (stopped) return;
      }
      return;
    }
    if (!isRecord(value)) return;
    for (const key of Object.keys(value)) {
      walk(value[key], depth + 1, [...path, key]);
      if (stopped) return;
    }
  }

  walk(input, 0, []);
  return diagnostics;
}
