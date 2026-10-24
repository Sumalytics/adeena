import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { publishRelease, readPublicRelease, revokeRelease, clearSourceRights, publicationStatus } from "./release-repository";
import { acceptExperienceEdit, proposeExperienceEdit } from "./edit-repository";
import { createFilesystemAudioStore } from "@/storage/audio-filesystem";
import { registerPrivateAudioAsset, retirePrivateAudioAsset } from "./audio-repository";
import { creatorAudioResponse } from "@/audio/delivery";
import { AudioStorageError } from "@/storage/audio-object-store";
import { NarrationPlaybackTrackV1 } from "@/experience/visual-director/schema";
import { enqueueNarrationGeneration, runNarrationGeneration } from "./narration-repository";
import { readVisualExperience } from "./visual-experience-repository";
import { createAuthoredVisualFixture } from "@/auth/visual-experience";

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

  async function fixture(rights: "cleared" | "unverified" = "cleared", permissionDeclared = true, subject: "water" | "respiration" = "water") {
    const userId = randomUUID();
    const identity = issueIdentityForIsolatedTests(userId);
    const workspaceId = randomUUID();
    await createWorkspace(sql, identity, { id: workspaceId, name: "Release test", workspaceType: "personal" });
    const root = await mkdtemp(path.join(tmpdir(), "adeena-release-"));
    roots.push(root);
    const store = createFilesystemObjectStore(root);
    const bytes = Buffer.from(subject === "respiration"
      ? "# Breathing route\n\n## Airway sequence\n\n" + "Air enters through the nose or mouth, travels through the trachea and bronchi, then reaches smaller airways and the alveoli. Oxygen enters nearby blood while carbon dioxide moves into the air sacs to be exhaled. ".repeat(4)
      : "# Water\n\n## Rivers\n\n" + "Water moves through rivers and returns to the sea. Learners compare the source note and explain what happens using only this passage. ".repeat(4));
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
    if (!permissionDeclared) await admin`delete from source_permission_declarations where document_version_id = ${documentVersionId}`;
    return { ...actor, userId, documentVersionId, topicCandidateId, versionId, jobId: generated.jobId, body: { experienceVersionId: versionId } };
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
      expect(stored.approval_evidence).toEqual({
        mode: "creator-declared-mvp",
        experienceVersionId: room.versionId,
        sourceAuthorizationGatePassed: true,
        contentApprovalRecorded: false,
        initiatedBy: "share-action",
        policyVersion: "mvp-share-v1",
      });
      const [version] = await admin`select publication_status, source_span_ids from experience_versions where id = ${room.versionId}`;
      expect(version.publication_status).toBe("unpublished");
      expect(version.source_span_ids.length).toBeGreaterThan(0);
      await expect(admin`update experience_versions set publication_status = 'published' where id = ${room.versionId}`).rejects.toThrow();
      await expect(admin`update experience_releases set public_manifest = '{}'::jsonb where id = ${first.releaseId}`).rejects.toThrow(/immutable/);
      await expect(withWorkspace(sql, room.identity, room.workspaceId, ({ tx }) => tx`delete from experience_releases where id = ${first.releaseId}`)).rejects.toThrow();
    } finally { network.mockRestore(); }
  });

  it("requires a deliberate version, accepts declared unverified rights, and preserves safety gates", async () => {
    const room = await fixture();
    await expect(publishRelease({ ...room, body: {} })).rejects.toMatchObject({ code: "invalid-publication" });
    await expect(publishRelease({ ...room, body: { ...room.body, approval: {} } })).rejects.toMatchObject({ code: "invalid-publication" });
    const unverified = await fixture("unverified");
    expect((await publicationStatus({ ...unverified, versionId: unverified.versionId })).eligible).toBe(true);
    const [source] = await admin`select rights_status from source_document_versions where id = ${unverified.documentVersionId}`;
    expect(source.rights_status).toBe("unverified");
    const undeclared = await fixture("unverified", false);
    expect((await publicationStatus({ ...undeclared, versionId: undeclared.versionId })).blocks).toContain("permission-declaration-required");
    await expect(publishRelease(undeclared)).rejects.toMatchObject({ code: "publication-denied" });
    await admin`update experience_generation_jobs set review_status = 'review-required' where id = ${room.jobId}`;
    expect((await publicationStatus({ ...room, versionId: room.versionId })).eligible).toBe(true);
    await admin`update recommendation_runs set reasons = '["sensitive-domain"]'::jsonb where document_version_id = ${room.documentVersionId}`;
    expect((await publicationStatus({ ...room, versionId: room.versionId })).eligible).toBe(true);
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
    await expect(publishRelease({ ...room, body: { experienceVersionId: versionId } })).rejects.toMatchObject({ code: "publication-denied" });
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
    const body = { experienceVersionId: versionId };
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

  it("records explicit rights evidence without rewriting source and permits ordinary creator publication", async () => {
    const room = await fixture("unverified", false);
    const before = await publicationStatus({ ...room, versionId: room.versionId });
    expect(before.blocks).toContain("permission-declaration-required");
    const body = { experienceVersionId: room.versionId, basis: "creator-owned", evidence: "I authored this water passage and permit its public adaptation.", permitsPublicAdaptation: true };
    await expect(clearSourceRights({ ...room, body: { ...body, permitsPublicAdaptation: false } })).rejects.toMatchObject({ code: "invalid-publication" });
    const other = await fixture();
    await expect(clearSourceRights({ ...other, body })).rejects.toMatchObject({ code: "publication-denied" });
    const editor = issueIdentityForIsolatedTests(randomUUID());
    await grantMembership(sql, room.identity, { workspaceId: room.workspaceId, userId: editor.userId, role: "editor" });
    await expect(clearSourceRights({ ...room, identity: editor, body })).rejects.toMatchObject({ code: "publication-denied" });
    await clearSourceRights({ ...room, body });
    await clearSourceRights({ ...room, body: { ...body, evidence: "A different note must not replace the original evidence." } });
    expect((await publicationStatus({ ...room, versionId: room.versionId })).eligible).toBe(true);
    const [source] = await admin`select rights_status from source_document_versions where id = ${room.documentVersionId}`;
    expect(source.rights_status).toBe("unverified");
    const [record] = await admin`select * from source_rights_clearances where document_version_id = ${room.documentVersionId}`;
    expect(record.evidence).toBe(body.evidence);
    expect(record.recorded_by).toBe(room.userId);
    expect(record.recorded_at).toBeTruthy();
    expect(await sql`select * from source_rights_clearances`).toHaveLength(0);
    await expect(withWorkspace(sql, room.identity, room.workspaceId, ({ tx }) => tx`update source_rights_clearances set evidence = 'Changed evidence is forbidden' where id = ${record.id}`)).rejects.toThrow();
    const published = await publishRelease(room);
    const publicText = JSON.stringify(await readPublicRelease(sql, published.releaseId));
    expect(publicText).not.toContain(body.evidence);
    expect(publicText).not.toContain(room.documentVersionId);
    await admin`update topic_candidates set reasons = '["sensitive-domain"]'::jsonb where id = ${room.topicCandidateId}`;
    expect((await publicationStatus({ ...room, versionId: room.versionId })).blocks).toContain("independent-review-required");
    await expect(publishRelease(room)).rejects.toMatchObject({ code: "publication-denied" });
  });

  it("accepts an eligible accepted edit without a second content approval", async () => {
    const room = await fixture("unverified", false);
    await clearSourceRights({ ...room, body: { experienceVersionId: room.versionId, basis: "licensed", evidence: "Written licence from the author permits public adaptation and sharing.", permitsPublicAdaptation: true } });
    const edit = await proposeExperienceEdit({ ...room, baseVersionId: room.versionId, expectedBaseVersionId: room.versionId, idempotencyKey: randomUUID(), instruction: "Simplify the dialogue.", authorizeEdit: true, provider: "deterministic-fixture" });
    if (edit.kind !== "ready" || !edit.proposal.proposedVersionId) throw new Error("edit missing");
    await acceptExperienceEdit({ ...room, editJobId: edit.proposal.editJobId, expectedBaseVersionId: room.versionId });
    expect((await publicationStatus({ ...room, versionId: edit.proposal.proposedVersionId })).eligible).toBe(true);
    expect((await publishRelease({ ...room, body: { experienceVersionId: edit.proposal.proposedVersionId } })).releaseId).toBeTruthy();
  });

  it("delivers private immutable audio only to an authorized workspace member, including ranges", async () => {
    const room = await fixture();
    const other = await fixture();
    const root = await mkdtemp(path.join(tmpdir(), "adeena-private-audio-"));
    roots.push(root);
    const store = createFilesystemAudioStore(root);
    const bytes = await readFile("docs/media/visual-director-audio/air-start.wav");
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const input = {
      ...room, experienceVersionId: room.versionId, narrationSegmentId: "air-start", contentHash,
      mimeType: "audio/wav" as const, bytes, durationMs: 3_364, locale: "en-GH", voiceProfileRef: "educator-warm-1",
      provenance: { kind: "authorized-test-asset" as const, generator: "Windows SAPI local fixture", generatedAt: "2026-10-24T01:48:34.000Z" }, store,
    };
    const asset = await registerPrivateAudioAsset(input);
    const duplicate = await registerPrivateAudioAsset(input);
    expect(duplicate.assetId).toBe(asset.assetId);
    expect(asset.storageLocator).toMatch(/^private-audio:/);
    const session = sessionFromAuthUser({ id: room.userId });
    const full = await creatorAudioResponse({ session, sql, assetId: asset.assetId, range: null, store });
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("audio/wav");
    expect(full.headers.get("content-length")).toBe(String(bytes.byteLength));
    const partial = await creatorAudioResponse({ session, sql, assetId: asset.assetId, range: "bytes=10-109", store });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 10-109/${bytes.byteLength}`);
    expect((await partial.arrayBuffer()).byteLength).toBe(100);
    expect((await creatorAudioResponse({ session: null, sql, assetId: asset.assetId, range: null, store })).status).toBe(401);
    expect((await creatorAudioResponse({ session: sessionFromAuthUser({ id: other.userId }), sql, assetId: asset.assetId, range: null, store })).status).toBe(404);
    expect((await creatorAudioResponse({ session, sql, assetId: "malformed", range: null, store })).status).toBe(404);
    expect(await sql`select * from private_audio_assets`).toHaveLength(0);
    await expect(admin`update private_audio_assets set duration_ms = 1 where id = ${asset.assetId}`).rejects.toThrow(/immutable/);
    expect(await retirePrivateAudioAsset({ ...room, assetId: asset.assetId, store })).toBe(true);
    expect((await creatorAudioResponse({ session, sql, assetId: asset.assetId, range: null, store })).status).toBe(404);
  });

  it("generates one fake narration operation for concurrent duplicate requests and reuses the verified private cache", async () => {
    const room = await fixture();
    const root = await mkdtemp(path.join(tmpdir(), "adeena-narration-"));
    roots.push(root);
    const store = createFilesystemAudioStore(root);
    const env = { NODE_ENV: "test", ADEENA_TTS_PROVIDER: "fake" };
    const base = { experienceVersionId: room.versionId, text: "Water moves downhill and returns to the sea.", caption: "Water moves downhill and returns to the sea.",
      locale: "en-US", voiceProfileId: "educator-warm-1" as const, style: "warm" as const, rate: 1, cueIds: ["show-water"], approved: true as const };
    const first = await enqueueNarrationGeneration({ ...room, request: { ...base, narrationSegmentId: "water-one", idempotencyKey: randomUUID() }, env });
    const second = await enqueueNarrationGeneration({ ...room, request: { ...base, narrationSegmentId: "water-two", idempotencyKey: randomUUID() }, env });
    const runs = await Promise.all([
      runNarrationGeneration({ ...room, jobId: first.jobId, leaseOwner: "narration-one", store, env }),
      runNarrationGeneration({ ...room, jobId: second.jobId, leaseOwner: "narration-two", store, env }),
    ]);
    expect(runs.some((item) => item.kind === "ready")).toBe(true);
    const generated = runs.find((item) => item.kind === "ready");
    if (!generated || generated.kind !== "ready") throw new Error("generated narration missing");
    const playback = NarrationPlaybackTrackV1.parse(generated.playback);
    expect(playback.captions).toEqual([{ startMs: 0, endMs: playback.durationMs, text: base.text }]);
    const authenticatedAudio = await creatorAudioResponse({ session: sessionFromAuthUser({ id: room.userId }), sql, assetId: generated.assetId, range: null, store });
    expect(authenticatedAudio.status).toBe(200);
    expect(authenticatedAudio.headers.get("content-type")).toBe("audio/wav");
    const pendingIndex = runs.findIndex((item) => item.kind === "pending");
    if (pendingIndex >= 0) {
      const pending = pendingIndex === 0 ? first : second;
      const cached = await runNarrationGeneration({ ...room, jobId: pending.jobId, leaseOwner: "narration-cache", store, env });
      expect(cached.kind).toBe("ready");
    }
    const costs = await admin<{ cache_status: string; actual: number }[]>`select cache_status,actual_cost_micros::int as actual from narration_generation_costs where workspace_id=${room.workspaceId}::uuid order by cache_status`;
    expect(costs).toEqual([{ cache_status: "hit", actual: 0 }, { cache_status: "miss", actual: 0 }]);
    expect(await admin`select * from narration_audio_cache where workspace_id=${room.workspaceId}::uuid`).toHaveLength(1);
    expect(await admin`select * from private_audio_assets where workspace_id=${room.workspaceId}::uuid`).toHaveLength(2);
    const replay = await runNarrationGeneration({ ...room, jobId: first.jobId, leaseOwner: "narration-replay", store, env });
    expect(replay).toMatchObject({ kind: "done", status: "ready" });
    expect(await admin`select * from narration_generation_costs where workspace_id=${room.workspaceId}::uuid`).toHaveLength(2);
    const changed = await enqueueNarrationGeneration({ ...room, request: { ...base, text: "Water follows a changed route.", caption: "Water follows a changed route.", narrationSegmentId: "water-one", idempotencyKey: randomUUID() }, env });
    expect((await runNarrationGeneration({ ...room, jobId: changed.jobId, leaseOwner: "narration-changed", store, env })).kind).toBe("ready");
    expect(await admin`select * from narration_audio_cache where workspace_id=${room.workspaceId}::uuid`).toHaveLength(2);
    const missCount = await admin<{ total: number }[]>`select count(*)::int as total from narration_generation_costs where workspace_id=${room.workspaceId}::uuid and cache_status='miss'`;
    expect(missCount[0]?.total).toBe(2);
    const other = await fixture();
    await expect(runNarrationGeneration({ ...other, jobId: first.jobId, leaseOwner: "narration-other", store, env })).rejects.toMatchObject({ code: "authorization-required" });
    const storageJob = await enqueueNarrationGeneration({ ...room, request: { ...base, text: "A storage failure sentence.", caption: "A storage failure sentence.", narrationSegmentId: "storage-failure", idempotencyKey: randomUUID() }, env });
    const failingStore = { ...store, put: async () => { throw new AudioStorageError("unavailable"); } };
    await expect(runNarrationGeneration({ ...room, jobId: storageJob.jobId, leaseOwner: "narration-storage", store: failingStore, env })).rejects.toMatchObject({ code: "storage-failed", knownCharge: true });
    const metadataJob = await enqueueNarrationGeneration({ ...room, request: { ...base, text: "A metadata failure sentence.", caption: "A metadata failure sentence.", narrationSegmentId: "metadata-failure", idempotencyKey: randomUUID() }, env });
    const invalidLocatorStore = { ...store, put: async () => ({ locator: "invalid-private-locator", created: true }) };
    await expect(runNarrationGeneration({ ...room, jobId: metadataJob.jobId, leaseOwner: "narration-metadata", store: invalidLocatorStore, env })).rejects.toMatchObject({ code: "metadata-failed", knownCharge: true });
    const failures = await admin<{ failure_code: string }[]>`select failure_code from narration_generation_jobs where id in (${storageJob.jobId}::uuid,${metadataJob.jobId}::uuid) order by failure_code`;
    expect(failures).toEqual([{ failure_code: "metadata-failed" }, { failure_code: "storage-failed" }]);
  });

  it("loads an authored visual fixture through the version preview path with private narration and tenant isolation", async () => {
    const room = await fixture("cleared", true, "respiration");
    const other = await fixture();
    const audioRoot = await mkdtemp(path.join(tmpdir(), "adeena-visual-audio-"));
    roots.push(audioRoot);
    const audioStore = createFilesystemAudioStore(audioRoot);
    expect(await readVisualExperience({ ...room, experienceVersionId: room.versionId })).toBeNull();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("preview must not call a provider"));
    try {
      const created = await createAuthoredVisualFixture({ session: sessionFromAuthUser({ id: room.userId }), sql, body: { experienceVersionId: room.versionId }, store: audioStore });
      expect(created.status).toBe(201);
      const visual = await readVisualExperience({ ...room, experienceVersionId: room.versionId });
      expect(visual?.status).toBe("ready");
      if (!visual || visual.status !== "ready") throw new Error("visual association missing");
      expect(visual.association.blueprint.scenes[0]?.id).toBe("air-path");
      expect(visual.association.mapping.scenes[0]?.visualSceneId).toBe("air-path");
      expect(visual.narration).toHaveLength(3);
      expect(network).not.toHaveBeenCalled();
      const assetId = visual.narration[0]?.playback.audioAssetId ?? randomUUID();
      expect((await creatorAudioResponse({ session: sessionFromAuthUser({ id: room.userId }), sql, assetId, range: null, store: audioStore })).status).toBe(200);
      expect((await creatorAudioResponse({ session: sessionFromAuthUser({ id: other.userId }), sql, assetId, range: null, store: audioStore })).status).toBe(404);
      expect(await readVisualExperience({ ...other, experienceVersionId: room.versionId })).toBeNull();
      await expect(admin`update visual_experience_blueprints set renderer_version='visual-renderer@2' where id=${visual.association.associationId}::uuid`).rejects.toThrow(/immutable/);
    } finally { network.mockRestore(); }
    const unrelated = await fixture();
    expect((await createAuthoredVisualFixture({ session: sessionFromAuthUser({ id: unrelated.userId }), sql, body: { experienceVersionId: unrelated.versionId } })).status).toBe(422);
  });

  it("can reverse and reapply migrations in the disposable database", async () => {
    await migrateDown(admin);
    expect((await migrateUp(admin)).applied).toBe(true);
    expect((await migrateUp(admin)).applied).toBe(false);
  }, 15_000);
});
