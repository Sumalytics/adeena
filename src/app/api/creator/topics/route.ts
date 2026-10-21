import { creatorTopicResponse } from "@/auth/topics";
import { creatorDatabase } from "@/auth/database";
import { readVerifiedSession } from "@/auth/session";

async function respond(request: Request, method: "GET" | "POST") {
  const session = await readVerifiedSession();
  const url = new URL(request.url);
  let body: unknown;
  if (method === "POST") {
    try {
      body = await request.json();
    } catch {
      body = null;
    }
  }
  const result = await creatorTopicResponse({
    session,
    sql: creatorDatabase(),
    method,
    search: url.searchParams,
    body,
  });
  return Response.json(result.body, { status: result.status });
}

export function GET(request: Request) {
  return respond(request, "GET");
}

export function POST(request: Request) {
  return respond(request, "POST");
}
