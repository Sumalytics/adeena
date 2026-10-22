import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { parseManifest } from "@adeena/experience-schema";
import { Uuid } from "@/contracts/common";
import { PublishRelease, ReleaseError } from "@/releases/contract";
import { publicReleaseManifest } from "@/releases/manifest";
import { simulateExperience } from "@/experience/simulate";
import { withWorkspace } from "./authz";
import type { VerifiedIdentity } from "./identity";

type Actor = { sql: Sql; identity: VerifiedIdentity; workspaceId: string };

export async function publishRelease(input: Actor & { body: unknown }) {
  const parsed = PublishRelease.safeParse(input.body);
  if (!parsed.success) throw new ReleaseError("invalid-publication");
  return withWorkspace(input.sql, input.identity, input.workspaceId, async ({ tx, userId }) => {
    const [owner] = await tx`select adeena.is_owner(${input.workspaceId}::uuid) as allowed`;
    if (owner?.allowed !== true) throw new ReleaseError("publication-denied");
    const versionId = parsed.data.experienceVersionId;
    // The version is immutable; the release unique key arbitrates concurrent publication.
    const [version] = await tx<{ manifest: unknown }[]>`
      select manifest from experience_versions
      where id = ${versionId}::uuid and workspace_id = ${input.workspaceId}::uuid
    `;
    if (!version) throw new ReleaseError("publication-denied");
    const id = randomUUID();
    const manifest = publicReleaseManifest(version.manifest, id);
    if (!simulateExperience(manifest).ok) throw new ReleaseError("publication-denied");
    try {
      const created = await tx<{ id: string }[]>`
        insert into experience_releases (id, workspace_id, experience_version_id, published_by, approval_evidence, public_manifest)
        values (${id}::uuid, ${input.workspaceId}::uuid, ${versionId}::uuid, ${userId}::uuid,
          ${JSON.stringify(parsed.data.approval)}::jsonb, ${JSON.stringify(manifest)}::jsonb)
        on conflict (workspace_id, experience_version_id) do nothing
        returning id::text
      `;
      const [release] = await tx<{ id: string; revoked_at: Date | null }[]>`
        select id::text, revoked_at from experience_releases
        where workspace_id = ${input.workspaceId}::uuid and experience_version_id = ${versionId}::uuid
      `;
      if (!release || release.revoked_at) throw new ReleaseError("release-unavailable");
      return { releaseId: release.id, playPath: `/play/r/${release.id}`, replayed: created.length === 0 };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23514") {
        throw new ReleaseError("publication-denied");
      }
      throw error;
    }
  });
}

export async function revokeRelease(input: Actor & { releaseId: string }) {
  if (!Uuid.safeParse(input.releaseId).success) throw new ReleaseError("invalid-publication");
  return withWorkspace(input.sql, input.identity, input.workspaceId, async ({ tx, userId }) => {
    const [owner] = await tx`select adeena.is_owner(${input.workspaceId}::uuid) as allowed`;
    if (owner?.allowed !== true) throw new ReleaseError("publication-denied");
    const [release] = await tx<{ revoked_at: Date | null }[]>`
      select revoked_at from experience_releases
      where id = ${input.releaseId}::uuid and workspace_id = ${input.workspaceId}::uuid for update
    `;
    if (!release) throw new ReleaseError("release-unavailable");
    if (!release.revoked_at) {
      await tx`update experience_releases set revoked_at = now(), revoked_by = ${userId}::uuid
        where id = ${input.releaseId}::uuid and workspace_id = ${input.workspaceId}::uuid`;
    }
    return { releaseId: input.releaseId, revoked: true as const };
  });
}

/** No session binding, source query, generation, or model call on the guest path. */
export async function readPublicRelease(sql: Sql, releaseId: string) {
  if (!Uuid.safeParse(releaseId).success) return null;
  const [row] = await sql<{ manifest: unknown }[]>`select adeena.read_public_release(${releaseId}::uuid) as manifest`;
  const parsed = parseManifest(row?.manifest);
  return parsed.ok ? parsed.manifest : null;
}
