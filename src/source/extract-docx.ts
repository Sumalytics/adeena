import { SourceError } from "./errors";
import type { SourceLimits } from "./limits";
import { readZip } from "./zip";
import type { ExtractedDocument } from "./extract-text";

function decodeXml(value: string) {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function paragraphs(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new SourceError("unsafe-xml");
  const chunks = xml.split(/<w:p(?:\s|>)/).slice(1);
  const rows: { style: string | null; text: string }[] = [];
  for (const chunk of chunks) {
    const end = chunk.indexOf("</w:p>");
    const body = end >= 0 ? chunk.slice(0, end) : chunk;
    const style = /<w:pStyle\b[^>]*\bw:val="([^"]+)"/.exec(body)?.[1] ?? null;
    const text = [...body.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)]
      .map((match) => decodeXml(match[1] ?? ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text) rows.push({ style, text });
  }
  return rows;
}

export function extractDocx(bytes: Uint8Array, limits: SourceLimits): ExtractedDocument {
  const files = readZip(Buffer.from(bytes), limits);
  const names = new Set(files.map((file) => file.name.replace(/\\/g, "/")));
  if ([...names].some((name) => name.startsWith("word/embeddings/"))) throw new SourceError("embedded-object");
  if ([...names].some((name) => name.toLowerCase().includes("vbaproject"))) throw new SourceError("macro");
  const types = files.find((file) => file.name === "[Content_Types].xml")?.data.toString("utf8") ?? "";
  if (/macroEnabled|vbaProject/i.test(types)) throw new SourceError("macro");
  const rels = files.find((file) => file.name === "word/_rels/document.xml.rels")?.data.toString("utf8") ?? "";
  if (/TargetMode="External"/i.test(rels) || /Target="https?:/i.test(rels)) throw new SourceError("external-reference");
  const document = files.find((file) => file.name === "word/document.xml");
  if (!document) throw new SourceError("malformed-docx");
  const xml = document.data.toString("utf8");
  if (xml.length > limits.maxTextChars) throw new SourceError("oversized");
  const blocks: ExtractedDocument["blocks"] = [];
  for (const row of paragraphs(xml)) {
    const level = /^Heading([1-6])$/i.exec(row.style ?? "")?.[1];
    if (level) {
      blocks.push({
        kind: level === "1" ? "chapter" : "section",
        text: row.text,
        page: null,
        title: row.text,
        headingCertainty: "reliable",
      });
    } else {
      blocks.push({ kind: "block", text: row.text, page: null, title: null, headingCertainty: "none" });
    }
  }
  if (blocks.length === 0) throw new SourceError("empty-file");
  const issues = blocks.some((block) => block.kind !== "block") ? [] : [{ code: "no-heading-style", page: null }];
  return {
    media: "docx",
    blocks,
    issues,
    status: issues.length > 0 ? "partial" : "complete",
    pageCount: null,
  };
}
