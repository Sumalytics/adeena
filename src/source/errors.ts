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
  "invalid-source",
  "rights-blocked",
  "job-limit",
  "generation-unavailable",
  "generation-denied",
  "review-required",
  "sensitive-topic",
  "unsafe-topic",
  "source-structure-required",
  "budget-unavailable",
  "invalid-experience",
  "insufficient-source",
  "invalid-generation",
  "stale-extraction",
  "invalid-edit",
  "unsupported-edit",
  "stale-version",
  "provider-unavailable",
  "invalid-workflow",
  "stale-workflow",
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
  "invalid-source": "That upload could not be accepted.",
  "rights-blocked": "Source rights are blocked, so extraction was not queued.",
  "job-limit": "This workspace already has extraction work in progress.",
  "generation-unavailable": "AI generation is not configured.",
  "generation-denied": "This source cannot be used to generate an experience.",
  "review-required": "This source needs review before an experience can be created.",
  "sensitive-topic": "The selected topic contains high-risk material that cannot be generated in this creator workflow.",
  "unsafe-topic": "The selected topic has an unsafe heading and cannot be generated.",
  "source-structure-required": "The selected topic does not have a complete, well-bounded source section.",
  "budget-unavailable": "Generation spending is not authorized.",
  "invalid-experience": "The generated experience did not pass validation.",
  "insufficient-source": "This topic does not have enough source support for a playable experience.",
  "invalid-generation": "That generation request could not be accepted.",
  "stale-extraction": "The source extraction changed. Recommend the topic again before creating an experience.",
  "invalid-edit": "That edit request could not be accepted.",
  "unsupported-edit": "That change is outside the edits this draft can make.",
  "stale-version": "A newer revision is already the current draft.",
  "provider-unavailable": "The model did not answer. The current draft was left unchanged.",
  "invalid-workflow": "That workflow update could not be accepted.",
  "stale-workflow": "This workflow was updated somewhere else. Reload it and try again.",
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
