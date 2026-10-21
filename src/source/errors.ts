export const SOURCE_ERROR_CODES = [
  "unauthenticated",
  "cross-workspace",
  "empty-file",
  "oversized",
  "unsupported-type",
  "invalid-structure",
  "binary-text",
  "malformed-docx",
  "zip-limit",
  "macro",
  "embedded-object",
  "external-reference",
  "unsafe-xml",
  "encrypted-pdf",
  "image-only-pdf",
  "unreadable-pdf",
  "page-limit",
  "integrity-mismatch",
  "invalid-path",
  "transient",
  "invalid-knowledge",
  "invalid-topic",
] as const;

export type SourceErrorCode = (typeof SOURCE_ERROR_CODES)[number];

/** Fixed creator-facing copy. These strings never include document contents. */
export const SOURCE_ERROR_TEXT: Record<SourceErrorCode, string> = {
  unauthenticated: "Sign in to a workspace before uploading a source.",
  "cross-workspace": "That source belongs to another workspace.",
  "empty-file": "The file is empty.",
  oversized: "The file is larger than the upload limit.",
  "unsupported-type": "Use a text, Markdown, DOCX, or text-layer PDF file.",
  "invalid-structure": "The file contents do not match its type.",
  "binary-text": "The text file is not valid UTF-8.",
  "malformed-docx": "The DOCX file could not be read.",
  "zip-limit": "The DOCX archive is too large to open safely.",
  macro: "DOCX files with macros are not accepted.",
  "embedded-object": "DOCX files with embedded objects are not accepted.",
  "external-reference": "DOCX files that link outside the document are not accepted.",
  "unsafe-xml": "The DOCX markup is not accepted.",
  "encrypted-pdf": "Encrypted PDFs are not accepted.",
  "image-only-pdf": "This PDF has no text layer. OCR is not available.",
  "unreadable-pdf": "The PDF text layer could not be read.",
  "page-limit": "The PDF has more pages than the current limit.",
  "integrity-mismatch": "The stored file does not match its hash.",
  "invalid-path": "The storage path was rejected.",
  transient: "Source processing was interrupted and can be retried.",
  "invalid-knowledge": "The extracted structure could not be checked.",
  "invalid-topic": "That topic correction could not be saved.",
};

export class SourceError extends Error {
  readonly code: SourceErrorCode;

  constructor(code: SourceErrorCode) {
    super(SOURCE_ERROR_TEXT[code]);
    this.name = "SourceError";
    this.code = code;
  }
}

export function sourceError(error: unknown): SourceError {
  if (error instanceof SourceError) return error;
  return new SourceError("transient");
}
