import { creatorDatabase } from "@/auth/database";
import { readVerifiedSession } from "@/auth/session";
import { creatorRevokeResponse } from "@/auth/releases";
import { rejectUntrustedWorkflowMutation } from "@/auth/workflows";
import { RELEASE_HEADERS } from "@/releases/contract";

export async function DELETE(request: Request, context: { params: Promise<{ releaseId: string }> }) {
  const rejected = rejectUntrustedWorkflowMutation(request);
  if (rejected) return rejected;
  const session = await readVerifiedSession();
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401, headers: RELEASE_HEADERS });
  const { releaseId } = await context.params;
  const result = await creatorRevokeResponse({ session, sql: creatorDatabase(), releaseId });
  return Response.json(result.body, { status: result.status, headers: RELEASE_HEADERS });
}
