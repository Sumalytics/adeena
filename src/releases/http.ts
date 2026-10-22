import { creatorDatabase } from "@/auth/database";
import { readPublicRelease } from "@/db/release-repository";
import { RELEASE_HEADERS } from "./contract";

export async function publicReleaseResponse(releaseId: string) {
  try {
    const manifest = await readPublicRelease(creatorDatabase(), releaseId);
    return Response.json(manifest ? { manifest } : { error: "release-unavailable" }, {
      status: manifest ? 200 : 404, headers: RELEASE_HEADERS,
    });
  } catch {
    return Response.json({ error: "release-unavailable" }, { status: 503, headers: RELEASE_HEADERS });
  }
}
