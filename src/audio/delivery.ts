import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { creatorAudioObjectStore } from "@/auth/storage";
import type { CreatorSession } from "@/auth/subject";
import { readPrivateAudioAsset } from "@/db/audio-repository";
import type { PrivateAudioObjectStore } from "@/storage/audio-object-store";

const headers = { "Cache-Control": "private, no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" };
const unavailable = () => new Response(null, { status: 404, headers });

function requestedRange(value: string | null, length: number) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]));
  let end = match[2] ? Number(match[2]) : length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= length) return false;
  end = Math.min(end, length - 1);
  return { start, end };
}

export async function creatorAudioResponse(input: { session: CreatorSession | null; sql: Sql; assetId: string; range: string | null; store?: PrivateAudioObjectStore }) {
  if (!input.session) return new Response(null, { status: 401, headers });
  const asset = await readPrivateAudioAsset({ sql: input.sql, identity: input.session.identity, assetId: input.assetId });
  if (!asset) return unavailable();
  try {
    const bytes = await (input.store ?? creatorAudioObjectStore()).read(asset.storageLocator);
    if (bytes.byteLength !== asset.byteCount || createHash("sha256").update(bytes).digest("hex") !== asset.contentHash) return unavailable();
    const range = requestedRange(input.range, bytes.byteLength);
    if (range === false) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${bytes.byteLength}` } });
    if (range) {
      const body = bytes.slice(range.start, range.end + 1);
      return new Response(Uint8Array.from(body).buffer, { status: 206, headers: { ...headers, "Content-Type": asset.mimeType, "Content-Length": String(body.byteLength), "Content-Range": `bytes ${range.start}-${range.end}/${bytes.byteLength}` } });
    }
    return new Response(Uint8Array.from(bytes).buffer, { status: 200, headers: { ...headers, "Content-Type": asset.mimeType, "Content-Length": String(bytes.byteLength) } });
  } catch { return unavailable(); }
}
