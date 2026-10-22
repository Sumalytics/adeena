import { connection } from "next/server";
import { publicReleaseResponse } from "@/releases/http";

export async function GET(_request: Request, context: { params: Promise<{ releaseId: string }> }) {
  await connection();
  const { releaseId } = await context.params;
  return publicReleaseResponse(releaseId);
}
