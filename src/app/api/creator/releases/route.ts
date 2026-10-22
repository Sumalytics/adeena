import { creatorDatabase } from "@/auth/database";
import { readVerifiedSession } from "@/auth/session";
import { creatorPublishResponse, creatorPublicationStatusResponse } from "@/auth/releases";
import { rejectUntrustedWorkflowMutation } from "@/auth/workflows";
import { RELEASE_HEADERS } from "@/releases/contract";

export async function POST(request: Request) {
  const rejected = rejectUntrustedWorkflowMutation(request);
  if (rejected) return rejected;
  const session = await readVerifiedSession();
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401, headers: RELEASE_HEADERS });
  const result = await creatorPublishResponse({ session, sql: creatorDatabase(), body: await request.json().catch(() => null) });
  return Response.json(result.body, { status: result.status, headers: RELEASE_HEADERS });
}

export async function GET(request: Request) {
  const session = await readVerifiedSession();
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401, headers: RELEASE_HEADERS });
  const result = await creatorPublicationStatusResponse({ session, sql: creatorDatabase(), versionId: new URL(request.url).searchParams.get("versionId") ?? "" });
  return Response.json(result.body, { status: result.status, headers: RELEASE_HEADERS });
}
