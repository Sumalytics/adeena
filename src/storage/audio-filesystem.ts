import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AUDIO_ASSET_LIMITS, ApprovedAudioMime, type ApprovedAudioMime as AudioMime } from "@/audio/contract";
import { Sha256, Uuid } from "@/contracts/common";
import { AudioStorageError, type PrivateAudioObjectStore } from "./audio-object-store";

const EXTENSION: Record<AudioMime, string> = { "audio/wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg" };
const LOCATOR = /^private-audio:\/\/([0-9a-f-]{36})\/([a-f0-9]{64})\/audio\.(wav|mp3|ogg)$/;

function supportedBytes(mimeType: AudioMime, bytes: Uint8Array) {
  if (mimeType === "audio/wav") return bytes.byteLength >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WAVE";
  if (mimeType === "audio/ogg") return bytes.byteLength >= 4 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "OggS";
  return bytes.byteLength >= 3 && (Buffer.from(bytes.subarray(0, 3)).toString("ascii") === "ID3" || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
}

function checkedRoot(root: string) {
  const resolved = path.resolve(root);
  if (resolved.split(path.sep).includes("public")) throw new AudioStorageError("invalid-input");
  return resolved;
}

function targetFor(root: string, locator: string) {
  const match = LOCATOR.exec(locator);
  if (!match || !Uuid.safeParse(match[1]).success || !Sha256.safeParse(match[2]).success) throw new AudioStorageError("invalid-input");
  const target = path.resolve(root, match[1], match[2], `audio.${match[3]}`);
  if (path.relative(root, target).startsWith("..") || path.isAbsolute(path.relative(root, target))) throw new AudioStorageError("invalid-input");
  return target;
}

export function audioLocator(workspaceId: string, contentHash: string, mimeType: AudioMime) {
  if (!Uuid.safeParse(workspaceId).success || !Sha256.safeParse(contentHash).success || !ApprovedAudioMime.safeParse(mimeType).success) throw new AudioStorageError("invalid-input");
  return `private-audio://${workspaceId}/${contentHash}/audio.${EXTENSION[mimeType]}`;
}

export function createFilesystemAudioStore(rootInput: string): PrivateAudioObjectStore {
  const root = checkedRoot(rootInput);
  return {
    async put({ workspaceId, contentHash, mimeType, bytes }) {
      if (!ApprovedAudioMime.safeParse(mimeType).success) throw new AudioStorageError("unsupported-type");
      if (bytes.byteLength === 0 || bytes.byteLength > AUDIO_ASSET_LIMITS.maxBytes) throw new AudioStorageError(bytes.byteLength ? "oversized" : "invalid-input");
      if (!supportedBytes(mimeType, bytes)) throw new AudioStorageError("unsupported-type");
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== contentHash) throw new AudioStorageError("integrity-mismatch");
      const locator = audioLocator(workspaceId, contentHash, mimeType);
      const file = targetFor(root, locator);
      await mkdir(path.dirname(file), { recursive: true });
      try {
        await writeFile(file, bytes, { flag: "wx" });
        return { locator, created: true };
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw new AudioStorageError("unavailable");
        const existing = await readFile(file);
        if (createHash("sha256").update(existing).digest("hex") !== contentHash) throw new AudioStorageError("integrity-mismatch");
        return { locator, created: false };
      }
    },
    async read(locator) {
      try { return await readFile(targetFor(root, locator)); }
      catch (error) { if (error instanceof AudioStorageError) throw error; throw new AudioStorageError("not-found"); }
    },
    async verify(locator, contentHash) {
      if (!Sha256.safeParse(contentHash).success) return false;
      try { return createHash("sha256").update(await readFile(targetFor(root, locator))).digest("hex") === contentHash; }
      catch { return false; }
    },
    async retire(locator) { await rm(targetFor(root, locator), { force: true }); },
  };
}
