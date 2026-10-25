import type { Sql } from "postgres";
import { Uuid } from "@/contracts/common";
import { ensureIndividualWorkspace } from "@/db/creator";
import { enqueueVisualGeneration } from "@/db/visual-generation-repository";
import { SourceError } from "@/source/errors";
import type { CreatorSession } from "./subject";

export async function createAiVisualExperience(input: { session: CreatorSession | null; sql: Sql; body: unknown }) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  const record = input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : {};
  const experienceVersionId = Uuid.safeParse(record.experienceVersionId);
  const idempotencyKey = Uuid.safeParse(record.idempotencyKey);
  if (!experienceVersionId.success || !idempotencyKey.success) return { status: 400 as const, body: { error: "invalid-generation" } };
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    const result = await enqueueVisualGeneration({ sql: input.sql, identity: input.session.identity, workspaceId: workspace.workspaceId, experienceVersionId: experienceVersionId.data, idempotencyKey: idempotencyKey.data });
    return { status: result.status === "ready" ? 201 as const : result.status === "in-progress" ? 202 as const : 422 as const, body: result };
  } catch (error) {
    const code = error instanceof SourceError ? error.code : "invalid-experience";
    const status = code === "unauthenticated" ? 401 as const : code === "budget-unavailable" || code === "generation-unavailable" ? 403 as const : 422 as const;
    return { status, body: { error: code } };
  }
}
