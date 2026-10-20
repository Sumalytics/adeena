import { SourceError } from "./errors";
import type { SourceLimits } from "./limits";

export type ExtractedBlock = {
  kind: "chapter" | "section" | "block";
  text: string;
  page: number | null;
  title: string | null;
  headingCertainty: "reliable" | "ambiguous" | "none";
};

export type ExtractedDocument = {
  media: "text" | "markdown" | "docx" | "pdf";
  blocks: ExtractedBlock[];
  issues: { code: string; page: number | null }[];
  status: "complete" | "partial";
  pageCount: number | null;
};

export function decodePlainText(bytes: Uint8Array) {
  if (bytes.byteLength === 0) throw new SourceError("empty-file");
  for (const byte of bytes) {
    if (byte === 0) throw new SourceError("binary-text");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new SourceError("binary-text");
  }
}

function pushParagraph(blocks: ExtractedBlock[], lines: string[]) {
  const text = lines.join("\n").trim();
  if (!text) return;
  blocks.push({ kind: "block", text, page: null, title: null, headingCertainty: "none" });
}

export function extractPlainText(bytes: Uint8Array, limits: SourceLimits): ExtractedDocument {
  const text = decodePlainText(bytes);
  if (text.length > limits.maxTextChars) throw new SourceError("oversized");
  const blocks: ExtractedBlock[] = [];
  const issues: ExtractedDocument["issues"] = [];
  let lines: string[] = [];
  let ambiguous = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") {
      pushParagraph(blocks, lines);
      lines = [];
      continue;
    }
    if (/^(chapter|section)\b/i.test(line.trim()) && line.trim().length <= 80) ambiguous = true;
    lines.push(line);
  }
  pushParagraph(blocks, lines);
  if (blocks.length === 0) throw new SourceError("empty-file");
  if (ambiguous) issues.push({ code: "ambiguous-structure", page: null });
  return { media: "text", blocks, issues, status: issues.length > 0 ? "partial" : "complete", pageCount: null };
}

export function extractMarkdown(bytes: Uint8Array, limits: SourceLimits): ExtractedDocument {
  const text = decodePlainText(bytes);
  if (text.length > limits.maxTextChars) throw new SourceError("oversized");
  const blocks: ExtractedBlock[] = [];
  let lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{1,6})[ \t]+(\S.*?)\s*$/.exec(line);
    if (heading) {
      pushParagraph(blocks, lines);
      lines = [];
      const level = heading[1]?.length ?? 1;
      const title = heading[2]?.trim() ?? "";
      if (!title) continue;
      blocks.push({
        kind: level === 1 ? "chapter" : "section",
        text: title,
        page: null,
        title,
        headingCertainty: "reliable",
      });
      continue;
    }
    if (line.trim() === "") {
      pushParagraph(blocks, lines);
      lines = [];
      continue;
    }
    lines.push(line);
  }
  pushParagraph(blocks, lines);
  if (blocks.length === 0) throw new SourceError("empty-file");
  return { media: "markdown", blocks, issues: [], status: "complete", pageCount: null };
}
