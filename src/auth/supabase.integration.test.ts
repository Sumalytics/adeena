import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { creatorTopicResponse } from "@/auth/topics";
import { creatorSourceResponse, creatorUploadResponse } from "@/auth/uploads";
import { sessionFromAuthUser } from "@/auth/subject";
import { bindVerifiedActor, createWorkspace, withWorkspace } from "@/db/authz";
import { applicationDatabaseUrl, databaseUrl } from "@/db/env";
import { identityFromVerifiedSubject } from "@/db/identity";
import { migrateDown, migrateUp } from "@/db/migrate";
import { enqueueDurableSource } from "@/db/source-repository";
import { correctTopicHeading, recommendFirstTopic } from "@/db/topic-repository";
import { openDisposableDatabases, workspaceIds } from "@/db/test-database";
import { runExtractionOnce } from "@/db/worker";
import { SourceError } from "@/source/errors";
import { createFilesystemObjectStore } from "@/storage/filesystem";

async function verifiedCreator(label: "A" | "B", expectedId: string) {
  const url = localSetting(".env.local", "NEXT_PUBLIC_SUPABASE_URL");
  const key = localSetting(".env.local", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  const accounts = "C:/dev/adeena-test-accounts.env";
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const signed = await timed(`sign-in-${label}`, () => supabase.auth.signInWithPassword({
    email: localSetting(accounts, `ADEENA_TEST_USER_${label}_EMAIL`),
    password: localSetting(accounts, `ADEENA_TEST_USER_${label}_PASSWORD`),
  }));
  const verified = await timed(`get-user-${label}`, () => supabase.auth.getUser());
  expect(signed.error).toBeNull();
  expect(verified.data.user?.id).toBe(expectedId);
  await supabase.auth.signOut();
  return verified.data.user?.id ?? "";
}

function localSetting(file: string, name: string) {
  const text = readFileSync(file, "utf8");
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

async function timed<T>(step: string, run: () => Promise<T>) {
  const started = performance.now();
  try {
    return await run();
  } finally {
    console.log(JSON.stringify({ step, ms: Math.round(performance.now() - started) }));
  }
}

describe("live supabase auth", () => {
  it("reads auth settings from Supabase", async () => {
    const url = localSetting(".env.local", "NEXT_PUBLIC_SUPABASE_URL");
    const key = localSetting(".env.local", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    const response = await timed("settings", () => fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } }));
    const settings = (await response.json()) as { disable_signup?: boolean; mailer_autoconfirm?: boolean };
    expect(response.status).toBe(200);
    expect(settings.disable_signup).toBe(false);
    expect(settings.mailer_autoconfirm).toBe(false);
  });

  it("rejects a forged token at Supabase", async () => {
    const url = localSetting(".env.local", "NEXT_PUBLIC_SUPABASE_URL");
    const key = localSetting(".env.local", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const forged = await timed("forged-user", () => supabase.auth.getUser("aaaa.bbbb.cccc"));
    expect(forged.data.user).toBeNull();
    expect(forged.error).toBeTruthy();
  });

  it("rejects an unknown password at Supabase", async () => {
    const url = localSetting(".env.local", "NEXT_PUBLIC_SUPABASE_URL");
    const key = localSetting(".env.local", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const invalid = await timed("invalid-credentials", () => supabase.auth.signInWithPassword({
      email: `missing-${randomUUID()}@gmail.com`,
      password: "wrong-password",
    }));
    expect(invalid.data.session).toBeNull();
    expect(invalid.error?.code).toBe("invalid_credentials");
  });

  it("does not create a confirmed session from signup", async () => {
    const url = localSetting(".env.local", "NEXT_PUBLIC_SUPABASE_URL");
    const key = localSetting(".env.local", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const signUp = await timed("signup", () => supabase.auth.signUp({
      email: `eng007-${randomUUID()}@gmail.com`,
      password: `Adeena-${randomUUID()}`,
    }));
    if (signUp.error?.code === "over_email_send_rate_limit") {
      expect(signUp.data.user).toBeNull();
      return;
    }
    expect(signUp.error?.code ?? "ok").toBe("ok");
    expect(signUp.data.session).toBeNull();
    expect(signUp.data.user?.id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("live creator tenant isolation", () => {
  const expected = {
    A: "58ac8d72-2067-42a8-808b-207b3251508f",
    B: "e833bee5-016d-419e-8a50-472e08763335",
  };
  const ids = { A: "", B: "" };
  let developerWorkspaces: string[] | null = null;

  beforeAll(async () => {
    developerWorkspaces = await workspaceIds(databaseUrl());
  });

  it("signs in creator A through Supabase and reads that user back", async () => {
    ids.A = await verifiedCreator("A", expected.A);
  });

  it("signs in creator B through Supabase and reads that user back", async () => {
    ids.B = await verifiedCreator("B", expected.B);
  });

  afterAll(async () => {
    expect(await workspaceIds(databaseUrl())).toEqual(developerWorkspaces);
  });

  it("denies foreign topic reads, writes, and corrections in both directions", async () => {
    const disposable = await openDisposableDatabases(databaseUrl(), applicationDatabaseUrl());
    const roots: string[] = [];
    try {
      await migrateDown(disposable.admin);
      await migrateUp(disposable.admin);
      const lesson = "Learners compare two careful choices and explain the result using only this passage. ".repeat(6);
      async function room(label: "A" | "B", title: string) {
        const identity = identityFromVerifiedSubject(ids[label]);
        const workspaceId = randomUUID();
        await createWorkspace(disposable.app, identity, { id: workspaceId, name: `Creator ${label}`, workspaceType: "personal" });
        const root = await mkdtemp(path.join(tmpdir(), "adeena-live-"));
        roots.push(root);
        const store = createFilesystemObjectStore(root);
        const enqueued = await enqueueDurableSource({
          sql: disposable.app,
          identity,
          workspaceId,
          filename: `${title}.md`,
          bytes: Buffer.from(`# ${title}\n\n## ${title} detail\n\n${lesson}`),
          idempotencyKey: randomUUID(),
          store,
        });
        const versionId = enqueued.version?.id ?? enqueued.job.documentVersionId;
        await runExtractionOnce({ sql: disposable.app, identity, workspaceId, store, leaseOwner: `live-${label.toLowerCase()}` });
        const recommendation = await recommendFirstTopic({
          sql: disposable.app,
          identity,
          workspaceId,
          documentVersionId: versionId,
          audienceLabel: "Primary learners",
          ageBand: "8-10",
          idempotencyKey: randomUUID(),
        });
        return { identity, workspaceId, versionId, recommendation };
      }
      const left = await room("A", "Alpha");
      const right = await room("B", "Beta");
      expect(left.recommendation.recommendation?.generatesExperience).toBe(false);
      expect(left.recommendation.recommendation?.aiGenerationAuthorized).toBe(false);
      await expect(recommendFirstTopic({
        sql: disposable.app,
        identity: left.identity,
        workspaceId: left.workspaceId,
        documentVersionId: right.versionId,
        audienceLabel: "Primary learners",
        ageBand: "8-10",
        idempotencyKey: randomUUID(),
      })).rejects.toThrow(SourceError);
      await expect(recommendFirstTopic({
        sql: disposable.app,
        identity: right.identity,
        workspaceId: right.workspaceId,
        documentVersionId: left.versionId,
        audienceLabel: "Primary learners",
        ageBand: "8-10",
        idempotencyKey: randomUUID(),
      })).rejects.toThrow(SourceError);
      const leftNode = left.recommendation.candidates[0]?.primaryNodeId ?? randomUUID();
      const rightNode = right.recommendation.candidates[0]?.primaryNodeId ?? randomUUID();
      await expect(correctTopicHeading({
        sql: disposable.app,
        identity: left.identity,
        workspaceId: left.workspaceId,
        documentVersionId: right.versionId,
        nodeId: rightNode,
        correctedTitle: "Blocked beta",
      })).rejects.toThrow(SourceError);
      await expect(correctTopicHeading({
        sql: disposable.app,
        identity: right.identity,
        workspaceId: right.workspaceId,
        documentVersionId: left.versionId,
        nodeId: leftNode,
        correctedTitle: "Blocked alpha",
      })).rejects.toThrow(SourceError);
      const sample = await disposable.admin<{
        collection_id: string;
        extraction_id: string;
        primary_node_id: string;
        source_span_ids: string[];
      }[]>`
        select collection_id::text as collection_id, extraction_id::text as extraction_id,
          primary_node_id::text as primary_node_id, source_span_ids
        from topic_candidates
        where workspace_id = ${right.workspaceId}::uuid
        limit 1
      `;
      const row = sample[0];
      expect(row?.collection_id).toBeTruthy();
      if (!row) throw new Error("candidate missing");
      await expect(withWorkspace(disposable.app, left.identity, left.workspaceId, async ({ tx }) => {
        await tx`insert into topic_candidates (
          id, workspace_id, collection_id, document_version_id, extraction_id, detection_version,
          override_version, title, source_order, detection_method, uncertainty, eligibility, reasons,
          support_chars, primary_node_id, node_ids, source_span_ids
        ) values (
          ${randomUUID()}::uuid, ${right.workspaceId}::uuid, ${row.collection_id}::uuid, ${right.versionId}::uuid,
          ${row.extraction_id}::uuid, '1', 0, 'Hidden', 9000, 'explicit-heading', 'stated', 'eligible', '[]'::jsonb,
          20, ${row.primary_node_id}::uuid, ${JSON.stringify([row.primary_node_id])}::jsonb,
          ${JSON.stringify(row.source_span_ids)}::jsonb
        )`;
      })).rejects.toMatchObject({ code: "42501" });
      const reserved = await disposable.app.reserve();
      try {
        await reserved`select set_config('adeena.user_id', ${ids.B}, false)`;
        await reserved`begin`;
        await bindVerifiedActor(reserved, ids.A);
        const during = await reserved<{ user_id: string }[]>`select current_setting('adeena.user_id', true) as user_id`;
        expect(during[0]?.user_id).toBe(ids.A);
        await reserved`commit`;
        const cleared = await reserved<{ user_id: string }[]>`select current_setting('adeena.user_id', true) as user_id`;
        expect(cleared[0]?.user_id ?? "").toBe("");
        await reserved`select set_config('adeena.user_id', ${ids.B}, false)`;
        const visibleToPlantedRole = await reserved<{ id: string }[]>`
          select id::text as id from recommendation_runs where workspace_id = ${right.workspaceId}::uuid
        `;
        const hiddenFromPlantedRole = await reserved<{ id: string }[]>`
          select id::text as id from recommendation_runs where workspace_id = ${left.workspaceId}::uuid
        `;
        expect(visibleToPlantedRole.length).toBeGreaterThan(0);
        expect(hiddenFromPlantedRole).toHaveLength(0);
        await reserved`select set_config('adeena.user_id', '', false)`;
      } finally {
        await reserved`rollback`.catch(() => undefined);
        reserved.release();
      }
      const updated = await withWorkspace(disposable.app, right.identity, right.workspaceId, async ({ tx }) => {
        return tx<{ id: string }[]>`
          update recommendation_runs set reason = 'changed'
          where id = ${left.recommendation.recommendation?.id ?? randomUUID()}::uuid
          returning id
        `;
      });
      expect(updated).toHaveLength(0);
      const session = sessionFromAuthUser({ id: ids.A });
      const rejected = await creatorTopicResponse({
        session,
        sql: disposable.app,
        method: "POST",
        search: new URLSearchParams({ userId: ids.B, workspaceId: right.workspaceId }),
        body: {
          documentVersionId: left.versionId,
          audienceLabel: "Primary learners",
          ageBand: "8-10",
          idempotencyKey: randomUUID(),
          userId: ids.B,
          workspaceId: right.workspaceId,
        },
      });
      expect(rejected).toMatchObject({ status: 400, body: { error: "invalid-topic" } });
    } finally {
      await disposable.admin.end({ timeout: 1 });
      await disposable.app.end({ timeout: 1 });
    }
  });

  it("stores creator A's upload privately and denies creator B", async () => {
    const disposable = await openDisposableDatabases(databaseUrl(), applicationDatabaseUrl());
    const root = await mkdtemp(path.join(tmpdir(), "adeena-live-upload-"));
    const store = createFilesystemObjectStore(root);
    try {
      await migrateDown(disposable.admin);
      await migrateUp(disposable.admin);
      const owner = sessionFromAuthUser({ id: ids.A });
      const other = sessionFromAuthUser({ id: ids.B });
      if (!owner || !other) throw new Error("verified subject missing");
      const lesson = "Learners compare two careful choices and explain the result using only this passage. ".repeat(6);
      const bytes = Buffer.from(`# Alpha\n\n## Currents\n\n${lesson}`);
      const form = new FormData();
      form.set("source", new File([bytes as unknown as BlobPart], "alpha.md"));
      form.set("rightsDeclaration", "permission-asserted");
      form.set("idempotencyKey", randomUUID());
      const uploaded = await creatorUploadResponse({
        session: owner,
        sql: disposable.app,
        store,
        request: new Request("http://127.0.0.1/api/creator/sources", { method: "POST", body: form }),
      });
      expect(uploaded.status).toBe(201);
      if (uploaded.status !== 201) return;
      expect(uploaded.body.extractionStatus).toBe("complete");
      expect(uploaded.body.rightsStatus).toBe("unverified");
      expect(uploaded.body.aiGenerationAuthorized).toBe(false);
      expect(uploaded.body.generatesExperience).toBe(false);
      expect(JSON.stringify(uploaded.body)).not.toContain("private://");
      const denied = await creatorSourceResponse({
        session: other,
        sql: disposable.app,
        documentVersionId: uploaded.body.documentVersionId,
      });
      expect(denied).toMatchObject({ status: 403, body: { error: "cross-workspace" } });
      const rows = await disposable.admin<{ workspace_id: string; locator: string; rights_status: string }[]>`
        select workspace_id::text as workspace_id, storage_locator as locator, rights_status
        from source_document_versions
        where id = ${uploaded.body.documentVersionId}::uuid
      `;
      const stored = rows[0];
      expect(stored?.rights_status).toBe("unverified");
      expect(stored?.locator.startsWith("private://")).toBe(true);
      expect(stored?.locator.includes("https://")).toBe(false);
      const hash = createHash("sha256").update(bytes).digest("hex");
      expect(await store.verifyOriginal(stored?.workspace_id ?? "", hash)).toBe(true);
      const foreign = await disposable.admin<{ workspace_id: string }[]>`
        select workspace_id::text as workspace_id from workspace_memberships where user_id = ${ids.B}::uuid
      `;
      expect(await store.listLocators(foreign[0]?.workspace_id ?? ids.B)).toEqual([]);
      await expect(store.readOriginal(foreign[0]?.workspace_id ?? ids.B, hash)).rejects.toThrow(SourceError);
      const recommendation = await recommendFirstTopic({
        sql: disposable.app,
        identity: owner.identity,
        workspaceId: stored?.workspace_id ?? "",
        documentVersionId: uploaded.body.documentVersionId,
        audienceLabel: "Primary learners",
        ageBand: "8-10",
        idempotencyKey: randomUUID(),
      });
      expect(recommendation.recommendation?.generatesExperience).toBe(false);
      expect(recommendation.recommendation?.aiGenerationAuthorized).toBe(false);
      const corrected = await correctTopicHeading({
        sql: disposable.app,
        identity: owner.identity,
        workspaceId: stored?.workspace_id ?? "",
        documentVersionId: uploaded.body.documentVersionId,
        nodeId: recommendation.candidates[0]?.primaryNodeId ?? randomUUID(),
        correctedTitle: "Alpha currents",
      });
      expect(corrected.generatesExperience).toBe(false);
      expect(Buffer.from(await store.readOriginal(stored?.workspace_id ?? "", hash)).equals(bytes)).toBe(true);
    } finally {
      await disposable.admin.end({ timeout: 1 });
      await disposable.app.end({ timeout: 1 });
    }
  });
});
