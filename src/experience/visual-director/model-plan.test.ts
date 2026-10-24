import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileExperiencePlan, newExperienceIds, type GenerationSource } from "@/experience/compile";
import { authoredProcessFixture, authoredTwoSetFixture } from "./fixtures";
import {
  requestVisualDirectorStage,
  visualDirectorPayload,
  visualReviewPasses,
  type VisualDirectorInput,
  type VisualDirectorProposal,
} from "./model-plan";
import { validateVisualDirectorProposal } from "./model-validation";

const processQuote = "Coffee cherries are picked, sorted, pulped, fermented, washed, dried, milled, roasted, and packed in that order.";
const mathQuote = "In a group of 30 learners, 18 study French, 14 study Spanish, and 6 study both, so 26 study at least one and 4 study neither.";

function inputFor(kind: "process" | "math"): VisualDirectorInput {
  const spanId = kind === "process" ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const quote = kind === "process" ? processQuote : mathQuote;
  const ids = newExperienceIds();
  const source: GenerationSource = { documentVersionId: randomUUID(), topicTitle: kind === "process" ? "Coffee preparation" : "Two language sets", audienceLabel: "Secondary learners", ageBand: "11-13", spans: [{ id: spanId, excerpt: quote }], ...ids };
  const compiled = compileExperiencePlan(source);
  if (!compiled.ok) throw new Error("test manifest did not compile");
  return { source, learningObjective: kind === "process" ? "Explain the ordered preparation stages." : "Calculate membership across two overlapping sets.", locale: "en", manifest: compiled.manifest, implementedArchetypes: ["process-pathway@1", "venn-two-set@1"], allowedAssetIds: compiled.manifest.assets.map((asset) => asset.id), practiceMechanics: ["sequence-steps", "classify", "calculate-two-set-cardinality"] };
}

function proposalFor(kind: "process" | "math", input: VisualDirectorInput): Extract<VisualDirectorProposal, { result: "supported" }> {
  const spanId = input.source.spans[0].id;
  const quote = kind === "process" ? processQuote : mathQuote;
  const blueprint = structuredClone(kind === "process" ? authoredProcessFixture : authoredTwoSetFixture);
  const scene = blueprint.scenes[0];
  scene.id = "opening";
  scene.sourceSpanIds = [spanId];
  scene.cues = scene.cues.filter((cue) => cue.trigger.kind !== "choice-applied");
  for (const narration of scene.narration) narration.sourceSpanIds = [spanId];
  if (scene.interaction) scene.interaction.sourceSpanIds = [spanId];
  blueprint.locale = "en";
  blueprint.voice.locale = "en";
  blueprint.ageBand = input.source.ageBand;
  const evidence = [{ id: "source-outcome", statement: quote, evidence: { spanId, quote } }];
  const bind = (elementId: string) => ({ elementId, outcomeIds: ["source-outcome"] });
  return {
    result: "supported",
    plan: {
      contract: "ADEENA-INSTRUCTIONAL-PLAN-v1",
      learnerObjective: input.learningObjective,
      visualTreatment: scene.archetype as "process-pathway@1" | "venn-two-set@1",
      learningOutcomes: evidence,
      scenes: [{
        blueprintSceneId: scene.id,
        concept: kind === "process" ? "Ordered coffee preparation" : "Membership in two overlapping sets",
        representationRationale: kind === "process" ? "A connected pathway makes the stated order visible." : "Overlapping regions represent membership in both groups.",
        learnerSees: "Source-supported stages and relationships are labelled on the stage.",
        movementPurpose: "Cues reveal and emphasize the relationship described by the source.",
        narrationPurpose: "Narration explains the same relationship while its cue is active.",
        practicePurpose: kind === "process" ? "Learners apply the source order." : "Learners recompute the source counts.",
        outcomeIds: ["source-outcome"],
        objectEvidence: scene.visualObjects.filter((item) => item.role !== "decorative").map((item) => bind(item.id)),
        cueEvidence: scene.cues.map((item) => bind(item.id)),
        narrationEvidence: scene.narration.map((item) => bind(item.id)),
        interactionEvidence: scene.interaction ? bind(scene.interaction.id) : null,
      }],
    },
    blueprint,
    mapping: { contract: "ADEENA-VISUAL-SCENE-MAPPING-v1", legacyExperienceId: input.manifest.experienceId, scenes: [{ visualSceneId: "opening", legacySceneId: "opening" }], choices: [] },
  };
}

describe("AI visual instructional director", () => {
  it("validates meaningfully different process and mathematical proposals", () => {
    const processInput = inputFor("process");
    const mathInput = inputFor("math");
    const process = validateVisualDirectorProposal(proposalFor("process", processInput), processInput);
    const math = validateVisualDirectorProposal(proposalFor("math", mathInput), mathInput);
    expect(process).toMatchObject({ ok: true, status: "supported" });
    expect(math).toMatchObject({ ok: true, status: "supported" });
    if (process.ok && process.status === "supported" && math.ok && math.status === "supported") {
      expect(process.proposal.plan.visualTreatment).toBe("process-pathway@1");
      expect(math.proposal.plan.visualTreatment).toBe("venn-two-set@1");
      expect(process.proposal.blueprint.scenes[0].interaction?.kind).toBe("sequence-steps");
      expect(math.proposal.blueprint.scenes[0].interaction?.kind).toBe("calculate");
    }
  });

  it("reports a previously unseen agricultural chronology as unsupported when it needs the unavailable timeline renderer", () => {
    const input = inputFor("process");
    input.source.topicTitle = "Seasonal crop rotation";
    input.source.spans = [{ id: input.source.spans[0].id, excerpt: "Cowpea is planted first, maize follows after harvest, and cassava is planted in the final season." }];
    const result = validateVisualDirectorProposal({ result: "unsupported-visual-treatment", reason: "The lesson requires a chronological timeline that the current player does not implement.", requiredCapability: "timeline-sequence@1" }, input);
    expect(result).toMatchObject({ ok: true, status: "unsupported-visual-treatment" });
  });

  it("rejects invalid source claims, contradictory evidence, arithmetic, and evidence coverage", () => {
    const input = inputFor("math");
    const unsupported = proposalFor("math", input);
    unsupported.plan.learningOutcomes[0].evidence.quote = "A claim that does not appear in the source passage.";
    expect(validateVisualDirectorProposal(unsupported, input)).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: "grounding.quote" })]) });

    const arithmetic = proposalFor("math", input);
    const interaction = arithmetic.blueprint.scenes[0].interaction;
    if (interaction?.kind === "calculate" && interaction.answerSpec.operation === "two-set-cardinality") interaction.answerSpec.unionCount = 27;
    expect(validateVisualDirectorProposal(arithmetic, input)).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: "math.two-set-cardinality" })]) });

    const uncovered = proposalFor("math", input);
    uncovered.plan.scenes[0].narrationEvidence = [] as never;
    expect(validateVisualDirectorProposal(uncovered, input)).toMatchObject({ ok: false });

    const contradictoryInput = inputFor("process");
    contradictoryInput.source.spans[0].excerpt = "Coffee cherries are picked. Coffee cherries are not picked.";
    const contradictory = proposalFor("process", contradictoryInput);
    const spanId = contradictory.plan.learningOutcomes[0].evidence.spanId;
    contradictory.plan.learningOutcomes[0] = { id: "source-outcome", statement: "Coffee cherries are picked.", evidence: { spanId, quote: "Coffee cherries are picked." } };
    contradictory.plan.learningOutcomes.push({ id: "opposite", statement: "Coffee cherries are not picked.", evidence: { spanId, quote: "Coffee cherries are not picked." } });
    expect(validateVisualDirectorProposal(contradictory, contradictoryInput)).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: "grounding.contradictory-source" })]) });
  });

  it("sends bounded source, objective, capabilities and manifest ids through the structured provider path", async () => {
    const input = inputFor("process");
    let body: Record<string, unknown> = {};
    const result = await requestVisualDirectorStage({ kind: "visualPlan", directorInput: input, env: { ADEENA_EXPERIENCE_PROVIDER: "configured-provider", ADEENA_AI_EXECUTION_MODE: "free-development", ADEENA_RUNTIME: "nonproduction-test", ADEENA_GROQ_PLAN: "free", ADEENA_AI_MODEL: "openai/gpt-oss-120b", ADEENA_AI_API_URL: "https://api.groq.com/openai/v1/responses", ADEENA_GROQ_API_KEY: "test-key" }, fetchImpl: async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response("{}", { status: 503 }); } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(body)).toContain("Coffee preparation");
    expect(JSON.stringify(body)).toContain("process-pathway@1");
    expect(JSON.stringify(body)).toContain("opening");
    expect(JSON.stringify(body)).not.toContain("javascript:");
    expect(visualDirectorPayload(input).learningObjective).toBe(input.learningObjective);
  });

  it("requires every independent AI review check and no issues", () => {
    const pass = { sourceGrounded: true, relationshipsCorrect: true, animationMatchesNarration: true, practiceSupported: true, audienceSuitable: true, capabilitySupported: true, highRiskUncertainty: false, issues: [] };
    expect(visualReviewPasses(pass)).toBe(true);
    expect(visualReviewPasses({ ...pass, highRiskUncertainty: true })).toBe(false);
    expect(visualReviewPasses({ ...pass, issues: [{ code: "unsupported-claim", sceneId: "opening", reason: "Not in the source." }] })).toBe(false);
  });
});
