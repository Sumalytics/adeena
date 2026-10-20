import type { Sql } from "postgres";
import { SourceError } from "@/source/errors";
import { ensureIndividualWorkspace, openCreatorWorkspace } from "@/db/creator";
import type { CreatorSession } from "./subject";

export async function creatorWorkspaceResponse(input: {
  session: CreatorSession | null;
  sql: Sql;
  requestedWorkspaceId: string | null;
  suppliedUserId: string | null;
}) {
  void input.suppliedUserId;
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  try {
    if (!input.requestedWorkspaceId) {
      const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
      return {
        status: 200 as const,
        body: { userId: input.session.userId, workspaceId: workspace.workspaceId, created: workspace.created },
      };
    }
    const workspace = await openCreatorWorkspace(input.sql, input.session.identity, input.requestedWorkspaceId);
    return { status: 200 as const, body: { userId: input.session.userId, workspaceId: workspace.workspaceId } };
  } catch (error) {
    if (error instanceof SourceError && error.code === "unauthenticated") {
      return { status: 401 as const, body: { error: "unauthenticated" } };
    }
    if (error instanceof SourceError) return { status: 403 as const, body: { error: error.code } };
    throw error;
  }
}
