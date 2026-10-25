import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { createFilesystemObjectStore } from "@/storage/filesystem";
import { openDatabase, type DatabaseClient } from "./client";
import { databaseUrl, applicationDatabaseUrl } from "./env";
import { urlForDatabase } from "./test-database";
import { migrateUp } from "./migrate";
import { createWorkspace } from "./authz";
import { issueIdentityForIsolatedTests } from "./identity";
import { enqueueDurableSource } from "./source-repository";
import { runExtractionOnce } from "./worker";
import { recommendFirstTopic } from "./topic-repository";
import { readVisualExperience } from "./visual-experience-repository";
import { createCreatorWorkflow, selectWorkflowAudience, selectWorkflowSource, selectWorkflowTopic } from "./workflow-repository";
import { creatorWorkflowGenerateResponse, creatorWorkflowGenerationReadResponse } from "@/auth/workflows";
import { sessionFromAuthUser } from "@/auth/subject";

const env = { ADEENA_EXPERIENCE_PROVIDER: "configured-provider", ADEENA_AI_EXECUTION_MODE: "free-development", ADEENA_RUNTIME: "nonproduction-test", ADEENA_GROQ_PLAN: "free", ADEENA_AI_MODEL: "openai/gpt-oss-120b", ADEENA_AI_API_URL: "https://api.groq.com/openai/v1/responses", ADEENA_GROQ_API_KEY: "test-key" };

function child(command: string, args: string[], childEnv: NodeJS.ProcessEnv) {
  const process = spawn(command, args, { cwd: path.resolve("."), env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  process.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  process.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
  return { process, done };
}

async function waitForProviderStart(admin: DatabaseClient, jobId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await admin<{ started: boolean }[]>`select provider_started_at is not null as started from visual_generation_jobs where id=${jobId}::uuid`;
    if (row?.started) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Worker did not record provider start");
}

async function waitForCall(log: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await readFile(log, "utf8")).trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Fake provider was not invoked");
}

describe("durable visual AI generation", () => {
  const database = `adeena_visual_test_${randomUUID().replaceAll("-", "")}`;
  const workerPassword = randomUUID().replaceAll("-", "");
  let maintenance: DatabaseClient, admin: DatabaseClient, sql: DatabaseClient, workerSql: DatabaseClient;
  let workerUrl: string;
  let root: string;
  beforeAll(async () => {
    await build({ configFile: path.resolve("vite.visual-worker.config.mts"), logLevel: "silent" });
    maintenance = openDatabase(urlForDatabase(databaseUrl(), "postgres"));
    await maintenance.unsafe(`CREATE DATABASE ${database}`);
    admin = openDatabase(urlForDatabase(databaseUrl(), database));
    sql = openDatabase(urlForDatabase(applicationDatabaseUrl(), database));
    await migrateUp(admin);
    await admin.unsafe(`ALTER ROLE adeena_visual_worker LOGIN PASSWORD '${workerPassword}'`);
    const parsedWorkerUrl = new URL(urlForDatabase(databaseUrl(), database));
    parsedWorkerUrl.username = "adeena_visual_worker";
    parsedWorkerUrl.password = workerPassword;
    workerUrl = parsedWorkerUrl.toString();
    workerSql = openDatabase(workerUrl);
    const [roles] = await admin<{ app_role: string; worker_role: string; superuser: boolean; bypass_rls: boolean; create_db: boolean; create_role: boolean; inherits: boolean }[]>`
      select 'adeena_app' as app_role,r.rolname as worker_role,r.rolsuper as superuser,r.rolbypassrls as bypass_rls,r.rolcreatedb as create_db,r.rolcreaterole as create_role,r.rolinherit as inherits
      from pg_roles r where r.rolname='adeena_visual_worker'`;
    expect(roles).toEqual({ app_role: "adeena_app", worker_role: "adeena_visual_worker", superuser: false, bypass_rls: false, create_db: false, create_role: false, inherits: false });
    expect((await workerSql`select current_user as role`)[0]).toEqual({ role: "adeena_visual_worker" });
    root = await mkdtemp(path.join(tmpdir(), "adeena-visual-model-"));
  });
  afterAll(async () => {
    await workerSql?.end({ timeout: 1 });
    if (admin) await admin`ALTER ROLE adeena_visual_worker NOLOGIN`;
    await sql?.end({ timeout: 1 }); await admin?.end({ timeout: 1 });
    await maintenance.unsafe(`DROP DATABASE ${database}`); await maintenance.end();
    if (root) await rm(root, { recursive: true, force: true });
  }, 20_000);

  it("uses the authorized source version, reserves separate calls, associates once, and replays without billing", async () => {
    const identity = issueIdentityForIsolatedTests(randomUUID());
    const workspaceId = randomUUID();
    await createWorkspace(sql, identity, { id: workspaceId, name: "Visual model test", workspaceType: "personal" });
    const actor = { sql, identity, workspaceId };
    const store = createFilesystemObjectStore(root);
    const sourceText = "Fresh coffee cherries are picked first. The cherries are sorted second. The beans are pulped, fermented, washed, dried, milled, roasted, and packed in that order. Each stage prepares the coffee for the next stage in the stated sequence.";
    const uploaded = await enqueueDurableSource({ ...actor, filename: "coffee.md", bytes: Buffer.from(`# Coffee preparation\n\n## Ordered stages\n\n${sourceText} ${sourceText}`), store, idempotencyKey: randomUUID() });
    await runExtractionOnce({ ...actor, store, leaseOwner: "visual-model-test" });
    const recommended = await recommendFirstTopic({ ...actor, documentVersionId: uploaded.version.id, audienceLabel: "Junior secondary learners", ageBand: "11-13", idempotencyKey: randomUUID() });
    const topicCandidateId = recommended.recommendation?.topicCandidateId;
    if (!topicCandidateId) throw new Error("Visual topic was not selected");
    let workflow = await createCreatorWorkflow({ ...actor, idempotencyKey: randomUUID() });
    workflow = await selectWorkflowSource({ ...actor, workflowId: workflow.id, expectedVersion: workflow.version, documentVersionId: uploaded.version.id });
    workflow = await selectWorkflowAudience({ ...actor, workflowId: workflow.id, expectedVersion: workflow.version, audienceLabel: "Junior secondary learners", ageBand: "11-13" });
    workflow = await selectWorkflowTopic({ ...actor, workflowId: workflow.id, expectedVersion: workflow.version, topicCandidateId });
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      const context = JSON.parse(body.input);
      let content: unknown;
      if (body.text.format.name === "experience_plan") {
        const [first, second] = context.allowedFacts;
        const choice = (id: string, text: string, nextSceneId: string, understanding: number) => ({ id, text, nextSceneId, understanding });
        content = {
          learnerObjective: "Apply the two source-supported preparation steps.",
          setting: { kind: "fictional", label: "A fictional coffee workshop" },
          facts: [first, second].map((fact: { claim: string; spanId: string }) => ({ kind: "source", claim: fact.claim, spanId: fact.spanId })),
          fictionalElements: ["coffee workshop"], gameplayObjective: "Choose two actions using the source sequence.",
          progression: [
            { id: "start", role: "dialogue", title: "Coffee workshop", text: `This is a fictional scenario. ${first.claim} ${second.claim}`, choices: [choice("use-first", "Begin with the first source stage", "follow-first", 1), choice("use-second", "Begin with the second source stage", "follow-second", 0)] },
            { id: "follow-first", role: "dialogue", title: "Next stage", text: `${second.claim} Choose the next source stage.`, choices: [choice("continue-order", "Continue in source order", "end-ordered", 2), choice("reverse-order", "Reverse the two source stages", "end-reversed", 0)] },
            { id: "follow-second", role: "dialogue", title: "Next stage", text: `${second.claim} Choose the next source stage.`, choices: [choice("return-first", "Return to the first source stage", "end-returned", 1), choice("stay-second", "Stay with the second source stage", "end-skipped", 0)] },
            { id: "end-ordered", role: "ending", title: "Source order", text: "You chose the first stage and then continued in source order." },
            { id: "end-reversed", role: "ending", title: "Reversed", text: "You chose the first stage and then reversed the two stages." },
            { id: "end-returned", role: "ending", title: "Returned", text: "You chose the second stage and then returned to the first." },
            { id: "end-skipped", role: "ending", title: "Skipped", text: "You chose the second stage and stayed there." },
          ],
        };
      } else if (body.text.format.name === "experience_review") {
        content = { grounded: true, coherent: true, consequential: true, audienceSuitable: true, issues: [] };
      } else if (body.text.format.name === "experience_visualPlan") {
        const span = context.excerpts[0];
        const quote = String(span.excerpt).match(/[^.!?]+[.!?]/)?.[0].trim() ?? String(span.excerpt).slice(0, 80);
        const bind = (elementId: string) => ({ elementId, outcomeIds: ["ordered-stages"] });
        const sceneId = context.manifest.scenes[0].id;
        content = {
          result: "supported",
          plan: {
            contract: "ADEENA-INSTRUCTIONAL-PLAN-v1", learnerObjective: context.learningObjective, visualTreatment: "process-pathway@1",
            learningOutcomes: [{ id: "ordered-stages", statement: quote, evidence: { spanId: span.id, quote } }],
            scenes: [{ blueprintSceneId: sceneId, concept: "The ordered preparation stages", representationRationale: "A connected pathway shows the explicit source order.", learnerSees: "Two connected stages from the source sequence.", movementPurpose: "The path highlights the movement from the first stage to the next.", narrationPurpose: "Narration states the source sequence while the path is highlighted.", practicePurpose: "The learner restores the source-supported order.", outcomeIds: ["ordered-stages"], objectEvidence: [bind("first-stage"), bind("second-stage"), bind("stage-path")], cueEvidence: [bind("show-path")], narrationEvidence: [bind("stage-narration")], interactionEvidence: bind("order-stages") }],
          },
          blueprint: {
            contract: "ADEENA-VISUAL-LEARNING-v1", locale: context.locale, ageBand: context.ageBand, styleId: "friendly-illustrated-2d-v1", voice: { locale: context.locale, voiceProfileId: "educator-neutral-1", style: "calm", rate: 1 },
            scenes: [{ id: sceneId, phase: "practice", archetype: "process-pathway@1", durationMs: 7000, sourceSpanIds: [span.id], visualObjects: [
              { id: "first-stage", kind: "node", nodeType: "step", label: "First stage", role: "answer-target", geometry: { x: 100, y: 300, width: 180, height: 120 } },
              { id: "second-stage", kind: "node", nodeType: "step", label: "Second stage", role: "answer-target", geometry: { x: 650, y: 300, width: 180, height: 120 } },
              { id: "stage-path", kind: "edge", fromId: "first-stage", toId: "second-stage", directed: true, label: "Then", role: "path", geometry: { x: 300, y: 340, width: 320, height: 30 } },
            ], cues: [{ id: "show-path", targetId: "stage-path", trigger: { kind: "narration-segment", segmentId: "stage-narration", offsetMs: 0 }, action: { kind: "highlight" }, durationMs: 500 }], narration: [{ id: "stage-narration", text: quote, caption: quote, startMs: 0, durationMs: 5000, cueIds: ["show-path"], sourceSpanIds: [span.id] }], interaction: { id: "order-stages", kind: "sequence-steps", prompt: "Place the stages in the order taught.", itemIds: ["first-stage", "second-stage"], correctOrder: ["first-stage", "second-stage"], feedback: { correct: "That order matches the source.", incorrect: "Use the order stated in the source." }, sourceSpanIds: [span.id] } }],
          },
          mapping: { contract: "ADEENA-VISUAL-SCENE-MAPPING-v1", legacyExperienceId: context.manifest.experienceId, scenes: [{ visualSceneId: sceneId, legacySceneId: sceneId }], choices: [] },
        };
      } else content = { sourceGrounded: true, relationshipsCorrect: true, animationMatchesNarration: true, practiceSupported: true, audienceSuitable: true, capabilitySupported: true, highRiskUncertainty: false, issues: [] };
      return Response.json({ id: `visual_resp_${calls}`, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(content) }] }], usage: { input_tokens: 900, output_tokens: 700, output_tokens_details: { reasoning_tokens: 5 } } });
    };
    const session = sessionFromAuthUser({ id: identity.userId });
    const first = await creatorWorkflowGenerateResponse({ session, sql, workflowId: workflow.id, body: { expectedVersion: workflow.version, authorizeGeneration: true }, provider: "configured-provider", env, fetchImpl });
    expect(first).toMatchObject({ status: 202, body: { generation: { status: "compiling", visualStatus: "queued", stageLabel: "Preparing animated explanation" } } });
    expect("background" in first).toBe(false);
    const concurrent = await creatorWorkflowGenerateResponse({ session, sql, workflowId: workflow.id, body: { expectedVersion: workflow.version, authorizeGeneration: true }, provider: "configured-provider", env, fetchImpl });
    expect(concurrent).toMatchObject({ status: 202, body: { generation: { visualStatus: "queued" } } });
    expect("background" in concurrent && concurrent.background).toBeFalsy();
    await expect(sql`select * from adeena.claim_visual_generation_job('app-process'::text,60::integer,null::uuid)`).rejects.toThrow(/permission denied/i);
    await expect(sql`select adeena.activate_visual_generation_claim(${randomUUID()}::uuid,'app-process'::text,${randomUUID()}::uuid)`).rejects.toThrow(/permission denied/i);
    const callLog = path.join(root, "provider-calls.log");
    const workerFile = path.resolve(".local/visual-worker/visual-generation-worker.mjs");
    const workerEnv = {
      ...process.env,
      ...env,
      ADEENA_APP_DATABASE_URL: urlForDatabase(applicationDatabaseUrl(), database),
      ADEENA_VISUAL_WORKER_DATABASE_URL: workerUrl,
      ADEENA_VISUAL_WORKER_FAKE_CALL_LOG: callLog,
      NODE_OPTIONS: `--import=${pathToFileURL(path.resolve("scripts/testing/visual-worker-provider.mjs")).href}`,
    };
    const rejectedConfig = await child(process.execPath, [workerFile, "--once"], { ...workerEnv, ADEENA_VISUAL_WORKER_DATABASE_URL: workerEnv.ADEENA_APP_DATABASE_URL }).done;
    expect(rejectedConfig.code).not.toBe(0);
    expect(rejectedConfig.stderr).toMatch(/must authenticate as adeena_visual_worker/i);
    await writeFile(callLog, "");
    const workers = [child(process.execPath, [workerFile, "--once"], workerEnv), child(process.execPath, [workerFile, "--once"], workerEnv)];
    const workerResults = await Promise.all(workers.map((worker) => worker.done));
    expect(workerResults.map((result) => result.code)).toEqual([0, 0]);
    const workerEvents = workerResults.flatMap((result) => result.stdout.split("\n").flatMap((line) => line.startsWith("{") ? [JSON.parse(line) as Record<string, unknown>] : []));
    expect(workerEvents.find((event) => event.event === "visual-worker-started")).toMatchObject({ startupMs: expect.any(Number) });
    expect(workerEvents.find((event) => event.event === "visual-job-finished"), JSON.stringify(workerEvents)).toMatchObject({ attemptCount: 1, queueDelayMs: expect.any(Number), completionMs: expect.any(Number), status: "ready" });
    const initialCalls = (await readFile(callLog, "utf8")).trim().split("\n");
    expect(initialCalls).toEqual(["experience_visualPlan", "experience_visualReview"]);
    const completed = await creatorWorkflowGenerationReadResponse({ session, sql, workflowId: workflow.id });
    expect(completed).toMatchObject({ status: 200, body: { generation: { status: "ready", visualStatus: "ready", legacyOnly: false }, workflow: { experienceVersionId: expect.any(String) } } });
    if (!("generation" in completed.body) || !("workflow" in completed.body) || !completed.body.workflow) throw new Error("Generation did not complete");
    const versionId = completed.body.generation?.experienceVersionId;
    if (!versionId) throw new Error("No experience version was completed");
    const replay = await creatorWorkflowGenerateResponse({ session, sql, workflowId: workflow.id, body: { expectedVersion: completed.body.workflow.version, authorizeGeneration: true }, provider: "configured-provider", env, fetchImpl });
    expect(replay).toMatchObject({ status: 200, body: { generation: { status: "ready", visualStatus: "ready" } } });
    expect(calls).toBe(2);
    const visual = await readVisualExperience({ ...actor, experienceVersionId: versionId });
    expect(visual).toMatchObject({ status: "ready", association: { authoredFixture: false, fixtureLabel: null } });
    const [cost] = await admin`select call_count,input_tokens,output_tokens,actual_cost_micros,commercial_estimate_micros from visual_generation_costs`;
    expect(cost).toMatchObject({ call_count: 2, input_tokens: 1800, output_tokens: 1400, actual_cost_micros: 0 });
    expect(cost.commercial_estimate_micros).toBeGreaterThan(0);
    expect(await admin`select id from visual_generation_jobs`).toHaveLength(1);

    const createQueuedVisual = async () => {
      await admin`update adeena_free_quota set session_id=${randomUUID()}::uuid,session_requests=0,day_requests=0,usage_day=(now() at time zone 'utc')::date,updated_at=now() where id='development'`;
      let next = await createCreatorWorkflow({ ...actor, idempotencyKey: randomUUID() });
      next = await selectWorkflowSource({ ...actor, workflowId: next.id, expectedVersion: next.version, documentVersionId: uploaded.version.id });
      next = await selectWorkflowAudience({ ...actor, workflowId: next.id, expectedVersion: next.version, audienceLabel: "Junior secondary learners", ageBand: "11-13" });
      next = await selectWorkflowTopic({ ...actor, workflowId: next.id, expectedVersion: next.version, topicCandidateId });
      const queued = await creatorWorkflowGenerateResponse({ session, sql, workflowId: next.id, body: { expectedVersion: next.version, authorizeGeneration: true }, provider: "configured-provider", env, fetchImpl });
      if (!("generation" in queued.body) || !queued.body.generation?.experienceVersionId) throw new Error("A visual job was not enqueued");
      const [job] = await admin<{ id: string }[]>`select id::text from visual_generation_jobs where experience_version_id=${queued.body.generation.experienceVersionId}::uuid`;
      if (!job) throw new Error("The queued visual job was not persisted");
      return { jobId: job.id, versionId: queued.body.generation.experienceVersionId };
    };

    await createQueuedVisual();
    const probe = child(process.execPath, [path.resolve("scripts/testing/claim-visual-job.mjs")], { ...process.env, ADEENA_VISUAL_WORKER_DATABASE_URL: workerUrl });
    const probeResult = await probe.done;
    expect(probeResult.code).toBe(0);
    const claimed = JSON.parse(probeResult.stdout.trim()) as { job_id: string; workspace_id: string; lease_token: string };
    const otherIdentity = issueIdentityForIsolatedTests(randomUUID());
    const otherWorkspaceId = randomUUID();
    await createWorkspace(sql, otherIdentity, { id: otherWorkspaceId, name: "Other visual tenant", workspaceType: "personal" });
    const otherUploaded = await enqueueDurableSource({ sql, identity: otherIdentity, workspaceId: otherWorkspaceId, filename: "private-other.md", bytes: Buffer.from("# Other tenant\n\nThis private source belongs to another workspace and must remain isolated."), store, idempotencyKey: randomUUID() });
    await workerSql.begin(async (transaction) => {
      const tx = transaction as unknown as DatabaseClient;
      await tx`select adeena.activate_visual_generation_claim(${claimed.job_id}::uuid,'restart-probe'::text,${claimed.lease_token}::uuid)`;
      const visible = await tx<{ id: string }[]>`select id::text from source_document_versions order by id`;
      expect(visible.map((row) => row.id)).toContain(uploaded.version.id);
      expect(visible.map((row) => row.id)).not.toContain(otherUploaded.version.id);
    });
    await expect(workerSql.begin(async (transaction) => {
      const tx = transaction as unknown as DatabaseClient;
      await tx`select adeena.activate_visual_generation_claim(${claimed.job_id}::uuid,'restart-probe'::text,${claimed.lease_token}::uuid)`;
      await tx`select id from workspaces`;
    })).rejects.toThrow(/permission denied/i);
    await sql.begin(async (transaction) => {
      const tx = transaction as unknown as DatabaseClient;
      await tx`select set_config('adeena.visual_worker_job_id',${claimed.job_id},true),set_config('adeena.visual_worker_owner','restart-probe',true),set_config('adeena.visual_worker_token',${claimed.lease_token},true)`;
      const leaked = await tx`select id from source_document_versions where workspace_id=${otherWorkspaceId}::uuid`;
      expect(leaked).toHaveLength(0);
    });
    await expect(workerSql`select adeena.activate_visual_generation_claim(${randomUUID()}::uuid,'restart-probe'::text,${claimed.lease_token}::uuid)`).rejects.toThrow(/invalid or expired visual worker claim/);
    await expect(workerSql.begin(async (transaction) => {
      const tx = transaction as unknown as DatabaseClient;
      await tx`select adeena.activate_visual_generation_claim(${claimed.job_id}::uuid,'restart-probe'::text,${claimed.lease_token}::uuid)`;
      await tx`update experience_releases set revoked_at=now(),revoked_by=${identity.userId}::uuid`;
    })).rejects.toThrow(/permission denied/i);
    await expect(workerSql.begin(async (transaction) => {
      const tx = transaction as unknown as DatabaseClient;
      await tx`select adeena.activate_visual_generation_claim(${claimed.job_id}::uuid,'restart-probe'::text,${claimed.lease_token}::uuid)`;
      await tx`insert into experience_releases(id) values(${randomUUID()}::uuid)`;
    })).rejects.toThrow(/permission denied/i);
    await expect(workerSql.begin(async (transaction) => {
      const tx = transaction as unknown as DatabaseClient;
      await tx`select adeena.activate_visual_generation_claim(${claimed.job_id}::uuid,'restart-probe'::text,${claimed.lease_token}::uuid)`;
      await tx`update source_document_versions set rights_status='cleared' where id=${uploaded.version.id}::uuid`;
    })).rejects.toThrow(/permission denied/i);
    await admin`update visual_generation_jobs set lease_expires_at=now()-interval '1 second' where id=${claimed.job_id}::uuid`;
    await expect(workerSql`select adeena.activate_visual_generation_claim(${claimed.job_id}::uuid,'restart-probe'::text,${claimed.lease_token}::uuid)`).rejects.toThrow(/invalid or expired visual worker claim/);
    await writeFile(callLog, "");
    const recovered = await child(process.execPath, [workerFile, "--once"], workerEnv).done;
    expect(recovered.code).toBe(0);
    expect((await readFile(callLog, "utf8")).trim().split("\n")).toEqual(["experience_visualPlan", "experience_visualReview"]);
    const [recoveredJob] = await admin`select status,attempt_count from visual_generation_jobs where id=${claimed.job_id}::uuid`;
    expect(recoveredJob).toMatchObject({ status: "ready", attempt_count: 2 });

    const interruptedJob = await createQueuedVisual();
    await writeFile(callLog, "");
    const slow = child(process.execPath, [workerFile, "--once"], { ...workerEnv, ADEENA_VISUAL_WORKER_FAKE_DELAY_MS: "60000" });
    await waitForProviderStart(admin, interruptedJob.jobId);
    await waitForCall(callLog);
    slow.process.kill("SIGKILL");
    await slow.done;
    await admin`update visual_generation_jobs set lease_expires_at=now()-interval '1 second' where id=${interruptedJob.jobId}::uuid`;
    const afterInterruption = await child(process.execPath, [workerFile, "--once"], workerEnv).done;
    expect(afterInterruption.code).toBe(0);
    const [uncertainJob] = await admin`select status,failure_code,uncertain_charge,provider_stage from visual_generation_jobs where id=${interruptedJob.jobId}::uuid`;
    expect(uncertainJob).toMatchObject({ status: "failed", failure_code: "provider-outcome-unknown", uncertain_charge: true, provider_stage: "visualPlan" });
    const [uncertainCost] = await admin`select actual_cost_micros,usage_kind,call_count from visual_generation_costs where job_id=${interruptedJob.jobId}::uuid`;
    expect(uncertainCost).toMatchObject({ actual_cost_micros: null, usage_kind: "estimate", call_count: 0 });
    expect((await readFile(callLog, "utf8")).trim().split("\n")).toEqual(["experience_visualPlan"]);

    const exhausted = await createQueuedVisual();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claimedWithoutProvider = await child(process.execPath, [path.resolve("scripts/testing/claim-visual-job.mjs")], { ...process.env, ADEENA_VISUAL_WORKER_DATABASE_URL: workerUrl }).done;
      expect(claimedWithoutProvider.code).toBe(0);
      await admin`update visual_generation_jobs set lease_expires_at=now()-interval '1 second' where id=${exhausted.jobId}::uuid`;
    }
    await child(process.execPath, [path.resolve("scripts/testing/claim-visual-job.mjs")], { ...process.env, ADEENA_VISUAL_WORKER_DATABASE_URL: workerUrl }).done;
    const [exhaustedJob] = await admin`select status,failure_code,attempt_count from visual_generation_jobs where id=${exhausted.jobId}::uuid`;
    expect(exhaustedJob).toMatchObject({ status: "failed", failure_code: "worker-attempts-exhausted", attempt_count: 3 });
  }, 60_000);
});
