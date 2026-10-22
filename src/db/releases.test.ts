import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFilesystemObjectStore } from "@/storage/filesystem";
import { creatorPublishResponse, creatorRevokeResponse } from "@/auth/releases";
import { sessionFromAuthUser } from "@/auth/subject";
import { createPlayerController } from "@/player/session";
import { publicReleaseManifest } from "@/releases/manifest";
import { openDatabase, type DatabaseClient } from "./client";
import { databaseUrl, applicationDatabaseUrl } from "./env";
import { urlForDatabase } from "./test-database";
import { migrateUp, migrateDown } from "./migrate";
import { createWorkspace, withWorkspace } from "./authz";
import { issueIdentityForIsolatedTests } from "./identity";
import { enqueueDurableSource, grantMembership } from "./source-repository";
import { runExtractionOnce } from "./worker";
import { recommendFirstTopic } from "./topic-repository";
import { createPlayableExperience } from "./experience-repository";
import { publishRelease, readPublicRelease, revokeRelease } from "./release-repository";
import { acceptExperienceEdit, proposeExperienceEdit } from "./edit-repository";

describe("public releases on an isolated database", () => {
  const database = `adeena_release_test_${randomUUID().replaceAll("-", "")}`;
  let maintenance: DatabaseClient;
  let admin: DatabaseClient;
  let sql: DatabaseClient;
  let created = false;
  const roots: string[] = [];

  beforeAll(async () => {
    maintenance = openDatabase(urlForDatabase(databaseUrl(), "postgres"));
    await maintenance.unsafe(`CREATE DATABASE ${database}`);
    created = true;
    admin = openDatabase(urlForDatabase(databaseUrl(), database));
    sql = openDatabase(urlForDatabase(applicationDatabaseUrl(), database));
    await migrateUp(admin);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    await admin?.end({ timeout: 1 });
    if (created) await maintenance.unsafe(`DROP DATABASE ${database}`);
    await maintenance?.end({ timeout: 1 });
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(rights: "cleared" | "unverified" = "cleared") {
    const userId = randomUUID();
    const identity = issueIdentityForIsolatedTests(userId);
    const workspaceId = randomUUID();
    await createWorkspace(sql, identity, { id: workspaceId, name: "Release test", workspaceType: "personal" });
    const root = await mkdtemp(path.join(tmpdir(), "adeena-release-"));
    roots.push(root);
    const store = createFilesystemObjectStore(root);
    const bytes = Buffer.from("# Water\n\n## Rivers\n\n" + "Water moves through rivers and returns to the sea. Learners compare the source note and explain what happens using only this passage. ".repeat(4));
    const hash = createHash("sha256").update(bytes).digest("hex");
    const stored = await store.putOriginal(workspaceId, hash, bytes);
    const documentId = randomUUID();
    const documentVersionId = randomUUID();
    // Seed reviewed source metadata at creation, without mutating immutable versions.
    await admin`insert into source_documents (id, workspace_id) values (${documentId}, ${workspaceId})`;
    await admin`insert into source_document_versions
      (id, document_id, workspace_id, version, original_filename, content_hash, media_type, size_bytes, storage_locator, rights_status, uploaded_by)
      values (${documentVersionId}, ${documentId}, ${workspaceId}, 1, 'water.md', ${hash}, 'text/markdown', ${bytes.length}, ${stored.locator}, ${rights}, ${userId})`;
    const actor = { sql, identity, workspaceId };
    await enqueueDurableSource({ ...actor, filename: "water.md", bytes, store, idempotencyKey: randomUUID() });
    await runExtractionOnce({ ...actor, store, leaseOwner: "release-test" });
    const recommendation = await recommendFirstTopic({ ...actor, documentVersionId, audienceLabel: "Primary learners", ageBand: "8-10", idempotencyKey: randomUUID() });
    const topicCandidateId = recommendation.recommendation?.topicCandidateId;
    if (!topicCandidateId) throw new Error("fixture topic missing");
    const generated = await createPlayableExperience({ ...actor, documentVersionId, topicCandidateId, audienceLabel: "Primary learners", ageBand: "8-10", idempotencyKey: randomUUID(), authorizeGeneration: true, provider: "deterministic-fixture" });
    if (!generated.experienceVersionId) throw new Error("fixture version missing");
    const versionId = generated.experienceVersionId;
    const approval = { experienceVersionId: versionId, decision: "approved", contentReviewed: true, privacy: "no-identifiable-learner", unresolvedHighRisk: false, note: "Reviewed the complete playable version and its source support." };
    return { ...actor, userId, documentVersionId, topicCandidateId, versionId, jobId: generated.jobId, body: { experienceVersionId: versionId, approval } };
  }

  it("publishes one reviewed fixed version; guests play without identity or model calls", async () => {
    const room = await fixture();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network during publication or playback"));
    try {
      const [first, retry] = await Promise.all([publishRelease(room), publishRelease(room)]);
      expect(first.releaseId).toBe(retry.releaseId);
      expect([first.replayed, retry.replayed].sort()).toEqual([false, true]);
      const manifest = await readPublicRelease(sql, first.releaseId);
      expect(manifest).not.toBeNull();
      expect(await sql`select * from experience_releases`).toHaveLength(0);
      expect(await sql`select * from experience_versions`).toHaveLength(0);
      const serialized = JSON.stringify(manifest);
      for (const privateValue of [room.workspaceId, room.userId, room.documentVersionId, room.versionId, "private://", "approval_evidence", "published_by"]) {
        expect(serialized).not.toContain(privateValue);
      }
      const controller = createPlayerController(manifest);
      controller.beginPlay();
      controller.beginChoice("read-note"); controller.settle();
      controller.beginChoice("keep-note"); controller.settle();
      expect(controller.snapshot().phase).toBe("completed");
      expect(network).not.toHaveBeenCalled();
      const [stored] = await admin`select published_by::text, published_at, approval_evidence from experience_releases where id = ${first.releaseId}`;
      expect(stored.published_by).toBe(room.userId);
      expect(stored.published_at).toBeTruthy();
      expect(stored.approval_evidence).toEqual(room.body.approval);
      const [version] = await admin`select publication_status, source_span_ids from experience_versions where id = ${room.versionId}`;
      expect(version.publication_status).toBe("unpublished");
      expect(version.source_span_ids.length).toBeGreaterThan(0);
      await expect(admin`update experience_versions set publication_status = 'published' where id = ${room.versionId}`).rejects.toThrow();
      await expect(admin`update experience_releases set public_manifest = '{}'::jsonb where id = ${first.releaseId}`).rejects.toThrow(/immutable/);
      await expect(withWorkspace(sql, room.identity, room.workspaceId, ({ tx }) => tx`delete from experience_releases where id = ${first.releaseId}`)).rejects.toThrow();
    } finally { network.mockRestore(); }
  });

  it("requires explicit matching approval and denies unresolved reviews and unverified rights", async () => {
    const room = await fixture();
    await expect(publishRelease({ ...room, body: { experienceVersionId: room.versionId } })).rejects.toMatchObject({ code: "invalid-publication" });
    for (const change of [{ experienceVersionId: randomUUID() }, { decision: "pending" }, { unresolvedHighRisk: true }, { privacy: "review-required" }, { note: "" }]) {
      await expect(publishRelease({ ...room, body: { ...room.body, approval: { ...room.body.approval, ...change } } })).rejects.toMatchObject({ code: "invalid-publication" });
    }
    const unverified = await fixture("unverified");
    // Even falsely marking the job ready cannot clear the source's independent rights gate.
    await admin`update experience_generation_jobs set review_status = 'ready-for-review' where id = ${unverified.jobId}`;
    await expect(publishRelease(unverified)).rejects.toMatchObject({ code: "publication-denied" });
    await admin`update experience_generation_jobs set review_status = 'review-required' where id = ${room.jobId}`;
    await expect(publishRelease(room)).rejects.toMatchObject({ code: "publication-denied" });
    await admin`update experience_generation_jobs set review_status = 'ready-for-review' where id = ${room.jobId}`;
    await admin`update topic_candidates set reasons = '["sensitive-domain"]'::jsonb where id = ${room.topicCandidateId}`;
    await expect(publishRelease(room)).rejects.toMatchObject({ code: "publication-denied" });
    await admin`update topic_candidates set reasons = '[]'::jsonb where id = ${room.topicCandidateId}`;
    await admin`update experience_validation_results set ok = false where experience_version_id = ${room.versionId}`;
    await expect(publishRelease(room)).rejects.toMatchObject({ code: "publication-denied" });
  });

  it("denies anonymous, cross-workspace, non-owner and inactive publication/revocation", async () => {
    const room = await fixture();
    const other = await fixture();
    expect((await creatorPublishResponse({ sql, session: null, body: room.body })).status).toBe(401);
    expect((await creatorRevokeResponse({ sql, session: null, releaseId: randomUUID() })).status).toBe(401);
    await expect(publishRelease({ ...other, body: room.body })).rejects.toMatchObject({ code: "publication-denied" });
    const editor = issueIdentityForIsolatedTests(randomUUID());
    await grantMembership(sql, room.identity, { workspaceId: room.workspaceId, userId: editor.userId, role: "editor" });
    await expect(publishRelease({ ...room, identity: editor })).rejects.toMatchObject({ code: "publication-denied" });
    const release = await publishRelease(room);
    await expect(revokeRelease({ ...other, releaseId: release.releaseId })).rejects.toMatchObject({ code: "release-unavailable" });
    await expect(revokeRelease({ ...room, identity: editor, releaseId: release.releaseId })).rejects.toMatchObject({ code: "publication-denied" });
    await admin`update workspace_memberships set status = 'inactive' where workspace_id = ${room.workspaceId} and user_id = ${room.userId}`;
    await expect(publishRelease(room)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(revokeRelease({ ...room, releaseId: release.releaseId })).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejects a blocked source even with otherwise valid generation and approval records", async () => {
    const room = await fixture();
    const sourceId = randomUUID();
    const topicId = randomUUID();
    const jobId = randomUUID();
    const versionId = randomUUID();
    // Administrative fixture inserts only: never disable immutable-source triggers.
    const sourcePatch = { id: sourceId, version: 2, rights_status: "blocked", content_hash: createHash("sha256").update(sourceId).digest("hex") };
    await admin`insert into source_document_versions select (jsonb_populate_record(null::source_document_versions,
      to_jsonb(d) || ${JSON.stringify(sourcePatch)}::text::jsonb)).* from source_document_versions d where id = ${room.documentVersionId}`;
    await admin`insert into topic_candidates select (jsonb_populate_record(null::topic_candidates,
      to_jsonb(t) || ${JSON.stringify({ id: topicId, document_version_id: sourceId })}::text::jsonb)).* from topic_candidates t where id = ${room.topicCandidateId}`;
    await admin`insert into experience_generation_jobs select (jsonb_populate_record(null::experience_generation_jobs,
      to_jsonb(j) || ${JSON.stringify({ id: jobId, document_version_id: sourceId, topic_candidate_id: topicId, idempotency_key: randomUUID(), experience_version_id: null })}::text::jsonb)).*
      from experience_generation_jobs j where id = ${room.jobId}`;
    await admin`insert into experience_versions select (jsonb_populate_record(null::experience_versions,
      to_jsonb(v) || ${JSON.stringify({ id: versionId, document_version_id: sourceId, topic_candidate_id: topicId, job_id: jobId })}::text::jsonb)).*
      from experience_versions v where id = ${room.versionId}`;
    await admin`update experience_generation_jobs set experience_version_id = ${versionId} where id = ${jobId}`;
    await admin`insert into experience_validation_results select (jsonb_populate_record(null::experience_validation_results,
      to_jsonb(r) || ${JSON.stringify({ id: randomUUID(), job_id: jobId, experience_version_id: versionId })}::text::jsonb)).*
      from experience_validation_results r where experience_version_id = ${room.versionId}`;
    await expect(publishRelease({ ...room, body: { experienceVersionId: versionId, approval: { ...room.body.approval, experienceVersionId: versionId } } })).rejects.toMatchObject({ code: "publication-denied" });
  });

  it("revokes durably and cannot republish the same release or expose drafts by id", async () => {
    const room = await fixture();
    expect(await readPublicRelease(sql, room.versionId)).toBeNull();
    expect(await readPublicRelease(sql, "invalid")).toBeNull();
    const session = sessionFromAuthUser({ id: room.userId });
    const published = await creatorPublishResponse({ sql, session, body: room.body });
    expect(published.status).toBe(200);
    const { releaseId } = published.body as { releaseId: string };
    expect(await readPublicRelease(sql, releaseId)).not.toBeNull();
    expect((await creatorRevokeResponse({ sql, session, releaseId })).status).toBe(200);
    expect((await creatorRevokeResponse({ sql, session, releaseId })).status).toBe(200);
    const fresh = openDatabase(urlForDatabase(applicationDatabaseUrl(), database));
    try { expect(await readPublicRelease(fresh, releaseId)).toBeNull(); } finally { await fresh.end(); }
    await expect(publishRelease(room)).rejects.toMatchObject({ code: "release-unavailable" });
    await expect(admin`update experience_releases set revoked_at = null, revoked_by = null where id = ${releaseId}`).rejects.toThrow();
  });

  it("keeps new edit proposals private and leaves an existing release fixed", async () => {
    const room = await fixture();
    const release = await publishRelease(room);
    const original = await readPublicRelease(sql, release.releaseId);
    const edit = await proposeExperienceEdit({ ...room, baseVersionId: room.versionId, expectedBaseVersionId: room.versionId, idempotencyKey: randomUUID(), instruction: "Simplify the dialogue.", authorizeEdit: true, provider: "deterministic-fixture" });
    if (edit.kind !== "ready" || !edit.proposal.proposedVersionId) throw new Error("edit fixture missing");
    const versionId = edit.proposal.proposedVersionId;
    const body = { experienceVersionId: versionId, approval: { ...room.body.approval, experienceVersionId: versionId } };
    await expect(publishRelease({ ...room, body })).rejects.toMatchObject({ code: "publication-denied" });
    expect(await readPublicRelease(sql, versionId)).toBeNull();
    await acceptExperienceEdit({ ...room, editJobId: edit.proposal.editJobId, expectedBaseVersionId: room.versionId });
    expect(await readPublicRelease(sql, release.releaseId)).toEqual(original);
    expect((await publishRelease({ ...room, body })).releaseId).not.toBe(release.releaseId);
  });

  it("rejects invalid manifests and sensitive or private content before projection", async () => {
    const room = await fixture();
    const [row] = await admin`select manifest from experience_versions where id = ${room.versionId}`;
    expect(() => publicReleaseManifest({}, randomUUID())).toThrow();
    expect(() => publicReleaseManifest({ ...row.manifest, title: "Medication dosage" }, randomUUID())).toThrow();
    expect(() => publicReleaseManifest({ ...row.manifest, title: "private://secret" }, randomUUID())).toThrow();
  });

  it("can reverse and reapply migrations in the disposable database", async () => {
    await migrateDown(admin);
    expect((await migrateUp(admin)).applied).toBe(true);
    expect((await migrateUp(admin)).applied).toBe(false);
  });
});
