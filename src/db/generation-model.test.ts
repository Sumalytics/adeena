import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { specimen } from "@/experience/model-plan.examples";
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
import { createPlayableExperience } from "./experience-repository";

const env = { ADEENA_EXPERIENCE_PROVIDER: "configured-provider", ADEENA_AI_EXECUTION_MODE: "free-development", ADEENA_RUNTIME: "nonproduction-test", ADEENA_GROQ_PLAN: "free", ADEENA_AI_MODEL: "openai/gpt-oss-120b", ADEENA_AI_API_URL: "https://api.groq.com/openai/v1/responses", ADEENA_GROQ_API_KEY: "test-key", ADEENA_GROQ_ACCOUNT_LIMITS_VERIFIED_AT: new Date().toISOString(), ADEENA_GROQ_VERIFIED_PLAN: "free", ADEENA_GROQ_VERIFIED_MODEL_AVAILABLE: "yes", ADEENA_GROQ_VERIFIED_BILLING_ESCALATION: "none", ADEENA_GROQ_VERIFIED_RATE_SHAPE: "combined", ADEENA_GROQ_VERIFIED_RPM: "100", ADEENA_GROQ_VERIFIED_TPM: "100000", ADEENA_GROQ_VERIFIED_REMAINING_REQUESTS: "100", ADEENA_GROQ_VERIFIED_REMAINING_TOKENS: "100000" };
describe("durable model generation", () => {
  const database = `adeena_model_test_${randomUUID().replaceAll("-", "")}`;
  let maintenance: DatabaseClient, admin: DatabaseClient, sql: DatabaseClient;
  let root: string;
  beforeAll(async () => {
    maintenance = openDatabase(urlForDatabase(databaseUrl(), "postgres"));
    await maintenance.unsafe(`CREATE DATABASE ${database}`);
    admin = openDatabase(urlForDatabase(databaseUrl(), database));
    sql = openDatabase(urlForDatabase(applicationDatabaseUrl(), database));
    await migrateUp(admin);
    root = await mkdtemp(path.join(tmpdir(), "adeena-model-"));
  });
  afterAll(async () => {
    await sql?.end({ timeout: 1 }); await admin?.end({ timeout: 1 });
    await maintenance.unsafe(`DROP DATABASE ${database}`); await maintenance.end();
    if (root) await rm(root, { recursive: true, force: true });
  }, 20_000);
  it("reserves two calls, persists usage, replays without network, rejects semantic failure and enforces the shared quota", async () => {
    const identity = issueIdentityForIsolatedTests(randomUUID());
    const workspaceId = randomUUID();
    await createWorkspace(sql, identity, { id: workspaceId, name: "Model test", workspaceType: "personal" });
    const actor = { sql, identity, workspaceId };
    const store = createFilesystemObjectStore(root);
    const { source, plan } = specimen();
    const uploaded = await enqueueDurableSource({ ...actor, filename: "garden.md", bytes: Buffer.from(`# Rain garden\n\n## Routes\n\n${source.spans[0].excerpt} ${source.spans[0].excerpt} ${source.spans[0].excerpt}`), store, idempotencyKey: randomUUID() });
    await runExtractionOnce({ ...actor, store, leaseOwner: "model-test" });
    const [excerptCapacity] = await admin`select max(char_length(generation_excerpt))::int as length from source_spans where document_version_id=${uploaded.version.id}::uuid`;
    expect(Number(excerptCapacity.length)).toBeGreaterThan(280);
    const documentVersionId = uploaded.version.id;
    const recommended = await recommendFirstTopic({ ...actor, documentVersionId, audienceLabel: "Primary learners", ageBand: "8-10", idempotencyKey: randomUUID() });
    const topicCandidateId = recommended.recommendation!.topicCandidateId;
    if (!topicCandidateId) throw new Error("Example topic was not selected");
    let requests = 0, rejectReview = false;
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      const context = JSON.parse(body.input);
      const { facts, ...planFields } = plan;
      const result = body.text.format.name === "experience_plan" ? {
        ...planFields, fact1: { ...facts[0], spanId: context.excerpts[0].id },
        fact2: { ...facts[1], spanId: context.excerpts[0].id }, fact3: null, fact4: null,
      } : { grounded: !rejectReview, coherent: true, consequential: true, audienceSuitable: true, issues: [] };
      return Response.json({ id: `resp_${requests}`, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }], usage: { input_tokens: 1000, output_tokens: 800, output_tokens_details: { reasoning_tokens: 10 } } });
    };
    const input = { ...actor, documentVersionId, topicCandidateId, audienceLabel: "Primary learners", ageBand: "8-10" as const, idempotencyKey: randomUUID(), authorizeGeneration: true as const, provider: "configured-provider" as const, env, fetchImpl };
    const first = await createPlayableExperience(input);
    expect(first.status).toBe("ready");
    const replay = await createPlayableExperience(input);
    expect(replay.experienceVersionId).toBe(first.experienceVersionId);
    expect(requests).toBe(2);
    const [cost] = await admin`select * from experience_generation_costs where job_id=${first.jobId}`;
    expect(cost).toMatchObject({ execution_mode: "free-development", call_count: 2, actual_cost_micros: 0, input_tokens: 2000, output_tokens: 1600, usage_kind: "actual" });
    expect(cost.commercial_estimate_micros).toBeGreaterThan(0);
    expect(cost.model_calls[1].review.grounded).toBe(true);
    rejectReview = true;
    await expect(createPlayableExperience({ ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "invalid-experience" });
    expect(requests).toBe(4);
    await expect(createPlayableExperience({ ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "budget-unavailable" });
    expect(requests).toBe(4);
    expect(await admin`select id from experience_versions`).toHaveLength(1);
    const [quota] = await admin`select session_requests,day_requests from adeena_free_quota`;
    expect(quota).toMatchObject({ session_requests: 4, day_requests: 4 });
    // A separate quota scenario inside this disposable test database only.
    await admin`update adeena_free_quota set session_requests=0,day_requests=0`;
    let invalidCalls = 0;
    const invalidInput = { ...input, idempotencyKey: randomUUID(), fetchImpl: (async () => {
      invalidCalls++;
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }], usage: { input_tokens: 500, output_tokens: 50 } });
    }) as typeof fetch };
    await expect(createPlayableExperience(invalidInput)).rejects.toMatchObject({ code: "invalid-experience" });
    await expect(createPlayableExperience(invalidInput)).rejects.toMatchObject({ code: "invalid-experience" });
    expect(invalidCalls).toBe(1);
    const [unused] = await admin`select session_requests,day_requests from adeena_free_quota`;
    expect(unused).toMatchObject({ session_requests: 1, day_requests: 1 });
  });

  it("keeps a paid unknown charge reserved with a safe durable diagnostic and never reactivates the failed job", async () => {
    const identity = issueIdentityForIsolatedTests(randomUUID());
    const workspaceId = randomUUID();
    await createWorkspace(sql, identity, { id: workspaceId, name: "Diagnostic test", workspaceType: "personal" });
    const actor = { sql, identity, workspaceId };
    const { source } = specimen();
    const store = createFilesystemObjectStore(root);
    const uploaded = await enqueueDurableSource({ ...actor, filename: "garden-diagnostic.md", bytes: Buffer.from(`# Rain garden\n\n${source.spans[0].excerpt} ${source.spans[0].excerpt} ${source.spans[0].excerpt}`), store, idempotencyKey: randomUUID() });
    await runExtractionOnce({ ...actor, store, leaseOwner: "diagnostic-test" });
    const documentVersionId = uploaded.version.id;
    const recommended = await recommendFirstTopic({ ...actor, documentVersionId, audienceLabel: "Primary learners", ageBand: "8-10", idempotencyKey: randomUUID() });
    const topicCandidateId = recommended.recommendation!.topicCandidateId!;
    const paidEnv = {
      ADEENA_EXPERIENCE_PROVIDER: "configured-provider", ADEENA_AI_EXECUTION_MODE: "paid-development",
      ADEENA_AI_API_KEY: "private-test-key", ADEENA_AI_MODEL: "openai/gpt-oss-120b",
      ADEENA_AI_PRICE_VERSION: "groq-gpt-oss-120b-ondemand-2026-10", ADEENA_AI_API_URL: "https://api.groq.com/openai/v1/responses",
      ADEENA_AI_SPEND_CAP_USD: "1", ADEENA_AI_MAX_EDIT_COST_USD: "0.02", ADEENA_AI_SPEND_AUTHORIZED: "development",
    };
    let requests = 0;
    const idempotencyKey = randomUUID();
    const input = { ...actor, documentVersionId, topicCandidateId, audienceLabel: "Primary learners", ageBand: "8-10" as const,
      idempotencyKey, authorizeGeneration: true as const, provider: "configured-provider" as const, env: paidEnv,
      fetchImpl: (async () => { requests++; return Response.json({ error: { code: "invalid_request_error", message: `Echo ${source.spans[0].excerpt} private-test-key` } }, { status: 400, headers: { "x-request-id": "req_1234567890abcdef" } }); }) as typeof fetch,
    };
    await expect(createPlayableExperience(input)).rejects.toMatchObject({ code: "provider-unavailable" });
    await expect(createPlayableExperience(input)).rejects.toMatchObject({ code: "provider-unavailable" });
    expect(requests).toBe(1);
    const [job] = await admin`select id::text,status,permanent,attempt_count from experience_generation_jobs where idempotency_key=${idempotencyKey}::uuid`;
    expect(job).toMatchObject({ status: "failed", permanent: true, attempt_count: 1 });
    const [cost] = await admin`select actual_cost_micros,estimated_cost_micros,usage_kind,call_count,retry_count,model_calls from experience_generation_costs where job_id=${job.id}::uuid`;
    expect(cost).toMatchObject({ actual_cost_micros: null, estimated_cost_micros: 3300, usage_kind: "estimate", call_count: 1, retry_count: 0 });
    expect(cost.model_calls[0].attempts[0]).toMatchObject({ jobId: job.id, stage: "plan", httpStatus: 400, category: "provider-request-invalid", billingCertainty: "unknown-external-charge" });
    expect(JSON.stringify(cost.model_calls)).not.toContain(source.spans[0].excerpt);
    expect(JSON.stringify(cost.model_calls)).not.toContain("private-test-key");
    const [spend] = await admin`select reserved_micros from adeena_edit_spend where id='development'`;
    expect(spend.reserved_micros).toBe(3300);

    const rejectedKey = randomUUID();
    let rejectedRequests = 0;
    await expect(createPlayableExperience({ ...input, idempotencyKey: rejectedKey, fetchImpl: (async () => {
      rejectedRequests++;
      return Response.json({ error: { code: "invalid_api_key", message: "Rejected before generation" } }, { status: 401 });
    }) as typeof fetch })).rejects.toMatchObject({ code: "generation-unavailable" });
    expect(rejectedRequests).toBe(1);
    const [rejected] = await admin`select c.actual_cost_micros,c.estimated_cost_micros,c.usage_kind,c.model_calls from experience_generation_costs c join experience_generation_jobs j on j.id=c.job_id where j.idempotency_key=${rejectedKey}::uuid`;
    expect(rejected).toMatchObject({ actual_cost_micros: 0, estimated_cost_micros: 0, usage_kind: "none" });
    expect(rejected.model_calls[0].attempts[0]).toMatchObject({ httpStatus: 401, category: "provider-auth-failure", billingCertainty: "confirmed-nonbillable" });
    const [afterRejection] = await admin`select reserved_micros from adeena_edit_spend where id='development'`;
    expect(afterRejection.reserved_micros).toBe(3300);
  });
});
