import { creatorDatabase } from "@/auth/database";
import { readVerifiedSession } from "@/auth/session";
import { creatorWorkflowReadResponse, creatorWorkflowUpdateResponse, rejectUntrustedWorkflowMutation } from "@/auth/workflows";

export async function GET(_request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await context.params;
  const result = await creatorWorkflowReadResponse({
    session: await readVerifiedSession(),
    sql: creatorDatabase(),
    workflowId,
  });
  return Response.json(result.body, { status: result.status });
}

export async function PATCH(request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const rejected = rejectUntrustedWorkflowMutation(request);
  if (rejected) return rejected;
  const { workflowId } = await context.params;
  const body = await request.json().catch(() => null);
  const result = await creatorWorkflowUpdateResponse({
    session: await readVerifiedSession(),
    sql: creatorDatabase(),
    workflowId,
    body,
  });
  return Response.json(result.body, { status: result.status });
}
