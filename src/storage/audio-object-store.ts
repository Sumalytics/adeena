import type { ApprovedAudioMime } from "@/audio/contract";

export type StoredAudioObject = { locator: string; created: boolean };
export type PrivateAudioObjectStore = {
  put(input: { workspaceId: string; contentHash: string; mimeType: ApprovedAudioMime; bytes: Uint8Array }): Promise<StoredAudioObject>;
  read(locator: string): Promise<Uint8Array>;
  verify(locator: string, contentHash: string): Promise<boolean>;
  retire(locator: string): Promise<void>;
};

export class AudioStorageError extends Error {
  constructor(readonly code: "invalid-input" | "unsupported-type" | "oversized" | "integrity-mismatch" | "not-found" | "unavailable") {
    super(code);
    this.name = "AudioStorageError";
  }
}
