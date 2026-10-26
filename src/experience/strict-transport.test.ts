import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compileExperiencePlan } from "./compile";
import { specimen } from "./model-plan.examples";
import { groqModelPlanSchema, PlanReview, requestPlanStage } from "./model-plan";
import { GENERATION_LIMITS, GROQ_COMMERCIAL_PRICE, GROQ_GPT_OSS_120B_MODEL, GROQ_RESPONSES_URL, OPENAI_GPT_54_MINI_PRICE, requestPaidEdit, serializedRequestBudget } from "./provider";
import { groqStrictTransportSchema, inspectGroqStrictSchema, normalizeGroqStrictOutput } from "./strict-transport";
import { VisualDirectorReviewV1, visualProposalSchema, type VisualDirectorInput } from "./visual-director/model-plan";

const quota = () => ({ ADEENA_GROQ_ACCOUNT_LIMITS_VERIFIED_AT: new Date().toISOString(), ADEENA_GROQ_VERIFIED_PLAN: "free", ADEENA_GROQ_VERIFIED_MODEL_AVAILABLE: "yes", ADEENA_GROQ_VERIFIED_BILLING_ESCALATION: "none", ADEENA_GROQ_VERIFIED_RATE_SHAPE: "combined", ADEENA_GROQ_VERIFIED_RPM: "100", ADEENA_GROQ_VERIFIED_TPM: "100000", ADEENA_GROQ_VERIFIED_REMAINING_REQUESTS: "100", ADEENA_GROQ_VERIFIED_REMAINING_TOKENS: "100000" });
const env = () => ({ ADEENA_EXPERIENCE_PROVIDER: "configured-provider", ADEENA_AI_EXECUTION_MODE: "free-development", ADEENA_RUNTIME: "nonproduction-test", ADEENA_GROQ_PLAN: "free", ADEENA_AI_MODEL: "openai/gpt-oss-120b", ADEENA_AI_API_URL: "https://api.groq.com/openai/v1/responses", ADEENA_GROQ_API_KEY: "test-key", ...quota() });

describe("Groq strict transport", () => {
  it("sends the paid Groq plan without unsupported fields and retains safe failure handling", async () => {
    const { source } = specimen();
    const paidEnv = { ADEENA_EXPERIENCE_PROVIDER: "configured-provider", ADEENA_AI_EXECUTION_MODE: "paid-development",
      ADEENA_AI_API_KEY: "test-key", ADEENA_AI_MODEL: GROQ_GPT_OSS_120B_MODEL, ADEENA_AI_API_URL: GROQ_RESPONSES_URL,
      ADEENA_AI_PRICE_VERSION: GROQ_COMMERCIAL_PRICE, ADEENA_AI_SPEND_CAP_USD: "1", ADEENA_AI_MAX_EDIT_COST_USD: "0.02",
      ADEENA_AI_SPEND_AUTHORIZED: "development" };
    let calls = 0;
    const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      expect(String(url)).toBe(GROQ_RESPONSES_URL);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe(GROQ_GPT_OSS_120B_MODEL);
      expect(body).not.toHaveProperty("store");
      expect(body.reasoning).toEqual({ effort: "low" });
      expect(body.max_output_tokens).toBe(GENERATION_LIMITS.plan.output);
      expect(body.text).toMatchObject({ format: { type: "json_schema", strict: true, name: "experience_plan" } });
      const format = (body.text as { format: { schema: unknown } }).format;
      expect(inspectGroqStrictSchema(format.schema)).toEqual([]);
      expect(format.schema).toMatchObject({ required: expect.arrayContaining(["fact1", "fact2", "fact3", "fact4"]), additionalProperties: false });
      expect((format.schema as { properties: Record<string, unknown> }).properties).not.toHaveProperty("facts");
      const budget = serializedRequestBudget(body, GENERATION_LIMITS.plan.output);
      expect(budget.admissionInputTokens).toBeLessThanOrEqual(GENERATION_LIMITS.plan.input);
      expect(budget.totalAdmissionTokens).toBeLessThan(131_072);
      return Response.json({ error: { code: "invalid_json_schema", message: "private source must not enter diagnostics" } }, { status: 400 });
    };
    const result = await requestPlanStage({ kind: "plan", source, env: paidEnv, fetchImpl: fetchImpl as typeof fetch });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: false, callCount: 1, retryCount: 0, usageKind: "estimate", actualCostMicros: 0 });
    expect(result.attempts?.[0]).toMatchObject({ httpStatus: 400, providerErrorCode: "invalid_json_schema", category: "provider-schema-rejected", billingCertainty: "unknown-external-charge" });
    expect(JSON.stringify(result.attempts)).not.toContain("private source");
    let blockedCalls = 0;
    const blocked = await requestPlanStage({ kind: "plan", source, env: { ...paidEnv, ADEENA_AI_SPEND_CAP_USD: "0.003", ADEENA_AI_MAX_EDIT_COST_USD: "0.003" },
      fetchImpl: (async () => { blockedCalls++; return new Response("unexpected"); }) as typeof fetch });
    expect(blocked).toMatchObject({ ok: false, code: "budget-unavailable", callCount: 0 });
    expect(blockedCalls).toBe(0);
  });

  it("keeps the OpenAI paid request configuration", async () => {
    let calls = 0;
    const result = await requestPaidEdit({
      env: { ADEENA_EXPERIENCE_PROVIDER: "configured-provider", ADEENA_AI_EXECUTION_MODE: "paid-development",
        ADEENA_AI_API_KEY: "test-key", ADEENA_AI_MODEL: "gpt-5.4-mini", ADEENA_AI_API_URL: "https://api.openai.com/v1/responses",
        ADEENA_AI_PRICE_VERSION: OPENAI_GPT_54_MINI_PRICE, ADEENA_AI_SPEND_CAP_USD: "1", ADEENA_AI_MAX_EDIT_COST_USD: "0.02",
        ADEENA_AI_SPEND_AUTHORIZED: "development" },
      systemText: "safe system", userText: "safe input",
      fetchImpl: (async (url, init) => {
        calls++;
        expect(String(url)).toBe("https://api.openai.com/v1/responses");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.store).toBe(false);
        expect(body.reasoning).toEqual({ effort: "none" });
        expect(body.text).toMatchObject({ format: { type: "json_schema", strict: true } });
        return new Response("{}", { status: 400 });
      }) as typeof fetch,
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: false, callCount: 1, retryCount: 0 });
  });

  it("keeps the original facts array for an OpenAI base plan", async () => {
    const { source } = specimen();
    let body: Record<string, unknown> | undefined;
    const result = await requestPlanStage({ kind: "plan", source,
      env: { ADEENA_EXPERIENCE_PROVIDER: "configured-provider", ADEENA_AI_EXECUTION_MODE: "paid-development",
        ADEENA_AI_API_KEY: "test-key", ADEENA_AI_MODEL: "gpt-5.4-mini", ADEENA_AI_API_URL: "https://api.openai.com/v1/responses",
        ADEENA_AI_PRICE_VERSION: OPENAI_GPT_54_MINI_PRICE, ADEENA_AI_SPEND_CAP_USD: "1", ADEENA_AI_MAX_EDIT_COST_USD: "0.05",
        ADEENA_AI_SPEND_AUTHORIZED: "development" },
      fetchImpl: (async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response("{}", { status: 400 }); }) as typeof fetch });
    expect(result.callCount).toBe(1);
    const schema = (body?.text as { format: { schema: { properties: Record<string, unknown> } } }).format.schema;
    expect(schema.properties).toHaveProperty("facts");
    expect(schema.properties).not.toHaveProperty("fact1");
  });

  it("rejects optional fields, open objects, unsupported oneOf and unknown keywords", () => {
    const bad = { type: "object", properties: { a: { type: "string" } }, required: [], additionalProperties: true, oneOf: [], pattern: ".*" };
    const codes = inspectGroqStrictSchema(bad).map(issue => issue.code);
    expect(codes).toContain("property.optional");
    expect(codes).toContain("object.open");
    expect(codes).toContain("keyword.unsupported");
    expect(groqStrictTransportSchema({ oneOf: [{ type: "string" }, { type: "string" }] })).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: "union.not-disjoint" })]) });
  });

  it("uses required nullable transport fields and normalizes only null to absence", () => {
    const source = z.toJSONSchema(z.object({ id: z.string(), label: z.string().optional() }).strict());
    const converted = groqStrictTransportSchema(source);
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(inspectGroqStrictSchema(converted.schema)).toEqual([]);
    expect(converted.schema.required).toEqual(["id", "label"]);
    expect(normalizeGroqStrictOutput({ id: "x", label: null }, source)).toEqual({ ok: true, value: { id: "x" } });
    expect(normalizeGroqStrictOutput({ id: "x", label: "" }, source)).toEqual({ ok: true, value: { id: "x", label: "" } });
    expect(normalizeGroqStrictOutput({ id: "x" }, source)).toMatchObject({ ok: false });
    expect(normalizeGroqStrictOutput({ id: "x", label: null, injection: true }, source)).toMatchObject({ ok: false });
  });

  it("preserves discriminators and rejects duplicate dynamic-record entries", () => {
    const source = z.toJSONSchema(z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("first"), score: z.number() }).strict(),
      z.object({ kind: z.literal("second"), rankByItemId: z.record(z.string(), z.number()) }).strict(),
    ]));
    const converted = groqStrictTransportSchema(source);
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(inspectGroqStrictSchema(converted.schema)).toEqual([]);
    expect(JSON.stringify(converted.schema)).not.toContain("oneOf");
    expect(normalizeGroqStrictOutput({ kind: "second", rankByItemId: [{ key: "a", value: 1 }] }, source)).toEqual({ ok: true, value: { kind: "second", rankByItemId: { a: 1 } } });
    expect(normalizeGroqStrictOutput({ kind: "second", rankByItemId: [{ key: "a", value: 1 }, { key: "a", value: 2 }] }, source)).toMatchObject({ ok: false });
    expect(normalizeGroqStrictOutput({ kind: "third", score: 1 }, source)).toMatchObject({ ok: false });
  });

  it("converts all four current stage schemas without weakening trusted contracts", () => {
    const { source } = specimen();
    const compiled = compileExperiencePlan(source);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const directorInput: VisualDirectorInput = { source, learningObjective: compiled.plan.learnerObjective, locale: compiled.manifest.locale, manifest: compiled.manifest,
      implementedArchetypes: ["process-pathway@1", "venn-two-set@1"], allowedAssetIds: [], practiceMechanics: ["sequence-steps", "classify", "calculate-two-set-cardinality"] };
    for (const schema of [groqModelPlanSchema(source), z.toJSONSchema(PlanReview), visualProposalSchema(directorInput), z.toJSONSchema(VisualDirectorReviewV1)]) {
      const converted = groqStrictTransportSchema(schema);
      expect(converted).toMatchObject({ ok: true });
      if (converted.ok) expect(inspectGroqStrictSchema(converted.schema)).toEqual([]);
    }
  });

  it("admits no request without current verified Free quota or with insufficient TPM", async () => {
    const { source } = specimen();
    let calls = 0;
    let endpoint = "";
    let requestBody: Record<string, unknown> = {};
    const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => { calls++; endpoint = String(url); requestBody = JSON.parse(String(init?.body)); return new Response("{}", { status: 503 }); };
    const missing = await requestPlanStage({ kind: "plan", source, env: { ...env(), ADEENA_GROQ_ACCOUNT_LIMITS_VERIFIED_AT: "" }, fetchImpl: fetchImpl as typeof fetch });
    expect(missing).toMatchObject({ ok: false, code: "budget-unavailable", callCount: 0, diagnostic: "account.verified-quota-unavailable" });
    const low = await requestPlanStage({ kind: "plan", source, env: { ...env(), ADEENA_GROQ_VERIFIED_TPM: "1000" }, fetchImpl: fetchImpl as typeof fetch });
    expect(low).toMatchObject({ ok: false, code: "budget-unavailable", callCount: 0 });
    expect(calls).toBe(0);
    const split = await requestPlanStage({ kind: "plan", source, env: { ...env(), ADEENA_GROQ_VERIFIED_RATE_SHAPE: "split", ADEENA_GROQ_VERIFIED_ITPM: "100", ADEENA_GROQ_VERIFIED_OTPM: "100000", ADEENA_GROQ_VERIFIED_REMAINING_INPUT_TOKENS: "100", ADEENA_GROQ_VERIFIED_REMAINING_OUTPUT_TOKENS: "100000" }, fetchImpl: fetchImpl as typeof fetch });
    expect(split).toMatchObject({ ok: false, code: "budget-unavailable", callCount: 0 });
    const admitted = await requestPlanStage({ kind: "plan", source, env: env(), fetchImpl: fetchImpl as typeof fetch });
    expect(admitted.callCount).toBe(1);
    expect(calls).toBe(1);
    expect(endpoint).toBe("https://api.groq.com/openai/v1/responses");
    expect(requestBody).toMatchObject({ model: "openai/gpt-oss-120b", tool_choice: "none", text: { format: { type: "json_schema", strict: true, name: "experience_plan" } } });
    expect(inspectGroqStrictSchema((requestBody.text as { format: { schema: unknown } }).format.schema)).toEqual([]);
  });

  it("rejects incompatible structured schemas before any provider call", async () => {
    let calls = 0;
    const result = await requestPaidEdit({ env: env(), systemText: "safe", userText: "safe", structuredGeneration: { kind: "plan", schema: { oneOf: [{ type: "string" }, { type: "string" }] } }, fetchImpl: (async () => { calls++; return new Response("{}", { status: 503 }); }) as typeof fetch });
    expect(result).toMatchObject({ ok: false, code: "invalid-experience", callCount: 0 });
    expect(calls).toBe(0);
  });

  it("budgets the full serialized request and keeps bytes distinct from tokens", () => {
    const budget = serializedRequestBudget({ instructions: "x".repeat(1000), input: "hello", text: { format: { schema: { type: "object" } } } }, 500);
    expect(budget.serializedBytes).toBeGreaterThan(1000);
    expect(budget.schemaBytes).toBeGreaterThan(0);
    expect(budget.admissionInputTokens).toBeGreaterThan(budget.estimatedInputTokens);
    expect(budget.totalAdmissionTokens).toBe(budget.admissionInputTokens + 500);
  });
});
