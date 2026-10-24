export type TtsFailureCode =
  | "provider-unavailable"
  | "unsupported-voice"
  | "invalid-input"
  | "authorization-required"
  | "budget-exhausted"
  | "provider-timeout"
  | "provider-network"
  | "invalid-audio"
  | "oversized-audio"
  | "storage-failed"
  | "metadata-failed"
  | "concurrent-request";

export class TtsError extends Error {
  constructor(readonly code: TtsFailureCode, readonly uncertainCharge = false, readonly knownCharge = false) {
    super(code);
    this.name = "TtsError";
  }
}
