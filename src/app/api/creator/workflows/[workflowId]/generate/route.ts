import { creatorDatabase } from "@/auth/database";
import { readVerifiedSession } from "@/auth/session";
import { after } from "next/server";
import {
  creatorWorkflowGenerateResponse,
  creatorWorkflowGenerationReadResponse,
  rejectUntrustedWorkflowMutation,
} from "@/auth/workflows";

export const maxDuration = 180;

export async function GET(_request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await context.params;
  const result = await creatorWorkflowGenerationReadResponse({
    session: await readVerifiedSession(),
    sql: creatorDatabase(),
    workflowId,
  });
  return Response.json(result.body, { status: result.status });
}

export async function POST(request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const rejected = rejectUntrustedWorkflowMutation(request);
  if (rejected) return rejected;
  const { workflowId } = await context.params;
  const body = await request.json().catch(() => null);
  const result = await creatorWorkflowGenerateResponse({
    session: await readVerifiedSession(),
    sql: creatorDatabase(),
    workflowId,
    body,
  });
  if ("background" in result && result.background) after(result.background);
  return Response.json(result.body, { status: result.status });
}
