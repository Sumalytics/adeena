import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIO_ASSET_LIMITS } from "@/audio/contract";
import { AudioStorageError } from "./audio-object-store";
import { audioLocator, createFilesystemAudioStore } from "./audio-filesystem";

const workspaceId = "11111111-1111-4111-8111-111111111111";

describe("private audio filesystem", () => {
  it("stores immutable audio idempotently and verifies its hash", async () => {
    const store = createFilesystemAudioStore(await mkdtemp(path.join(tmpdir(), "adeena-audio-")));
    const bytes = await readFile("docs/media/visual-director-audio/air-start.wav");
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const first = await store.put({ workspaceId, contentHash, mimeType: "audio/wav", bytes });
    const duplicate = await store.put({ workspaceId, contentHash, mimeType: "audio/wav", bytes });
    expect(first).toEqual({ locator: audioLocator(workspaceId, contentHash, "audio/wav"), created: true });
    expect(duplicate.created).toBe(false);
    expect(await store.verify(first.locator, contentHash)).toBe(true);
    expect(await store.read(first.locator)).toEqual(bytes);
    await store.retire(first.locator);
    await expect(store.read(first.locator)).rejects.toMatchObject({ code: "not-found" });
  });

  it("rejects traversal, unsupported, oversized, corrupt and hash-mismatched input", async () => {
    expect(() => createFilesystemAudioStore(path.join(tmpdir(), "public", "audio"))).toThrow(AudioStorageError);
    const store = createFilesystemAudioStore(await mkdtemp(path.join(tmpdir(), "adeena-audio-")));
    const corrupt = Buffer.from("not audio");
    const corruptHash = createHash("sha256").update(corrupt).digest("hex");
    await expect(store.put({ workspaceId, contentHash: corruptHash, mimeType: "audio/wav", bytes: corrupt })).rejects.toMatchObject({ code: "unsupported-type" });
    const wav = await readFile("docs/media/visual-director-audio/air-start.wav");
    await expect(store.put({ workspaceId, contentHash: "a".repeat(64), mimeType: "audio/wav", bytes: wav })).rejects.toMatchObject({ code: "integrity-mismatch" });
    const oversized = new Uint8Array(AUDIO_ASSET_LIMITS.maxBytes + 1); oversized.set(Buffer.from("RIFF0000WAVE"));
    await expect(store.put({ workspaceId, contentHash: createHash("sha256").update(oversized).digest("hex"), mimeType: "audio/wav", bytes: oversized })).rejects.toMatchObject({ code: "oversized" });
    await expect(store.read("private-audio://../../secret/audio.wav")).rejects.toMatchObject({ code: "invalid-input" });
    await expect(store.put({ workspaceId, contentHash: corruptHash, mimeType: "audio/flac" as "audio/wav", bytes: corrupt })).rejects.toMatchObject({ code: "unsupported-type" });
  });
});
