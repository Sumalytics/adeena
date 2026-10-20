import { scoreJob } from "@/studio/http";

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid-json" }, { status: 400 });
  }
  const result = scoreJob(raw);
  return Response.json(result.body, { status: result.status });
}
