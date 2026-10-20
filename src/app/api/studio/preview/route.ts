import { previewJob } from "@/studio/http";

export async function POST(request: Request) {
  return respond(request, previewJob);
}

async function respond(
  request: Request,
  handle: (raw: unknown) => { status: number; body: unknown },
) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid-json" }, { status: 400 });
  }
  const result = handle(raw);
  return Response.json(result.body, { status: result.status });
}
