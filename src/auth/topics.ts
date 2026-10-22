import type { Sql } from "postgres";
import { z } from "zod";
import { AUDIENCE_OPTIONS } from "@/app/studio/studio-form";
import { AgeBand, Uuid } from "@/contracts/common";
import { creatorDatabase } from "@/auth/database";
import { ensureIndividualWorkspace } from "@/db/creator";
import { correctTopicHeading, listExtractedSources, readTopicRecommendation, recommendFirstTopic } from "@/db/topic-repository";
import type { VerifiedIdentity } from "@/db/identity";
import { SourceError } from "@/source/errors";
import type { CreatorSession } from "./subject";

const RecommendBody = z
  .object({
    documentVersionId: Uuid,
    audienceLabel: z.enum(AUDIENCE_OPTIONS),
    ageBand: AgeBand,
    idempotencyKey: Uuid,
  })
  .strict();

const ReadQuery = z
  .object({
    documentVersionId: Uuid,
    audienceLabel: z.enum(AUDIENCE_OPTIONS),
    ageBand: AgeBand,
    offset: z.coerce.number().int().nonnegative().max(10_000).optional(),
  })
  .strict();

const CorrectionBody = z
  .object({
    documentVersionId: Uuid,
    nodeId: Uuid,
    correctedTitle: z.string().trim().min(1).max(200),
  })
  .strict();

export async function listCreatorSources(identity: VerifiedIdentity, workspaceId: string) {
  return listExtractedSources(creatorDatabase(), identity, workspaceId);
}

export async function readCreatorTopic(
  identity: VerifiedIdentity,
  workspaceId: string,
  input: { documentVersionId: string; audienceLabel: string; ageBand: AgeBand },
) {
  return readTopicRecommendation({
    sql: creatorDatabase(),
    identity,
    workspaceId,
    documentVersionId: input.documentVersionId,
    audienceLabel: input.audienceLabel,
    ageBand: input.ageBand,
  });
}

function failure(error: unknown) {
  if (error instanceof SourceError && error.code === "unauthenticated") {
    return { status: 401 as const, body: { error: "unauthenticated" } };
  }
  if (error instanceof SourceError && error.code === "invalid-topic") {
    return { status: 400 as const, body: { error: "invalid-topic" } };
  }
  if (error instanceof SourceError) return { status: 403 as const, body: { error: error.code } };
  throw error;
}

export async function creatorTopicResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  method: "GET" | "POST";
  search: URLSearchParams;
  body?: unknown;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    if (input.method === "GET") {
      const query = ReadQuery.safeParse({
        documentVersionId: input.search.get("documentVersionId"),
        audienceLabel: input.search.get("audienceLabel"),
        ageBand: input.search.get("ageBand"),
        offset: input.search.get("offset") ?? undefined,
      });
      if (!query.success) return { status: 400 as const, body: { error: "invalid-topic" } };
      const view = await readTopicRecommendation({
        sql: input.sql,
        identity: input.session.identity,
        workspaceId: workspace.workspaceId,
        documentVersionId: query.data.documentVersionId,
        audienceLabel: query.data.audienceLabel,
        ageBand: query.data.ageBand,
        offset: query.data.offset,
      });
      return { status: 200 as const, body: view };
    }
    const body = RecommendBody.safeParse(input.body);
    if (!body.success) return { status: 400 as const, body: { error: "invalid-topic" } };
    const view = await recommendFirstTopic({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      documentVersionId: body.data.documentVersionId,
      audienceLabel: body.data.audienceLabel,
      ageBand: body.data.ageBand,
      idempotencyKey: body.data.idempotencyKey,
    });
    return { status: 200 as const, body: view };
  } catch (error) {
    return failure(error);
  }
}

export async function creatorTopicCorrectionResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  body: unknown;
}) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  const body = CorrectionBody.safeParse(input.body);
  if (!body.success) return { status: 400 as const, body: { error: "invalid-topic" } };
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    const saved = await correctTopicHeading({
      sql: input.sql,
      identity: input.session.identity,
      workspaceId: workspace.workspaceId,
      documentVersionId: body.data.documentVersionId,
      nodeId: body.data.nodeId,
      correctedTitle: body.data.correctedTitle,
    });
    return {
      status: 200 as const,
      body: {
        overrideId: saved.override?.id ?? null,
        version: saved.override?.version ?? null,
        invalidated: saved.invalidated,
        generatesExperience: false as const,
      },
    };
  } catch (error) {
    return failure(error);
  }
}
