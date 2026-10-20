import type { $ZodIssue } from "zod/v4/core";
import { adaptManifestInput } from "./adapt";
import { diagnostic, sortDiagnostics, type Diagnostic } from "./diagnostics";
import { inputBoundDiagnostics } from "./limits";
import { ManifestSchema, type ExperienceManifest } from "./manifest";
import { semanticDiagnostics, zodDiagnostics } from "./validate";

export type ManifestSuccess = {
  ok: true;
  manifest: ExperienceManifest;
  diagnostics: Diagnostic[];
};

export type ManifestFailure = {
  ok: false;
  diagnostics: Diagnostic[];
};

export type ManifestResult = ManifestSuccess | ManifestFailure;

function cloneInput(input: unknown) {
  const structuredClone = (globalThis as { structuredClone?: (value: unknown) => unknown }).structuredClone;
  if (!structuredClone) {
    throw new Error("structuredClone is required to validate a manifest without mutating input");
  }
  return structuredClone(input);
}

export function parseManifest(input: unknown): ManifestResult {
  const bounds = inputBoundDiagnostics(input);
  if (bounds.length > 0) {
    return { ok: false, diagnostics: sortDiagnostics(bounds) };
  }

  let snapshot: unknown;
  try {
    snapshot = cloneInput(input);
  } catch {
    return {
      ok: false,
      diagnostics: [diagnostic("schema.invalid", [], "Manifest must be JSON-compatible data")],
    };
  }

  const adapted = adaptManifestInput(snapshot);
  const runtimeWarning = adapted.defaultedRuntime
    ? [
        diagnostic(
          "runtime.defaulted",
          ["runtime"],
          "Omitted runtime compatibility defaults to adeena.experience-runtime@1 for the lightweight player",
          "warning",
        ),
      ]
    : [];
  const parsed = ManifestSchema.safeParse(adapted.value);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([...runtimeWarning, ...zodDiagnostics(parsed.error.issues as readonly $ZodIssue[])]),
    };
  }
  const diagnostics = sortDiagnostics([...runtimeWarning, ...semanticDiagnostics(parsed.data)]);
  if (diagnostics.some((item) => item.severity === "error")) {
    return { ok: false, diagnostics };
  }
  return { ok: true, manifest: parsed.data, diagnostics };
}

export { adaptManifestInput } from "./adapt";
export { DIAGNOSTIC_CODES, diagnostic, sortDiagnostics, type Diagnostic, type DiagnosticCode } from "./diagnostics";
export { MANIFEST_LIMITS } from "./limits";
export { ManifestSchema, type DialogueScene, type ExperienceManifest, type ManifestScene } from "./manifest";
export {
  CONTRACT_BOUNDARY,
  DEFAULT_RUNTIME,
  EXECUTION_RULES,
  EXECUTION_SEMANTICS,
  ID_SCOPES,
  MECHANIC_ID,
  RUNTIME_COMPATIBILITY,
  SCHEMA_ID,
  SCHEMA_VERSION,
} from "./semantics";
export { sharedShelf } from "./shared-shelf";
