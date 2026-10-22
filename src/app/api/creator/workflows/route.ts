import { creatorDatabase } from "@/auth/database";
import { readVerifiedSession } from "@/auth/session";
import { creatorWorkflowCreateResponse, creatorWorkflowListResponse, rejectUntrustedWorkflowMutation } from "@/auth/workflows";

export async function GET() {
  const result = await creatorWorkflowListResponse({ session: await readVerifiedSession(), sql: creatorDatabase() });
  return Response.json(result.body, { status: result.status });
}

export async function POST(request: Request) {
  const rejected = rejectUntrustedWorkflowMutation(request);
  if (rejected) return rejected;
  const body = await request.json().catch(() => null);
  const result = await creatorWorkflowCreateResponse({
    session: await readVerifiedSession(),
    sql: creatorDatabase(),
    body,
  });
  return Response.json(result.body, { status: result.status });
}
