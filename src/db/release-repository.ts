import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { parseManifest } from "@adeena/experience-schema";
import { Uuid } from "@/contracts/common";
import { z } from "zod";
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

const RightsClearance = z.object({
  experienceVersionId: Uuid,
  basis: z.enum(["creator-owned", "licensed"]),
  evidence: z.string().trim().min(20).max(2000),
  permitsPublicAdaptation: z.literal(true),
}).strict();

export async function clearSourceRights(input: Actor & { body: unknown }) {
  const parsed = RightsClearance.safeParse(input.body);
  if (!parsed.success) throw new ReleaseError("invalid-publication");
  return withWorkspace(input.sql, input.identity, input.workspaceId, async ({ tx }) => {
    const [version] = await tx`select v.document_version_id from experience_versions v
      join source_document_versions d on d.id = v.document_version_id and d.workspace_id = v.workspace_id
      where v.id = ${parsed.data.experienceVersionId}::uuid and v.workspace_id = ${input.workspaceId}::uuid
      and d.rights_status = 'unverified' and adeena.is_owner(v.workspace_id)`;
    if (!version) throw new ReleaseError("publication-denied");
    await tx`insert into source_rights_clearances
      (id, workspace_id, document_version_id, basis, evidence, permits_public_adaptation)
      values (${randomUUID()}::uuid, ${input.workspaceId}::uuid, ${version.document_version_id}::uuid,
        ${parsed.data.basis}, ${parsed.data.evidence}, true)
      on conflict (workspace_id, document_version_id) do nothing`;
    return { recorded: true };
  });
}

export async function publicationStatus(input: Actor & { versionId: string }) {
  if (!Uuid.safeParse(input.versionId).success) throw new ReleaseError("invalid-publication");
  return withWorkspace(input.sql, input.identity, input.workspaceId, async ({ tx }) => {
    const [version] = await tx`select v.manifest, d.original_filename, d.rights_status,
      adeena.is_owner(v.workspace_id) as owner, c.basis, c.recorded_at,
      adeena.publication_blocks(v.id) as blocks
      from experience_versions v
      join source_document_versions d on d.id = v.document_version_id and d.workspace_id = v.workspace_id
      left join source_rights_clearances c on c.document_version_id = d.id and c.workspace_id = d.workspace_id
      where v.id = ${input.versionId}::uuid and v.workspace_id = ${input.workspaceId}::uuid`;
    if (!version) throw new ReleaseError("publication-denied");
    const blocks = [...version.blocks] as string[];
    try {
      if (!simulateExperience(publicReleaseManifest(version.manifest, randomUUID())).ok) blocks.push("validation-required");
    } catch { blocks.push("public-content-review-required"); }
    const [release] = await tx`select id::text, revoked_at, published_at from experience_releases
      where experience_version_id = ${input.versionId}::uuid and workspace_id = ${input.workspaceId}::uuid`;
    if (release?.revoked_at) blocks.push("release-revoked");
    return {
      versionId: input.versionId, eligible: blocks.length === 0, blocks: [...new Set(blocks)],
      sourceName: version.original_filename as string,
      canClearRights: version.owner === true && version.rights_status === "unverified" && !version.basis,
      rightsBasis: version.basis as string | null,
      rightsRecordedAt: version.recorded_at ?? null,
      release: release ? { releaseId: release.id as string, playPath: `/play/r/${release.id}`, revoked: Boolean(release.revoked_at) } : null,
    };
  });
}
