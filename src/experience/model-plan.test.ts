import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { allowedFacts, groqModelPlanSchema, modelPlanSchema, normalizeGroqModelPlan, parseSourcePlan, reviewPasses, reviewRejection, requestPlanStage } from "./model-plan";
import { examples, specimen } from "./model-plan.examples";
import preservedPlan from "./fixtures/mvp02-base-plan.json";
import { groqStrictTransportSchema } from "./strict-transport";

describe("source-specific model plans", () => {
  it.each(examples)("compiles and simulates $title with four choice-dependent outcomes", example => {
    const { source, plan } = specimen(example);
    const result = parseSourcePlan(plan, source);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.simulation.endingSceneIds).toHaveLength(4);
    expect(result.manifest.runtime.requiresLlm).toBe(false);
    expect(result.plan.promptVersion).toBe("source-plan@1");
  });
  it("rejects invented claims, foreign references, cycles, early endings and duplicate outcomes", () => {
    const { source, plan } = specimen();
    const mutate = (edit: (value: typeof plan) => void) => { const copy = structuredClone(plan); edit(copy); expect(parseSourcePlan(copy, source).ok).toBe(false); };
    mutate(value => { value.facts[0].claim = "Rain gardens produce electricity."; });
    mutate(value => { value.facts[0].spanId = randomUUID(); });
    mutate(value => { if ("choices" in value.progression[0]) value.progression[0].choices[0].nextSceneId = "start"; });
    mutate(value => { if ("choices" in value.progression[0]) value.progression[0].choices[0].nextSceneId = "end-0"; });
    mutate(value => { value.progression[6].text = value.progression[5].text; });
  });
  it("fails closed on semantic contradictions and unsupported narrative", () => {
    const { source, plan } = specimen();
    const compiled = parseSourcePlan(plan, source);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const approved = { grounded: true, coherent: true, consequential: true, audienceSuitable: true, issues: [] };
    expect(reviewPasses(approved, source, compiled.plan)).toBe(true);
    expect(reviewPasses({ ...approved, coherent: false }, source, compiled.plan)).toBe(false);
    expect(reviewPasses({ ...approved, issues: [{ sceneId: "start", challengedClaim: plan.progression[0].text,
      finding: "unsupported", sourceSpanId: null, evidenceQuote: null,
      missingSupport: "The narrative adds a claim absent from the source.", explanation: "The source does not establish it." }] }, source, compiled.plan)).toBe(false);
    expect(reviewPasses({ ...approved, injected: true }, source, compiled.plan)).toBe(false);
    expect(reviewPasses(null, source, compiled.plan)).toBe(false);
  });
  it("sends excerpts, topic, audience and age to the authorized configured transport without a fixture fallback", async () => {
    const { source } = specimen();
    let body: Record<string, unknown> | undefined;
    const result = await requestPlanStage({ kind: "plan", source, env: { ADEENA_EXPERIENCE_PROVIDER: "configured-provider", ADEENA_AI_API_URL: "https://api.groq.com/openai/v1/responses", ADEENA_AI_EXECUTION_MODE: "free-development", ADEENA_RUNTIME: "local-development", ADEENA_GROQ_PLAN: "free", ADEENA_AI_MODEL: "openai/gpt-oss-120b", ADEENA_GROQ_API_KEY: "test-key", ADEENA_GROQ_ACCOUNT_LIMITS_VERIFIED_AT: new Date().toISOString(), ADEENA_GROQ_VERIFIED_PLAN: "free", ADEENA_GROQ_VERIFIED_MODEL_AVAILABLE: "yes", ADEENA_GROQ_VERIFIED_BILLING_ESCALATION: "none", ADEENA_GROQ_VERIFIED_RATE_SHAPE: "combined", ADEENA_GROQ_VERIFIED_RPM: "100", ADEENA_GROQ_VERIFIED_TPM: "100000", ADEENA_GROQ_VERIFIED_REMAINING_REQUESTS: "100", ADEENA_GROQ_VERIFIED_REMAINING_TOKENS: "100000" }, fetchImpl: async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response("{}", { status: 503 }); } });
    expect(JSON.stringify(body)).toContain(source.spans[0].excerpt);
    expect(JSON.stringify(body)).toContain(source.topicTitle);
    expect(JSON.stringify(body)).toContain(source.audienceLabel);
    expect(JSON.stringify(body)).toContain(source.ageBand);
    const schema = JSON.stringify(modelPlanSchema(source));
    expect(schema).toContain(`\"enum\":[\"${source.spans[0].id}\"]`);
    for (const fact of allowedFacts(source)) expect(schema).toContain(fact.claim);
    expect(result.ok).toBe(false);
    expect(result.content).toBeUndefined();
  });
  it("constrains structured claims to exact source sentences", () => {
    const { source } = specimen();
    const facts = allowedFacts(source);
    expect(facts).toHaveLength(2);
    expect(facts.every((fact) => source.spans.some((span) => span.id === fact.spanId && span.excerpt.includes(fact.claim)))).toBe(true);
    const schema = JSON.stringify(modelPlanSchema(source));
    expect(schema).toContain(facts[0].claim);
    expect(schema).not.toContain("Rain gardens produce electricity.");
  });
  it("rejects the twelve-fact live response and makes the Groq fact transport closed at four slots", () => {
    const { source } = specimen();
    expect(preservedPlan.facts).toHaveLength(12);
    expect(parseSourcePlan(preservedPlan, source)).toMatchObject({ ok: false, diagnostics: [{ code: "plan.invalid" }] });
    const transport = groqStrictTransportSchema(groqModelPlanSchema(source));
    expect(transport.ok).toBe(true);
    if (!transport.ok) return;
    const schema = transport.schema;
    const properties = schema.properties as Record<string, unknown>;
    expect(schema.required).toEqual(Object.keys(properties));
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(properties).filter(key => /^fact[1-4]$/.test(key))).toEqual(["fact1", "fact2", "fact3", "fact4"]);
    expect(properties).not.toHaveProperty("facts");
    for (const key of ["fact1", "fact2"]) expect(properties[key]).toMatchObject({ type: "object", additionalProperties: false });
    for (const key of ["fact3", "fact4"]) expect(properties[key]).toMatchObject({ anyOf: [{ type: "object", additionalProperties: false }, { type: "null" }] });
  });
  it("normalizes two, three or four source-exact facts without dropping any content", () => {
    const { source, plan } = specimen();
    source.spans[0].excerpt += " A blue card signals the curtain to open. A yellow card signals the music to start.";
    const candidates = allowedFacts(source);
    expect(candidates).toHaveLength(4);
    const { facts, ...rest } = plan;
    expect(facts).toHaveLength(2);
    const sourceFacts = candidates.map(fact => ({ kind: "source" as const, ...fact }));
    for (const count of [2, 3, 4]) {
      const slots = { ...rest, fact1: sourceFacts[0], fact2: sourceFacts[1], fact3: sourceFacts[2] && count >= 3 ? sourceFacts[2] : null, fact4: sourceFacts[3] && count >= 4 ? sourceFacts[3] : null };
      const normalized = normalizeGroqModelPlan(slots, source);
      expect(normalized).toMatchObject({ ok: true, value: { facts: sourceFacts.slice(0, count) } });
      if (count === 2 && normalized.ok) expect(parseSourcePlan(normalized.value, source).ok).toBe(true);
    }
  });
  it("rejects gaps, duplicates, foreign or mismatched source pairs, malformed slots and extra fields", () => {
    const { source, plan } = specimen();
    const { facts, ...rest } = plan;
    const [fact1, fact2] = facts;
    const slots = { ...rest, fact1, fact2, fact3: null, fact4: null };
    const fail = (input: unknown, diagnostic: string) => expect(normalizeGroqModelPlan(input, source)).toEqual({ ok: false, diagnostic });
    fail({ ...slots, fact3: null, fact4: fact2 }, "plan.fact-slots.gap");
    fail({ ...slots, fact3: fact1 }, "plan.fact-slots.duplicate");
    fail({ ...slots, fact2: { ...fact2, claim: "A fabricated fact about the subject." } }, "plan.fact-slots.unmatched-source");
    fail({ ...slots, fact2: { ...fact2, spanId: randomUUID() } }, "plan.fact-slots.unmatched-source");
    fail({ ...slots, fact3: { ...fact1, spanId: randomUUID() } }, "plan.fact-slots.duplicate");
    fail({ ...slots, fact4: {} }, "plan.fact-slots.invalid");
    fail({ ...slots, fact4: undefined }, "plan.fact-slots.invalid");
    fail({ ...slots, facts: [fact1, fact2] }, "plan.fact-slots.invalid");
    fail({ ...slots, fact1: { ...fact1, extra: true } }, "plan.fact-slots.invalid");
  });
  it("requires independent rejection of unsupported narrative in the preserved live response", () => {
    const narrative = preservedPlan.progression.map(scene => scene.text).join(" ");
    const claims = preservedPlan.facts.map(fact => fact.claim).join(" ");
    expect(narrative).toContain("healthy seedling");
    expect(narrative).toContain("root but no green shoot");
    expect(claims).not.toContain("healthy seedling");
    expect(claims).not.toContain("root but no green shoot");
    const { source, plan } = specimen();
    const compiled = parseSourcePlan(plan, source);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const issue = { sceneId: "start", challengedClaim: plan.progression[0].text, finding: "unsupported",
      sourceSpanId: null, evidenceQuote: null, missingSupport: "The new outcome is absent from the source.", explanation: "The added outcome has no source support." };
    const review = { grounded: false, coherent: true, consequential: true, audienceSuitable: true, issues: [issue] };
    expect(reviewPasses(review, source, compiled.plan)).toBe(false);
    expect(reviewRejection(review, source, compiled.plan)).toMatchObject({ ok: false, diagnostics: [{ code: "grounding.unsupported-claim" }] });
    expect(reviewRejection({ ...review, grounded: true, consequential: false, issues: [{ ...issue, finding: "inconsequential-decision", missingSupport: null }] }, source, compiled.plan))
      .toMatchObject({ ok: false, diagnostics: [{ code: "plan.decisions-insufficient" }] });
  });
});
