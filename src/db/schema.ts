import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
};

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  workspaceType: text("workspace_type").notNull(),
  createdAt: timestamps.createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const workspaceMemberships = pgTable("workspace_memberships", {
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: text("role").notNull(),
  status: text("status").notNull(),
  createdAt: timestamps.createdAt,
});

export const sourceDocuments = pgTable("source_documents", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  createdAt: timestamps.createdAt,
});

export const sourceDocumentVersions = pgTable("source_document_versions", {
  id: uuid("id").primaryKey(),
  documentId: uuid("document_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  version: integer("version").notNull(),
  parentVersionId: uuid("parent_version_id"),
  originalFilename: text("original_filename").notNull(),
  contentHash: text("content_hash").notNull(),
  mediaType: text("media_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storageLocator: text("storage_locator").notNull(),
  rightsStatus: text("rights_status").notNull(),
  uploadedBy: uuid("uploaded_by").notNull(),
  createdAt: timestamps.createdAt,
});

export const extractionJobs = pgTable("extraction_jobs", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  documentVersionId: uuid("document_version_id").notNull(),
  idempotencyKey: uuid("idempotency_key").notNull(),
  status: text("status").notNull(),
  attemptCount: integer("attempt_count").notNull(),
  maxAttempts: integer("max_attempts").notNull(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
  failureCode: text("failure_code"),
  permanent: boolean("permanent").notNull(),
  createdAt: timestamps.createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const extractionResults = pgTable("extraction_results", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  documentVersionId: uuid("document_version_id").notNull(),
  jobId: uuid("job_id").notNull(),
  extractorName: text("extractor_name").notNull(),
  extractorVersion: text("extractor_version").notNull(),
  status: text("status").notNull(),
  canonicalLocator: text("canonical_locator"),
  canonicalTextHash: text("canonical_text_hash").notNull(),
  pageCount: integer("page_count"),
  diagnostics: jsonb("diagnostics").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const knowledgeCollections = pgTable("knowledge_collections", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  documentVersionId: uuid("document_version_id").notNull(),
  title: text("title"),
  structureStatus: text("structure_status").notNull(),
  canonicalTextHash: text("canonical_text_hash").notNull(),
  createdAt: timestamps.createdAt,
});

export const sourceSpans = pgTable("source_spans", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  documentVersionId: uuid("document_version_id").notNull(),
  extractionId: uuid("extraction_id").notNull(),
  textHash: text("text_hash").notNull(),
  startOffset: integer("start_offset").notNull(),
  endOffset: integer("end_offset").notNull(),
  pageNumber: integer("page_number"),
  excerpt: text("excerpt").notNull(),
});

export const knowledgeNodes = pgTable("knowledge_nodes", {
  id: uuid("id").primaryKey(),
  collectionId: uuid("collection_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  parentId: uuid("parent_id"),
  role: text("role").notNull(),
  title: text("title"),
  nodeOrder: integer("node_order").notNull(),
  confidence: text("confidence").notNull(),
  spanId: uuid("span_id").notNull(),
  createdAt: timestamps.createdAt,
});

export const topicOverrides = pgTable("topic_overrides", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  documentVersionId: uuid("document_version_id").notNull(),
  collectionId: uuid("collection_id").notNull(),
  nodeId: uuid("node_id").notNull(),
  version: integer("version").notNull(),
  correctedTitle: text("corrected_title").notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamps.createdAt,
});

export const topicCandidates = pgTable("topic_candidates", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  collectionId: uuid("collection_id").notNull(),
  documentVersionId: uuid("document_version_id").notNull(),
  extractionId: uuid("extraction_id").notNull(),
  detectionVersion: text("detection_version").notNull(),
  overrideVersion: integer("override_version").notNull(),
  title: text("title").notNull(),
  sourceOrder: integer("source_order").notNull(),
  detectionMethod: text("detection_method").notNull(),
  uncertainty: text("uncertainty").notNull(),
  eligibility: text("eligibility").notNull(),
  reasons: jsonb("reasons").notNull(),
  supportChars: integer("support_chars").notNull(),
  primaryNodeId: uuid("primary_node_id").notNull(),
  nodeIds: jsonb("node_ids").notNull(),
  sourceSpanIds: jsonb("source_span_ids").notNull(),
  createdAt: timestamps.createdAt,
});

export const recommendationRuns = pgTable("recommendation_runs", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  collectionId: uuid("collection_id"),
  documentVersionId: uuid("document_version_id").notNull(),
  extractionId: uuid("extraction_id").notNull(),
  detectionVersion: text("detection_version").notNull(),
  overrideVersion: integer("override_version").notNull(),
  audienceLabel: text("audience_label").notNull(),
  ageBand: text("age_band").notNull(),
  status: text("status").notNull(),
  topicCandidateId: uuid("topic_candidate_id"),
  reason: text("reason").notNull(),
  reasons: jsonb("reasons").notNull(),
  sourceSpanIds: jsonb("source_span_ids").notNull(),
  understood: text("understood").notNull(),
  candidateCount: integer("candidate_count").notNull(),
  processedChars: integer("processed_chars").notNull(),
  durationMs: integer("duration_ms").notNull(),
  failureCount: integer("failure_count").notNull(),
  generatesExperience: boolean("generates_experience").notNull(),
  experienceVersionId: uuid("experience_version_id"),
  aiGenerationAuthorized: boolean("ai_generation_authorized").notNull(),
  active: boolean("active").notNull(),
  idempotencyKey: uuid("idempotency_key").notNull(),
  createdAt: timestamps.createdAt,
});

export const sourceProcessingCosts = pgTable("source_processing_costs", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  jobId: uuid("job_id").notNull(),
  uploadedBytes: integer("uploaded_bytes").notNull(),
  storedBytes: integer("stored_bytes").notNull(),
  processedPages: integer("processed_pages"),
  durationMs: integer("duration_ms").notNull(),
  operationStatus: text("operation_status").notNull(),
  aiGenerationAuthorized: boolean("ai_generation_authorized").notNull(),
  createdAt: timestamps.createdAt,
});
