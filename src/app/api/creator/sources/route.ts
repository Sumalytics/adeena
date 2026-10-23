import { creatorSourcePermissionResponse, creatorSourceResponse, creatorUploadResponse } from "@/auth/uploads";
import { creatorDatabase } from "@/auth/database";
import { readVerifiedSession } from "@/auth/session";
import { rejectUntrustedWorkflowMutation } from "@/auth/workflows";

export async function GET(request: Request) {
  const session = await readVerifiedSession();
  const url = new URL(request.url);
  const result = await creatorSourceResponse({
    session,
    sql: creatorDatabase(),
    documentVersionId: url.searchParams.get("documentVersionId"),
  });
  return Response.json(result.body, { status: result.status });
}

export async function POST(request: Request) {
  const session = await readVerifiedSession();
  const result = await creatorUploadResponse({
    session,
    sql: creatorDatabase(),
    request,
  });
  return Response.json(result.body, { status: result.status });
}

export async function PUT(request: Request) {
  const rejected = rejectUntrustedWorkflowMutation(request);
  if (rejected) return rejected;
  const session = await readVerifiedSession();
  const result = await creatorSourcePermissionResponse({
    session,
    sql: creatorDatabase(),
    body: await request.json().catch(() => null),
  });
  return Response.json(result.body, { status: result.status });
}
