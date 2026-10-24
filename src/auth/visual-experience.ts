import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "postgres";
import type { PrivateAudioObjectStore } from "@/storage/audio-object-store";
import { Uuid } from "@/contracts/common";
import { registerPrivateAudioAsset } from "@/db/audio-repository";
import { ensureIndividualWorkspace } from "@/db/creator";
import { authoredProcessAssociation, bindVisualNarration, readVisualExperience } from "@/db/visual-experience-repository";
import { processDemoNarration } from "@/experience/visual-director/demo-narration";
import { authoredProcessFixture } from "@/experience/visual-director/fixtures";
import { NarrationPlaybackTrackV1 } from "@/experience/visual-director/schema";
import { SourceError } from "@/source/errors";
import { creatorAudioObjectStore } from "./storage";
import type { CreatorSession } from "./subject";
import { creatorDatabase } from "./database";

export async function readCreatorVisualExperience(identity: CreatorSession["identity"], workspaceId: string, experienceVersionId: string) {
  return readVisualExperience({ sql: creatorDatabase(), identity, workspaceId, experienceVersionId });
}

export async function createAuthoredVisualFixture(input: { session: CreatorSession | null; sql: Sql; body: unknown; store?: PrivateAudioObjectStore }) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  const body = input.body && typeof input.body === "object" && "experienceVersionId" in input.body ? Uuid.safeParse(input.body.experienceVersionId) : null;
  if (!body?.success) return { status: 400 as const, body: { error: "invalid-experience" } };
  try {
    const workspace = await ensureIndividualWorkspace(input.sql, input.session.identity);
    const associated = await authoredProcessAssociation({ sql: input.sql, identity: input.session.identity, workspaceId: workspace.workspaceId, experienceVersionId: body.data });
    const visual = await readVisualExperience({ sql: input.sql, identity: input.session.identity, workspaceId: workspace.workspaceId, experienceVersionId: body.data });
    if (!visual || visual.status !== "ready") throw new SourceError("invalid-experience");
    const store = input.store ?? creatorAudioObjectStore();
    for (const [index, media] of processDemoNarration.entries()) {
      const segment = authoredProcessFixture.scenes[0].narration[index];
      if (!segment) throw new SourceError("invalid-experience");
      const playback = NarrationPlaybackTrackV1.parse(media.playback);
      const filename = `${segment.id === "air-start" ? "air-start" : segment.id === "air-route" ? "air-route" : "gas-exchange"}.wav`;
      const bytes = await readFile(path.join(process.cwd(), "docs", "media", "visual-director-audio", filename));
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      const asset = await registerPrivateAudioAsset({ sql: input.sql, identity: input.session.identity, workspaceId: workspace.workspaceId,
        experienceVersionId: body.data, narrationSegmentId: segment.id, contentHash, mimeType: "audio/wav", bytes,
        durationMs: playback.durationMs, locale: visual.association.blueprint.locale, voiceProfileRef: visual.association.blueprint.voice.voiceProfileId,
        provenance: { kind: "authorized-test-asset", generator: "Task 04A Windows SAPI authored fixture", generatedAt: "2026-10-24T01:48:34.000Z" }, store });
      await bindVisualNarration({ sql: input.sql, identity: input.session.identity, workspaceId: workspace.workspaceId, experienceVersionId: body.data,
        associationId: associated.associationId, segmentId: segment.id, audioAssetId: asset.assetId,
        playback: { ...playback, audioAssetId: asset.assetId } });
    }
    return { status: associated.replayed ? 200 as const : 201 as const, body: { associationId: associated.associationId, previewPath: `/creator/preview/${body.data}`, authoredFixture: true } };
  } catch (error) {
    const code = error instanceof SourceError ? error.code : "invalid-experience";
    return { status: code === "unauthenticated" ? 401 as const : 422 as const, body: { error: code } };
  }
}
