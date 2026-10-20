/** Marks every studio HTTP response as a synthetic demo, not production authorization. */
export const SYNTHETIC_DEMO = {
  mode: "synthetic-demo",
  persistence: "process-local",
  authorization: "not-production",
} as const;

/** Studio JSON bodies are short text fields. Larger uploads are refused. */
export const MAX_REQUEST_BYTES = 8_192;
