import { creatorTopicCorrectionResponse } from "@/auth/topics";
import { creatorDatabase } from "@/auth/database";
import { readVerifiedSession } from "@/auth/session";

export async function POST(request: Request) {
  const session = await readVerifiedSession();
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const result = await creatorTopicCorrectionResponse({
    session,
    sql: creatorDatabase(),
    body,
  });
  return Response.json(result.body, { status: result.status });
}
