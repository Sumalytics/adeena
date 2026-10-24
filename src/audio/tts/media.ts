import { createHash } from "node:crypto";
import { AUDIO_ASSET_LIMITS, type ApprovedAudioMime } from "@/audio/contract";
import { TtsError } from "./errors";

const BITRATES_MPEG1_L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
const BITRATES_MPEG2_L3 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
const SAMPLE_RATES = [44100,48000,32000];

export function mp3DurationMs(bytes: Uint8Array) {
  let offset = 0;
  if (bytes.byteLength >= 10 && Buffer.from(bytes.subarray(0, 3)).toString("ascii") === "ID3") {
    offset = 10 + ((bytes[6] & 0x7f) << 21) + ((bytes[7] & 0x7f) << 14) + ((bytes[8] & 0x7f) << 7) + (bytes[9] & 0x7f);
  }
  let seconds = 0;
  let frames = 0;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) { offset += 1; continue; }
    const versionBits = (bytes[offset + 1] >> 3) & 3;
    const layerBits = (bytes[offset + 1] >> 1) & 3;
    const bitrateIndex = (bytes[offset + 2] >> 4) & 15;
    const sampleIndex = (bytes[offset + 2] >> 2) & 3;
    if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) { offset += 1; continue; }
    const mpeg1 = versionBits === 3;
    const divisor = versionBits === 2 ? 2 : versionBits === 0 ? 4 : 1;
    const sampleRate = SAMPLE_RATES[sampleIndex] / divisor;
    const bitrate = (mpeg1 ? BITRATES_MPEG1_L3 : BITRATES_MPEG2_L3)[bitrateIndex] * 1000;
    const padding = (bytes[offset + 2] >> 1) & 1;
    const frameLength = Math.floor((mpeg1 ? 144 : 72) * bitrate / sampleRate) + padding;
    if (frameLength < 4 || offset + frameLength > bytes.byteLength) break;
    seconds += (mpeg1 ? 1152 : 576) / sampleRate;
    frames += 1;
    offset += frameLength;
  }
  if (frames === 0) throw new TtsError("invalid-audio");
  return Math.round(seconds * 1000);
}

export function wavDurationMs(bytes: Uint8Array) {
  if (bytes.byteLength < 44 || Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "RIFF" || Buffer.from(bytes.subarray(8, 12)).toString("ascii") !== "WAVE") throw new TtsError("invalid-audio");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteRate = view.getUint32(28, true);
  const dataBytes = view.getUint32(40, true);
  if (!byteRate || dataBytes > bytes.byteLength - 44) throw new TtsError("invalid-audio");
  return Math.round(dataBytes / byteRate * 1000);
}

export function validateSynthesizedAudio(input: { bytes: Uint8Array; mimeType: ApprovedAudioMime; declaredDurationMs?: number }) {
  if (input.bytes.byteLength === 0) throw new TtsError("invalid-audio");
  if (input.bytes.byteLength > AUDIO_ASSET_LIMITS.maxBytes) throw new TtsError("oversized-audio");
  const durationMs = input.mimeType === "audio/mpeg" ? mp3DurationMs(input.bytes) : input.mimeType === "audio/wav" ? wavDurationMs(input.bytes) : 0;
  if (durationMs <= 0 || durationMs > AUDIO_ASSET_LIMITS.maxDurationMs) throw new TtsError("invalid-audio");
  if (input.declaredDurationMs && Math.abs(input.declaredDurationMs - durationMs) > Math.max(250, durationMs * 0.05)) throw new TtsError("invalid-audio");
  return { durationMs, checksum: createHash("sha256").update(input.bytes).digest("hex") };
}
