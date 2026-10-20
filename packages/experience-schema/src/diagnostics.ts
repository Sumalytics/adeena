export type Diagnostic = {
  severity: "error" | "warning";
  code: string;
  path: Array<string | number>;
  message: string;
};

export function diagnostic(
  code: string,
  path: Array<string | number>,
  message: string,
  severity: Diagnostic["severity"] = "error",
): Diagnostic {
  return { severity, code, path, message };
}
