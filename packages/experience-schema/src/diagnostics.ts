export const DIAGNOSTIC_CODES = [
  "asset.duplicate",
  "asset.invalid",
  "asset.unknown",
  "asset.unused",
  "bound.exceeded",
  "choice.duplicate",
  "content.executable",
  "ending.missing",
  "ending.unreachable",
  "events.unsupported-version",
  "graph.cycle-without-exit",
  "mechanic.unsupported",
  "runtime.defaulted",
  "runtime.unsupported",
  "scene.duplicate",
  "scene.initial-missing",
  "scene.transition-missing",
  "scene.unreachable-optional",
  "scene.unreachable-required",
  "schema.invalid",
  "schema.unknown-field",
  "schema.unsupported-version",
  "source.invalid",
  "state.duplicate",
  "state.effect-unsupported",
  "state.out-of-bounds",
  "state.unknown-variable",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type Diagnostic = {
  severity: "error" | "warning";
  code: DiagnosticCode;
  path: Array<string | number>;
  message: string;
};

export function diagnostic(
  code: DiagnosticCode,
  path: Array<string | number>,
  message: string,
  severity: Diagnostic["severity"] = "error",
): Diagnostic {
  return { severity, code, path, message };
}

function comparePath(left: Diagnostic["path"], right: Diagnostic["path"]) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a) < String(b) ? -1 : 1;
  }
  return left.length - right.length;
}

/** Stable order: path, then code, then severity, then message. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const byPath = comparePath(left.item.path, right.item.path);
      if (byPath !== 0) return byPath;
      if (left.item.code !== right.item.code) return left.item.code < right.item.code ? -1 : 1;
      if (left.item.severity !== right.item.severity) return left.item.severity < right.item.severity ? -1 : 1;
      if (left.item.message !== right.item.message) return left.item.message < right.item.message ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ item }) => item);
}
