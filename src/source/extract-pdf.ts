import { getDocument, PasswordException } from "pdfjs-dist/legacy/build/pdf.mjs";
import { SourceError } from "./errors";
import type { SourceLimits } from "./limits";
import type { ExtractedDocument } from "./extract-text";

function declaresEncryption(bytes: Uint8Array) {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 65_536))).toString("latin1");
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 65_536))).toString("latin1");
  return head.includes("/Encrypt") || tail.includes("/Encrypt");
}

function textOf(item: unknown) {
  if (!item || typeof item !== "object" || !("str" in item)) return "";
  return typeof item.str === "string" ? item.str : "";
}

export async function extractPdf(bytes: Uint8Array, limits: SourceLimits): Promise<ExtractedDocument> {
  if (declaresEncryption(bytes)) throw new SourceError("encrypted-pdf");
  const task = getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    disableAutoFetch: true,
    useSystemFonts: false,
  });
  try {
    const document = await task.promise;
    if (document.numPages > limits.maxPdfPages) throw new SourceError("page-limit");
    const blocks: ExtractedDocument["blocks"] = [];
    const issues: ExtractedDocument["issues"] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map(textOf).join(" ").replace(/\s+/g, " ").trim();
      if (!text) issues.push({ code: "unreadable-page", page: pageNumber });
      else blocks.push({ kind: "block", text, page: pageNumber, title: null, headingCertainty: "none" });
    }
    if (blocks.length === 0) throw new SourceError("image-only-pdf");
    const combined = blocks.map((block) => block.text).join("\n\n");
    if (combined.length > limits.maxTextChars) throw new SourceError("oversized");
    return {
      media: "pdf",
      blocks,
      issues,
      status: issues.length > 0 ? "partial" : "complete",
      pageCount: document.numPages,
    };
  } catch (error) {
    if (error instanceof SourceError) throw error;
    if (error instanceof PasswordException || (error instanceof Error && error.name === "PasswordException")) {
      throw new SourceError("encrypted-pdf");
    }
    throw new SourceError("unreadable-pdf");
  } finally {
    await task.destroy();
  }
}
