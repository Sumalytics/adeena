import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { AudioAssetProvenanceV1, PrivateAudioAssetV1, type ApprovedAudioMime, type AudioAssetProvenance, type PrivateAudioAsset } from "@/audio/contract";
import { Uuid } from "@/contracts/common";
import type { VerifiedIdentity } from "./identity";
import { bindVerifiedActor, withWorkspace } from "./authz";
import type { PrivateAudioObjectStore } from "@/storage/audio-object-store";

type AudioRow = {
  id: string; workspace_id: string; experience_version_id: string; narration_segment_id: string;
  content_hash: string; storage_locator: string; mime_type: string; byte_count: number; duration_ms: number;
  locale: string; voice_profile_ref: string; status: string; provenance: unknown; created_at: Date | string; retired_at: Date | string | null;
};

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function record(row: AudioRow): PrivateAudioAsset {
  return PrivateAudioAssetV1.parse({
    contract: "ADEENA-PRIVATE-AUDIO-ASSET-v1", assetId: row.id, workspaceId: row.workspace_id,
    experienceVersionId: row.experience_version_id, narrationSegmentId: row.narration_segment_id,
    contentHash: row.content_hash, storageLocator: row.storage_locator, mimeType: row.mime_type,
    byteCount: Number(row.byte_count), durationMs: Number(row.duration_ms), locale: row.locale,
    voiceProfileRef: row.voice_profile_ref, status: row.status, provenance: row.provenance,
    createdAt: iso(row.created_at), retiredAt: row.retired_at ? iso(row.retired_at) : null,
  });
}

export async function registerPrivateAudioAsset(input: {
  sql: Sql; identity: VerifiedIdentity; workspaceId: string; experienceVersionId: string; narrationSegmentId: string;
  contentHash: string; mimeType: ApprovedAudioMime; bytes: Uint8Array; durationMs: number; locale: string;
  voiceProfileRef: string; provenance: AudioAssetProvenance; store: PrivateAudioObjectStore;
}) {
  const provenance = AudioAssetProvenanceV1.parse(input.provenance);
  return withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
      const version = await workspace.tx`select 1 from experience_versions where id = ${input.experienceVersionId}::uuid and workspace_id = ${workspace.workspaceId}::uuid`;
      if (!version[0]) throw new Error("audio-unavailable");
      const stored = await input.store.put(input);
      let rows = await workspace.tx<AudioRow[]>`
        insert into private_audio_assets (
          id, workspace_id, experience_version_id, narration_segment_id, content_hash, storage_locator,
          mime_type, byte_count, duration_ms, locale, voice_profile_ref, provenance
        ) values (
          ${randomUUID()}::uuid, ${workspace.workspaceId}::uuid, ${input.experienceVersionId}::uuid,
          ${input.narrationSegmentId}, ${input.contentHash}, ${stored.locator}, ${input.mimeType},
          ${input.bytes.byteLength}, ${input.durationMs}, ${input.locale}, ${input.voiceProfileRef}, ${JSON.stringify(provenance)}::jsonb
        ) on conflict (workspace_id, experience_version_id, narration_segment_id, content_hash) do nothing
        returning *`;
      if (!rows[0]) rows = await workspace.tx<AudioRow[]>`
        select * from private_audio_assets where workspace_id = ${workspace.workspaceId}::uuid
          and experience_version_id = ${input.experienceVersionId}::uuid
          and narration_segment_id = ${input.narrationSegmentId} and content_hash = ${input.contentHash}`;
      return record(rows[0]);
  });
}

/** Resolves by opaque asset id under RLS; callers never supply or receive a workspace locator. */
export async function readPrivateAudioAsset(input: { sql: Sql; identity: VerifiedIdentity; assetId: string }) {
  if (!Uuid.safeParse(input.assetId).success) return null;
  return input.sql.begin(async (tx) => {
    await bindVerifiedActor(tx as unknown as Sql, input.identity.userId);
    const rows = await tx<AudioRow[]>`select * from private_audio_assets where id = ${input.assetId}::uuid and status = 'active'`;
    return rows[0] ? record(rows[0]) : null;
  });
}

export async function retirePrivateAudioAsset(input: { sql: Sql; identity: VerifiedIdentity; workspaceId: string; assetId: string; store: PrivateAudioObjectStore }) {
  return withWorkspace(input.sql, input.identity, input.workspaceId, async (workspace) => {
    const rows = await workspace.tx<AudioRow[]>`
      update private_audio_assets set status = 'retired', retired_at = now()
      where id = ${input.assetId}::uuid and workspace_id = ${workspace.workspaceId}::uuid and status = 'active'
      returning *`;
    if (!rows[0]) return false;
    const other = await workspace.tx`select 1 from private_audio_assets where storage_locator = ${rows[0].storage_locator} and status = 'active' limit 1`;
    if (!other[0]) await input.store.retire(rows[0].storage_locator);
    return true;
  });
}
