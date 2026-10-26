import { describe, expect, it } from "vitest";
import type { GenerationSource } from "./compile";
import { allowedFacts, parseSourcePlan, PlanReview, reviewPasses, reviewRejection, validatePlanReview } from "./model-plan";
import { groqStrictTransportSchema, inspectGroqStrictSchema } from "./strict-transport";
import { z } from "zod";
import preserved from "./fixtures/mvp03-review.json";

const source = preserved.source as GenerationSource;
const compiled = parseSourcePlan(preserved.proposedPlan, source);
if (!compiled.ok) throw new Error("Preserved base plan no longer compiles");
const plan = compiled.plan;
const span = (needle: string) => {
  const match = source.spans.find(item => item.excerpt.includes(needle));
  if (!match) throw new Error("Preserved source passage is missing");
  return match;
};
const review = (issues: unknown[], overrides: Record<string, unknown> = {}) => ({
  grounded: issues.length === 0, coherent: true, consequential: true, audienceSuitable: true, issues, ...overrides,
});
const issue = (sceneId: string, challengedClaim: string, finding: string, sourceSpanId: string | null,
  evidenceQuote: string | null, missingSupport: string | null, explanation = "The precise source relationship is not preserved.") =>
  ({ sceneId, challengedClaim, finding, sourceSpanId, evidenceQuote, missingSupport, explanation });

describe("evidence-grounded independent review", () => {
  it("supplies all preserved excerpts, including facts outside the four selected plan quotations", () => {
    const root = "A small root appears first and grows downward.";
    const shoot = "A shoot appears later and grows upward.";
    expect(source.spans).toHaveLength(3);
    expect(allowedFacts(source)).toEqual(expect.arrayContaining([
      { claim: root, spanId: span(root).id }, { claim: shoot, spanId: span(shoot).id },
    ]));
    expect(plan.facts.map(fact => fact.claim)).not.toContain(root);
    expect(plan.facts.map(fact => fact.claim)).not.toContain(shoot);
    expect(preserved.originalReview.issues).toHaveLength(2);
    expect(validatePlanReview(preserved.originalReview, source, plan)).toMatchObject({ ok: false, diagnostic: "review.contract-invalid" });
  });

  it("flags the omitted leaf-stage condition with an exact supplied quotation", () => {
    const quote = "The shoot needs light to make food once green leaves develop.";
    const output = review([issue("e1", "the shoot receives light and can make food", "missing-qualification",
      span(quote).id, quote, null, "Food making is conditioned on green leaves developing.")]);
    expect(validatePlanReview(output, source, plan).ok).toBe(true);
    expect(reviewPasses(output, source, plan)).toBe(false);
    expect(reviewRejection(output, source, plan).diagnostics[0].code).toBe("grounding.missing-qualification");
  });

  it("flags none-versus-insufficient water uptake in the preserved ending", () => {
    const quote = "A seed left on dry cotton does not take up enough water to begin germinating.";
    const output = review([issue("e4", "failed to take up water", "missing-qualification",
      span(quote).id, quote, null, "The source says uptake is insufficient, not absent.")]);
    expect(validatePlanReview(output, source, plan).ok).toBe(true);
    expect(reviewRejection(output, source, plan).diagnostics[0].code).toBe("grounding.missing-qualification");
  });

  it("keeps invented and contradicted consequences blocked", () => {
    const altered = structuredClone(plan);
    const ending = altered.progression.find(scene => scene.id === "e4");
    if (!ending) throw new Error("Expected ending is absent");
    ending.text += " The seed germinated without enough water. A new chemical formed.";
    const quote = "A seed left on dry cotton does not take up enough water to begin germinating.";
    const contradicted = review([issue("e4", "The seed germinated without enough water.", "contradicted",
      span(quote).id, quote, null)]);
    const invented = review([issue("e4", "A new chemical formed.", "unsupported", null, null,
      "The source does not establish any new chemical.")]);
    expect(reviewRejection(contradicted, source, altered).diagnostics[0].code).toBe("grounding.contradicted");
    expect(reviewRejection(invented, source, altered).diagnostics[0].code).toBe("grounding.unsupported-claim");
    expect(reviewPasses(contradicted, source, altered)).toBe(false);
    expect(reviewPasses(invented, source, altered)).toBe(false);
  });

  it("rejects invented quotes, wrong spans, missing citations and malformed issues without approving", () => {
    const quote = "The shoot needs light to make food once green leaves develop.";
    const valid = issue("e1", "the shoot receives light and can make food", "missing-qualification",
      span(quote).id, quote, null);
    const malformed = [
      { ...valid, evidenceQuote: "The source says all shoots make food immediately." },
      { ...valid, sourceSpanId: span("A small root appears first").id },
      { ...valid, evidenceQuote: null },
      { ...valid, sourceSpanId: null, evidenceQuote: null },
      { ...valid, sourceSpanId: "11111111-1111-4111-8111-111111111111" },
      { ...valid, challengedClaim: "A claim absent from the scene." },
    ];
    for (const item of malformed) {
      const output = review([item]);
      expect(validatePlanReview(output, source, plan).ok).toBe(false);
      expect(reviewPasses(output, source, plan)).toBe(false);
      expect(reviewRejection(output, source, plan).diagnostics[0].code).toBe("plan.review-invalid");
    }
    const exactSource = "The shoot needs light to make food once green leaves develop.";
    const falselyAbsent = review([issue("s1", exactSource, "unsupported", null, null,
      "The reviewer incorrectly calls a verbatim source sentence absent.")]);
    expect(validatePlanReview(falselyAbsent, source, plan)).toMatchObject({ ok: false, diagnostic: "review.claim-verbatim-in-source" });
    const unexplainedFailure = review([], { grounded: false });
    expect(validatePlanReview(unexplainedFailure, source, plan)).toMatchObject({ ok: false, diagnostic: "review.failed-check-without-issue" });
    expect(reviewPasses(unexplainedFailure, source, plan)).toBe(false);
  });

  it("retains route consistency and meaningful-decision rejection", () => {
    const route = review([issue("e1", "The seed on damp cotton took up water", "inconsistent-route", null, null, null)], { grounded: true, coherent: false });
    const decision = review([issue("s1", "Put the tray on the bright window sill", "inconsequential-decision", null, null, null)], { grounded: true, consequential: false });
    expect(reviewRejection(route, source, plan).diagnostics[0].code).toBe("plan.route-inconsistent");
    expect(reviewRejection(decision, source, plan).diagnostics[0].code).toBe("plan.decisions-insufficient");
    const broken = structuredClone(preserved.proposedPlan);
    if (!broken.progression[0].choices?.[0]) throw new Error("Expected opening choice is absent");
    broken.progression[0].choices[0].nextSceneId = "e1";
    expect(parseSourcePlan(broken, source)).toMatchObject({ ok: false, diagnostics: [{ code: "plan.consequences" }] });
  });

  it("keeps a closed Groq strict review schema", () => {
    const converted = groqStrictTransportSchema(z.toJSONSchema(PlanReview));
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(inspectGroqStrictSchema(converted.schema)).toEqual([]);
    const item = (converted.schema.properties as { issues: { items: Record<string, unknown> } }).issues.items;
    expect(item).toMatchObject({ type: "object", additionalProperties: false,
      required: ["sceneId", "challengedClaim", "finding", "sourceSpanId", "evidenceQuote", "missingSupport", "explanation"] });
  });
});
