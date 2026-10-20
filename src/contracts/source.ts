import { z } from "zod";
import { IsoDateTime, RightsStatus, Sha256, Uuid } from "./common";

export const SOURCE_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
] as const;

export const SourceMediaType = z.enum(SOURCE_MEDIA_TYPES);

export const SourceDocumentVersion = z
  .object({
    contract: z.literal("SOURCE-DOC-v1"),
    id: Uuid,
    version: z.literal(1),
    immutable: z.literal(true),
    workspaceId: Uuid,
    contentHash: Sha256,
    byteCount: z.number().int().nonnegative(),
    filename: z.string().trim().min(1).max(120),
    mediaType: SourceMediaType,
    rightsStatus: RightsStatus,
    educationalValidation: z.literal("none"),
    uploadedAt: IsoDateTime,
    provenance: z
      .object({
        actorId: Uuid,
        method: z.literal("authorized-ingestion"),
      })
      .strict(),
  })
  .strict();

export type SourceDocumentVersion = z.infer<typeof SourceDocumentVersion>;

export const SourceSpan = z
  .object({
    contract: z.literal("SOURCE-SPAN-v1"),
    id: Uuid,
    documentVersionId: Uuid,
    workspaceId: Uuid,
    canonicalTextHash: Sha256,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    page: z.number().int().positive().nullable(),
  })
  .strict()
  .refine((span) => span.end > span.start, "A span must cover at least one character");

export type SourceSpan = z.infer<typeof SourceSpan>;

export const ExtractionIssue = z
  .object({
    code: z.string().regex(/^[a-z0-9-]+$/),
    page: z.number().int().positive().nullable(),
  })
  .strict();

export const ExtractionResult = z
  .object({
    contract: z.literal("EXTRACTION-v1"),
    id: Uuid,
    documentVersionId: Uuid,
    workspaceId: Uuid,
    extractor: z
      .object({
        name: z.literal("adeena.source-extract"),
        version: z.literal("1"),
      })
      .strict(),
    canonicalTextHash: Sha256,
    status: z.enum(["complete", "partial", "failed"]),
    pageCount: z.number().int().nonnegative().nullable(),
    issues: z.array(ExtractionIssue).max(500),
    educationalValidation: z.literal("none"),
    durationMs: z.number().nonnegative(),
  })
  .strict();

export type ExtractionResult = z.infer<typeof ExtractionResult>;

export const KnowledgeNode = z
  .object({
    contract: z.literal("KNOWLEDGE-NODE-v1"),
    id: Uuid,
    collectionId: Uuid,
    documentVersionId: Uuid,
    workspaceId: Uuid,
    kind: z.enum(["document", "chapter", "section", "block"]),
    parentId: Uuid.nullable(),
    order: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(200).nullable(),
    headingCertainty: z.enum(["reliable", "ambiguous", "none"]),
    spanId: Uuid,
  })
  .strict();

export type KnowledgeNode = z.infer<typeof KnowledgeNode>;

export const KnowledgeCollection = z
  .object({
    contract: z.literal("KNOWLEDGE-COLLECTION-v1"),
    id: Uuid,
    documentVersionId: Uuid,
    workspaceId: Uuid,
    canonicalTextHash: Sha256,
    nodeIds: z.array(Uuid).min(1),
    educationalValidation: z.literal("none"),
  })
  .strict();

export type KnowledgeCollection = z.infer<typeof KnowledgeCollection>;

export const ExtractionCost = z
  .object({
    contract: z.literal("SOURCE-COST-v1"),
    documentVersionId: Uuid,
    workspaceId: Uuid,
    uploadedBytes: z.number().int().nonnegative(),
    storedBytes: z.number().int().nonnegative(),
    processedPages: z.number().int().nonnegative().nullable(),
    durationMs: z.number().nonnegative(),
    outcome: z.enum(["complete", "partial", "failed"]),
    aiGenerationAuthorized: z.literal(false),
  })
  .strict();

export type ExtractionCost = z.infer<typeof ExtractionCost>;
