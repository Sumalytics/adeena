import { creatorWorkspaceResponse } from "@/auth/creator";
import { creatorDatabase } from "@/auth/database";
import { readVerifiedSession } from "@/auth/session";

async function respond(request: Request) {
  const session = await readVerifiedSession();
  const url = new URL(request.url);
  let suppliedUserId = url.searchParams.get("userId");
  let requestedWorkspaceId = url.searchParams.get("workspaceId");
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as { userId?: unknown; workspaceId?: unknown };
      if (typeof body.userId === "string") suppliedUserId = body.userId;
      if (typeof body.workspaceId === "string") requestedWorkspaceId = body.workspaceId;
    } catch {
      suppliedUserId = url.searchParams.get("userId");
    }
  }
  const result = await creatorWorkspaceResponse({
    session,
    sql: creatorDatabase(),
    requestedWorkspaceId,
    suppliedUserId,
  });
  return Response.json(result.body, { status: result.status });
}

export function GET(request: Request) {
  return respond(request);
}

export function POST(request: Request) {
  return respond(request);
}
