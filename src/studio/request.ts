import { MAX_REQUEST_BYTES, SYNTHETIC_DEMO } from "@/studio/demo";

type HandlerResult = { status: number; body: unknown };

export async function demoResponse(request: Request, handle: (raw: unknown) => HandlerResult) {
  const parsed = await readLimitedJson(request);
  if (!parsed.ok) return demoJson(parsed.status, { error: parsed.error });
  try {
    const result = handle(parsed.value);
    if (!result.body || typeof result.body !== "object" || Array.isArray(result.body)) {
      return demoJson(500, { error: "demo-failed" });
    }
    return demoJson(result.status, result.body as Record<string, unknown>);
  } catch {
    return demoJson(500, { error: "demo-failed" });
  }
}

export function demoJson(status: number, body: Record<string, unknown>) {
  return Response.json(
    { demo: SYNTHETIC_DEMO, ...body },
    {
      status,
      headers: { "x-adeena-runtime": SYNTHETIC_DEMO.mode },
    },
  );
}

async function readLimitedJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const declared = declaredLength(request);
  if (declared !== null && declared > MAX_REQUEST_BYTES) {
    await request.body?.cancel();
    return { ok: false, status: 413, error: "body-too-large" };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400, error: "invalid-json" };
  }
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    return { ok: false, status: 413, error: "body-too-large" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "invalid-json" };
  }
}

function declaredLength(request: Request) {
  const raw = request.headers.get("content-length");
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY;
}
