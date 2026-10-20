import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYNTHETIC_WORKSPACE_ID } from "@/contracts/common";
import { createFilesystemObjectStore } from "@/storage/filesystem";
import { reconcileOrphans } from "@/storage/reconcile";
import { SourceError } from "@/source/errors";
import { withWorkspace, createWorkspace } from "./authz";
import { databaseFailure, openDatabase, type DatabaseClient } from "./client";
import { applicationDatabaseUrl, databaseUrl, redactDatabaseMessage } from "./env";
import { issueIdentityForIsolatedTests, type VerifiedIdentity } from "./identity";
import { migrateDown, migrateUp } from "./migrate";
import {
  enqueueDurableSource,
  grantMembership,
  readExtractionRecord,
  readJob,
  readSourceVersion,
  referencedLocators,
  setMembershipStatus,
} from "./source-repository";
import { claimExtractionJob, runExtractionOnce } from "./worker";
import { ensureIndividualWorkspace, openCreatorWorkspace } from "./creator";
import { creatorWorkspaceResponse } from "@/auth/creator";
import { sessionFromAuthUser } from "@/auth/subject";

describe("database configuration", () => {
  it("redacts connection strings from database errors", () => {
    const redacted = redactDatabaseMessage("failed postgresql://adeena_app:secret@127.0.0.1:5432/adeena_dev");
    expect(redacted).toBe("failed postgresql://redacted");
    expect(redacted).not.toContain("secret");
  });

  it("reports an unreachable database without embedding a credential", async () => {
    const sql = openDatabase("postgresql://adeena_app:invalid@127.0.0.1:1/adeena_dev");
    try {
      await expect(sql`select 1`).rejects.toThrow();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});

describe("postgresql source persistence", () => {
  let admin: DatabaseClient;
  let sql: DatabaseClient;
  let ready = false;
  const roots: string[] = [];

  beforeAll(async () => {
    admin = openDatabase(databaseUrl());
    sql = openDatabase(applicationDatabaseUrl());
    try {
      await admin`select 1 as ok`;
      const session = await sql`
        select current_user as role, rolsuper, rolbypassrls
        from pg_roles
        where rolname = current_user
      `;
      expect(session[0]).toMatchObject({ role: "adeena_app", rolsuper: false, rolbypassrls: false });
    } catch (error) {
      if (error instanceof Error && error.name === "AssertionError") throw error;
      throw databaseFailure(error);
    }
    await migrateDown(admin);
    const first = await migrateUp(admin);
    expect(first.applied).toBe(true);
    ready = true;
  });

  afterAll(async () => {
    try {
      if (ready && admin) {
        await admin`TRUNCATE source_processing_costs, knowledge_nodes, source_spans, knowledge_collections, extraction_results, extraction_jobs, source_document_versions, source_documents, workspace_memberships, workspaces`;
      }
    } finally {
      if (admin) await admin.end({ timeout: 1 });
      if (sql) await sql.end({ timeout: 1 });
    }
  });

  async function tenant(name = "Lesson room") {
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const identity = issueIdentityForIsolatedTests(userId);
    await createWorkspace(sql, identity, { id: workspaceId, name, workspaceType: "personal" });
    const root = await mkdtemp(path.join(tmpdir(), "adeena-db-"));
    roots.push(root);
    return { workspaceId, userId, identity, store: createFilesystemObjectStore(root) };
  }

  it("applies the migration again without changing the schema", async () => {
    expect(await migrateUp(admin)).toMatchObject({ applied: false });
    const tables = await sql`select to_regclass('public.source_document_versions') as versions`;
    expect(tables[0]?.versions).toBe("source_document_versions");
    await expect(sql`select id from adeena_schema_migrations`).rejects.toThrow();
  });

  it("creates a workspace only for a verified identity", async () => {
    const { workspaceId, identity } = await tenant();
    const rows = await withWorkspace(sql, identity, workspaceId, async ({ tx }) => {
      return tx`select name, workspace_type from workspaces where id = ${workspaceId}::uuid`;
    });
    expect(rows[0]).toMatchObject({ name: "Lesson room", workspace_type: "personal" });
    await expect(createWorkspace(sql, {} as VerifiedIdentity, { id: randomUUID(), name: "No", workspaceType: "personal" })).rejects.toThrow(SourceError);
    await expect(createWorkspace(sql, identity, { id: SYNTHETIC_WORKSPACE_ID, name: "Synthetic", workspaceType: "personal" })).rejects.toThrow(SourceError);
    const hidden = await sql`select id from workspaces where id = ${workspaceId}::uuid`;
    expect(hidden).toHaveLength(0);
    const stored = await admin`select id from workspaces where id = ${workspaceId}::uuid`;
    expect(stored).toHaveLength(1);
  });

  it("enforces membership constraints and inactive denial", async () => {
    const { workspaceId, identity } = await tenant();
    const member = randomUUID();
    await grantMembership(sql, identity, { workspaceId, userId: member, role: "editor" });
    await expect(grantMembership(sql, identity, { workspaceId, userId: member, role: "editor" })).rejects.toThrow();
    await expect(
      withWorkspace(sql, identity, workspaceId, async ({ tx }) => {
        await tx`insert into workspace_memberships (workspace_id, user_id, role, status) values (${workspaceId}::uuid, ${randomUUID()}::uuid, 'superuser', 'active')`;
      }),
    ).rejects.toThrow();
    await setMembershipStatus(sql, identity, { workspaceId, userId: member, status: "inactive" });
    await expect(withWorkspace(sql, issueIdentityForIsolatedTests(member), workspaceId, async () => true)).rejects.toThrow(SourceError);
  });

  it("denies cross-workspace reads and writes", async () => {
    const left = await tenant("Left");
    const right = await tenant("Right");
    const enqueued = await enqueueDurableSource({
      sql,
      identity: left.identity,
      workspaceId: left.workspaceId,
      filename: "lesson.txt",
      bytes: Buffer.from("Private lesson."),
      idempotencyKey: randomUUID(),
      store: left.store,
    });
    const versionId = enqueued.version?.id ?? enqueued.job.documentVersionId;
    await expect(readSourceVersion(sql, right.identity, left.workspaceId, versionId)).rejects.toThrow(SourceError);
    await expect(readSourceVersion(sql, right.identity, right.workspaceId, versionId)).rejects.toThrow(SourceError);
    await expect(
      withWorkspace(sql, right.identity, right.workspaceId, async ({ tx }) => {
        await tx`insert into source_documents (id, workspace_id) values (${randomUUID()}::uuid, ${left.workspaceId}::uuid)`;
      }),
    ).rejects.toThrow();
  });

  it("keeps one immutable hashed version and persists extraction", async () => {
    const room = await tenant();
    const bytes = Buffer.from("# Rivers\n\nWater moves downhill.");
    const key = randomUUID();
    const started = performance.now();
    const first = await enqueueDurableSource({
      sql,
      identity: room.identity,
      workspaceId: room.workspaceId,
      filename: "C:\\secret\\chapter.md",
      bytes,
      idempotencyKey: key,
      store: room.store,
    });
    const second = await enqueueDurableSource({
      sql,
      identity: room.identity,
      workspaceId: room.workspaceId,
      filename: "chapter.md",
      bytes,
      idempotencyKey: key,
      store: room.store,
    });
    const third = await enqueueDurableSource({
      sql,
      identity: room.identity,
      workspaceId: room.workspaceId,
      filename: "copy.md",
      bytes,
      idempotencyKey: randomUUID(),
      store: room.store,
    });
    expect(second.replayed).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(third.version?.id).toBe(first.version?.id);
    const version = await readSourceVersion(sql, room.identity, room.workspaceId, first.job.documentVersionId);
    expect(version.originalFilename).toBe("chapter.md");
    expect(version.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(version.version).toBe(1);
    await expect(
      withWorkspace(sql, room.identity, room.workspaceId, async ({ tx }) => {
        await tx`update source_document_versions set original_filename = 'changed.md' where id = ${version.id}::uuid`;
      }),
    ).rejects.toThrow(/immutable/);
    const claimed = await runExtractionOnce({
      sql,
      identity: room.identity,
      workspaceId: room.workspaceId,
      store: room.store,
      leaseOwner: "worker-main",
    });
    const durationMs = Math.round(performance.now() - started);
    const record = await readExtractionRecord(sql, room.identity, room.workspaceId, version.id);
    expect(claimed?.documentVersionId).toBe(version.id);
    expect(record.result).toMatchObject({
      extractorName: "adeena.source-extract",
      extractorVersion: "1",
      status: "complete",
    });
    expect(record.collection?.structureStatus).toBe("complete");
    expect(record.nodes.map((node) => node.role)).toEqual(["document", "chapter", "block"]);
    expect(record.spans.length).toBe(record.nodes.length);
    expect(record.costs[0]?.aiGenerationAuthorized).toBe(false);
    expect(record.costs[0]?.uploadedBytes).toBe(bytes.byteLength);
    const text = await room.store.readCanonical(room.workspaceId, version.contentHash);
    expect(text).toContain("Water moves downhill.");
    const orphan = await room.store.putOriginal(room.workspaceId, "ef".repeat(32), Buffer.from("orphan"));
    const retired = await reconcileOrphans(room.store, room.workspaceId, await referencedLocators(sql, room.identity, room.workspaceId));
    expect(retired).toContain(orphan.locator);
    console.info(JSON.stringify({ persistedBytes: bytes.byteLength, persistedDurationMs: durationMs, nodes: record.nodes.length }));
  });

  it("lets one worker claim a job, recovers an expired lease, and stops after the attempt limit", async () => {
    const room = await tenant();
    const bytes = Buffer.from("A durable note.");
    await enqueueDurableSource({
      sql,
      identity: room.identity,
      workspaceId: room.workspaceId,
      filename: "note.txt",
      bytes,
      idempotencyKey: randomUUID(),
      store: room.store,
    });
    const claims = await Promise.all([
      claimExtractionJob({ sql, identity: room.identity, workspaceId: room.workspaceId, leaseOwner: "worker-a" }),
      claimExtractionJob({ sql, identity: room.identity, workspaceId: room.workspaceId, leaseOwner: "worker-b" }),
    ]);
    const claimed = claims.find((job) => job !== null);
    expect(claims.filter((job) => job !== null)).toHaveLength(1);
    const claimedId = claimed?.id ?? "";
    await withWorkspace(sql, room.identity, room.workspaceId, async ({ tx }) => {
      await tx`update extraction_jobs set lease_expires_at = now() - interval '1 minute' where id = ${claimedId}::uuid`;
    });
    const restarted = openDatabase(applicationDatabaseUrl());
    try {
      const recovered = await runExtractionOnce({
        sql: restarted,
        identity: room.identity,
        workspaceId: room.workspaceId,
        store: room.store,
        leaseOwner: "worker-restart",
      });
      expect(recovered?.id).toBe(claimed?.id);
      const job = await readJob(restarted, room.identity, room.workspaceId, claimed?.id ?? "");
      expect(job?.status).toBe("complete");
      expect(job?.attemptCount).toBe(2);
    } finally {
      await restarted.end({ timeout: 1 });
    }

    const limited = await enqueueDurableSource({
      sql,
      identity: room.identity,
      workspaceId: room.workspaceId,
      filename: "retry.txt",
      bytes: Buffer.from("Retry once."),
      idempotencyKey: randomUUID(),
      store: room.store,
      maxAttempts: 1,
    });
    const once = await claimExtractionJob({
      sql,
      identity: room.identity,
      workspaceId: room.workspaceId,
      leaseOwner: "worker-limit",
    });
    expect(once?.id).toBe(limited.job.id);
    const onceId = once?.id ?? "";
    await withWorkspace(sql, room.identity, room.workspaceId, async ({ tx }) => {
      await tx`update extraction_jobs set lease_expires_at = now() - interval '1 minute' where id = ${onceId}::uuid`;
    });
    expect(await claimExtractionJob({ sql, identity: room.identity, workspaceId: room.workspaceId, leaseOwner: "worker-limit-2" })).toBeNull();
    const exhausted = await readJob(sql, room.identity, room.workspaceId, limited.job.id);
    expect(exhausted).toMatchObject({ status: "failed", permanent: true, attemptCount: 1 });
  });

  it("rolls back a workspace insert and rejects a broken foreign key", async () => {
    const userId = randomUUID();
    const workspaceId = randomUUID();
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('adeena.user_id', ${userId}, true)`;
        await tx`select adeena.create_workspace(${workspaceId}::uuid, 'Temporary', 'personal', ${userId}::uuid)`;
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const remaining = await sql.begin(async (tx) => {
      await tx`select set_config('adeena.user_id', ${userId}, true)`;
      return tx`select id from workspaces where id = ${workspaceId}::uuid`;
    });
    expect(remaining).toHaveLength(0);

    const room = await tenant();
    await expect(
      withWorkspace(sql, room.identity, room.workspaceId, async ({ tx, userId: actor }) => {
        await tx`insert into source_document_versions (
          id, document_id, workspace_id, version, original_filename, content_hash, media_type, size_bytes, storage_locator, rights_status, uploaded_by
        ) values (
          ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${room.workspaceId}::uuid, 1, 'lesson.txt', ${"a".repeat(64)},
          'text/plain', 4, ${`private://${room.workspaceId}/${"a".repeat(64)}/original.bin`}, 'unverified', ${actor}::uuid
        )`;
      }),
    ).rejects.toThrow();
  });

  it("provisions one personal workspace and ignores a client-supplied user", async () => {
    const userId = randomUUID();
    const session = sessionFromAuthUser({ id: userId });
    expect(session?.userId).toBe(userId);
    if (!session) throw new Error("verified subject missing");
    const first = await creatorWorkspaceResponse({
      session,
      sql,
      requestedWorkspaceId: null,
      suppliedUserId: randomUUID(),
    });
    const second = await creatorWorkspaceResponse({
      session,
      sql,
      requestedWorkspaceId: null,
      suppliedUserId: randomUUID(),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    if (first.status !== 200 || second.status !== 200) return;
    expect(first.body.userId).toBe(userId);
    expect(second.body.workspaceId).toBe(first.body.workspaceId);
    expect(second.body.created).toBe(false);
    expect(sessionFromAuthUser({ id: SYNTHETIC_WORKSPACE_ID })).toBeNull();
    expect(sessionFromAuthUser(null)).toBeNull();
    const forged = await creatorWorkspaceResponse({
      session: { userId, identity: {} as VerifiedIdentity },
      sql,
      requestedWorkspaceId: null,
      suppliedUserId: userId,
    });
    expect(forged).toMatchObject({ status: 401, body: { error: "unauthenticated" } });
    const anonymous = await creatorWorkspaceResponse({
      session: null,
      sql,
      requestedWorkspaceId: first.body.workspaceId,
      suppliedUserId: userId,
    });
    expect(anonymous).toMatchObject({ status: 401, body: { error: "unauthenticated" } });
  });

  it("denies another workspace and an inactive creator membership", async () => {
    const owner = sessionFromAuthUser({ id: randomUUID() });
    const other = sessionFromAuthUser({ id: randomUUID() });
    if (!owner || !other) throw new Error("verified subject missing");
    const created = await ensureIndividualWorkspace(sql, owner.identity);
    const denied = await creatorWorkspaceResponse({
      session: other,
      sql,
      requestedWorkspaceId: created.workspaceId,
      suppliedUserId: owner.userId,
    });
    expect(denied).toMatchObject({ status: 403, body: { error: "cross-workspace" } });
    await expect(openCreatorWorkspace(sql, other.identity, SYNTHETIC_WORKSPACE_ID)).rejects.toThrow(SourceError);
    await setMembershipStatus(sql, owner.identity, { workspaceId: created.workspaceId, userId: owner.userId, status: "inactive" });
    await expect(ensureIndividualWorkspace(sql, owner.identity)).rejects.toThrow(SourceError);
    const blocked = await creatorWorkspaceResponse({
      session: owner,
      sql,
      requestedWorkspaceId: null,
      suppliedUserId: null,
    });
    expect(blocked).toMatchObject({ status: 401, body: { error: "unauthenticated" } });
  });
});
