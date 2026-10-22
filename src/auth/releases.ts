import type { Sql } from "postgres";
import { ensureIndividualWorkspace } from "@/db/creator";
import { publishRelease, revokeRelease } from "@/db/release-repository";
import { ReleaseError } from "@/releases/contract";
import { SourceError } from "@/source/errors";
import type { CreatorSession } from "./subject";

type Input = { session: CreatorSession | null; sql: Sql };

async function respond(input: Input, run: (workspaceId: string) => Promise<unknown>) {
  if (!input.session) return { status: 401, body: { error: "unauthenticated" } };
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    return { status: 200, body: await run(workspace.workspaceId) };
  } catch (error) {
    if (error instanceof ReleaseError) {
      return { status: error.code === "invalid-publication" ? 400 : error.code === "release-unavailable" ? 404 : 403, body: { error: error.code } };
    }
    if (error instanceof SourceError) return { status: 403, body: { error: "publication-denied" } };
    throw error;
  }
}

export function creatorPublishResponse(input: Input & { body: unknown }) {
  return respond(input, (workspaceId) => publishRelease({ ...input, workspaceId, identity: input.session!.identity }));
}

export function creatorRevokeResponse(input: Input & { releaseId: string }) {
  return respond(input, (workspaceId) => revokeRelease({ ...input, workspaceId, identity: input.session!.identity }));
}
