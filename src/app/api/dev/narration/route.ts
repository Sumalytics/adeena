import { creatorDatabase } from "@/auth/database";
import { creatorNarrationResponse } from "@/auth/narration";
import { readVerifiedSession } from "@/auth/session";
import { rejectUntrustedWorkflowMutation } from "@/auth/workflows";

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const rejected = rejectUntrustedWorkflowMutation(request);
  if (rejected) return rejected;
  const body = await request.json().catch(() => null);
  const result = await creatorNarrationResponse({ session: await readVerifiedSession(), sql: creatorDatabase(), body });
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
