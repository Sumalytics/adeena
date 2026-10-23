import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSourcePlan, reviewPasses, requestPlanStage } from "./model-plan";
import { examples, specimen } from "./model-plan.examples";

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
    const approved = { grounded: true, coherent: true, consequential: true, audienceSuitable: true, issues: [] };
    expect(reviewPasses(approved)).toBe(true);
    expect(reviewPasses({ ...approved, coherent: false })).toBe(false);
    expect(reviewPasses({ ...approved, issues: [{ code: "unsupported-claim", sceneId: "start", reason: "The narrative adds a claim absent from the source." }] })).toBe(false);
    expect(reviewPasses({ ...approved, injected: true })).toBe(false);
    expect(reviewPasses(null)).toBe(false);
  });
  it("sends excerpts, topic, audience and age to the authorized configured transport without a fixture fallback", async () => {
    const { source } = specimen();
    let body: Record<string, unknown> | undefined;
    const result = await requestPlanStage({ kind: "plan", source, env: { ADEENA_EXPERIENCE_PROVIDER: "configured-provider", ADEENA_AI_API_URL: "https://api.groq.com/openai/v1/responses", ADEENA_AI_EXECUTION_MODE: "free-development", ADEENA_RUNTIME: "local-development", ADEENA_GROQ_PLAN: "free", ADEENA_AI_MODEL: "openai/gpt-oss-120b", ADEENA_GROQ_API_KEY: "test-key" }, fetchImpl: async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response("{}", { status: 503 }); } });
    expect(JSON.stringify(body)).toContain(source.spans[0].excerpt);
    expect(JSON.stringify(body)).toContain(source.topicTitle);
    expect(JSON.stringify(body)).toContain(source.audienceLabel);
    expect(JSON.stringify(body)).toContain(source.ageBand);
    expect(result.ok).toBe(false);
    expect(result.content).toBeUndefined();
  });
});
