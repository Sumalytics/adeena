import type { $ZodIssue } from "zod/v4/core";
import type { Diagnostic } from "./diagnostics";
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

export function parseManifest(input: unknown): ManifestResult {
  const parsed = ManifestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, diagnostics: zodDiagnostics(parsed.error.issues as readonly $ZodIssue[]) };
  }
  const diagnostics = semanticDiagnostics(parsed.data);
  if (diagnostics.some((item) => item.severity === "error")) {
    return { ok: false, diagnostics };
  }
  return { ok: true, manifest: parsed.data, diagnostics };
}

export { ManifestSchema, type ExperienceManifest } from "./manifest";
export type { Diagnostic } from "./diagnostics";
export { sharedShelf } from "./shared-shelf";
