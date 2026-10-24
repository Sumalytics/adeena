import { creatorDatabase } from "@/auth/database";
import { readVerifiedSession } from "@/auth/session";
import { creatorAudioResponse } from "@/audio/delivery";

export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await context.params;
  return creatorAudioResponse({ session: await readVerifiedSession(), sql: creatorDatabase(), assetId, range: request.headers.get("range") });
}
