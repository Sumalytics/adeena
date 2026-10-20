import { inflateRawSync } from "node:zlib";
import { SourceError } from "./errors";
import type { SourceLimits } from "./limits";

export type ZipFile = { name: string; data: Buffer };

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function findEocd(bytes: Buffer) {
  const start = Math.max(0, bytes.length - 22 - 65535);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD) return offset;
  }
  throw new SourceError("malformed-docx");
}

/**
 * Reads a DOCX zip with entry, size, and compression ceilings.
 * Encrypted entries and unusual compression methods are rejected.
 */
export function readZip(bytes: Buffer, limits: SourceLimits): ZipFile[] {
  const eocd = findEocd(bytes);
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (entries > limits.maxZipEntries) throw new SourceError("zip-limit");
  if (centralOffset + centralSize > bytes.length) throw new SourceError("malformed-docx");

  const files: ZipFile[] = [];
  let cursor = centralOffset;
  let uncompressedTotal = 0;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL) throw new SourceError("malformed-docx");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) throw new SourceError("invalid-path");
    if ((flags & 1) !== 0) throw new SourceError("malformed-docx");
    if (method !== 0 && method !== 8) throw new SourceError("malformed-docx");
    if (uncompressedSize > limits.maxUncompressedBytes) throw new SourceError("zip-limit");
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) throw new SourceError("zip-limit");
    uncompressedTotal += uncompressedSize;
    if (uncompressedTotal > limits.maxUncompressedBytes) throw new SourceError("zip-limit");
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== LOCAL) throw new SourceError("malformed-docx");
    const localName = bytes.readUInt16LE(localOffset + 26);
    const localExtra = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localName + localExtra;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    if (dataStart + compressedSize > bytes.length) throw new SourceError("malformed-docx");
    let data: Buffer;
    if (method === 0) data = Buffer.from(compressed);
    else {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: limits.maxUncompressedBytes });
      } catch {
        throw new SourceError("zip-limit");
      }
    }
    if (data.length > limits.maxUncompressedBytes) throw new SourceError("zip-limit");
    files.push({ name, data });
  }
  return files;
}
