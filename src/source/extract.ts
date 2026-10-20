import { SourceError } from "./errors";
import { extractDocx } from "./extract-docx";
import { extractPdf } from "./extract-pdf";
import { extractMarkdown, extractPlainText, type ExtractedDocument } from "./extract-text";
import type { SourceLimits } from "./limits";
import { SOURCE_MEDIA_TYPES } from "@/contracts/source";

type SourceMediaType = (typeof SOURCE_MEDIA_TYPES)[number];

export type { ExtractedBlock, ExtractedDocument } from "./extract-text";

const EXTENSIONS: Record<string, SourceMediaType> = {
  txt: "text/plain",
  md: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

const DENIED = new Set(["doc", "docm", "exe", "dll", "js", "mjs", "bat", "cmd", "ps1", "com", "scr", "zip", "html", "htm"]);

export function displayFilename(filename: string) {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[^\w.\- ()[\]]+/g, "").replace(/^\.+/, "").slice(0, 120);
  return cleaned || "source";
}

export function classifyDocument(filename: string, bytes: Uint8Array): SourceMediaType {
  const display = displayFilename(filename);
  const extension = display.includes(".") ? display.split(".").pop()?.toLowerCase() ?? "" : "";
  if (DENIED.has(extension)) throw new SourceError("unsupported-type");
  const media = EXTENSIONS[extension];
  if (!media) throw new SourceError("unsupported-type");
  if (bytes.byteLength >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) throw new SourceError("invalid-structure");
  if (bytes.byteLength >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    throw new SourceError("invalid-structure");
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new SourceError("unsupported-type");
  }
  const zip = bytes.byteLength >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  const pdf = bytes.byteLength >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";
  if (media === "application/pdf" && !pdf) throw new SourceError("invalid-structure");
  if (media === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && !zip) {
    throw new SourceError("invalid-structure");
  }
  if ((media === "text/plain" || media === "text/markdown") && (zip || pdf)) throw new SourceError("invalid-structure");
  return media;
}

export async function extractDocument(media: SourceMediaType, bytes: Uint8Array, limits: SourceLimits): Promise<ExtractedDocument> {
  if (media === "text/plain") return extractPlainText(bytes, limits);
  if (media === "text/markdown") return extractMarkdown(bytes, limits);
  if (media === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return extractDocx(bytes, limits);
  return extractPdf(bytes, limits);
}
