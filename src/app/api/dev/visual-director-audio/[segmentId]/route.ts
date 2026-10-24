import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

const files = {
  "air-start": "air-start.wav",
  "air-route": "air-route.wav",
  "gas-exchange": "gas-exchange.wav",
} as const;

export async function GET(_request: Request, context: { params: Promise<{ segmentId: string }> }) {
  if (process.env.NODE_ENV === "production") return new NextResponse(null, { status: 404 });
  const { segmentId } = await context.params;
  const fileName = files[segmentId as keyof typeof files];
  if (!fileName) return new NextResponse(null, { status: 404 });
  const bytes = await readFile(path.join(process.cwd(), "docs", "media", "visual-director-audio", fileName));
  return new NextResponse(bytes, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "audio/wav",
      "Content-Length": String(bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
