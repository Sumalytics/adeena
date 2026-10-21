import { creatorExperienceContinueResponse } from "@/auth/experiences";
import { creatorDatabase } from "@/auth/database";
import { readVerifiedSession } from "@/auth/session";

export async function POST(request: Request) {
  const session = await readVerifiedSession();
  const body = await request.json().catch(() => null);
  const result = await creatorExperienceContinueResponse({ session, sql: creatorDatabase(), body });
  return Response.json(result.body, { status: result.status });
}
