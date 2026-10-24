import { creatorDatabase } from "@/auth/database";
import { readVerifiedSession } from "@/auth/session";
import { createAiVisualExperience } from "@/auth/visual-generation";
import { rejectUntrustedWorkflowMutation } from "@/auth/workflows";

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const rejected = rejectUntrustedWorkflowMutation(request);
  if (rejected) return rejected;
  const result = await createAiVisualExperience({ session: await readVerifiedSession(), sql: creatorDatabase(), body: await request.json().catch(() => null) });
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
