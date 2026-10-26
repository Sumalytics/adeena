import { ModelPlan } from "./model-plan";

/** Converts an existing authored test specimen to provider-facing slots; never used by production generation. */
export function authoredPlanFixture(input: unknown, sourceSpanId?: string) {
  const plan = ModelPlan.parse(input);
  const [opening, afterA, afterB, endingAA, endingAB, endingBA, endingBB] = plan.progression;
  if (plan.progression.length !== 7 || opening.role !== "dialogue" || afterA.role !== "dialogue"
    || afterB.role !== "dialogue" || endingAA.role !== "ending" || endingAB.role !== "ending"
    || endingBA.role !== "ending" || endingBB.role !== "ending") throw new Error("Expected seven-scene specimen");
  const evidenceSpanId = sourceSpanId ?? plan.facts[0].spanId;
  const decision = (scene: typeof opening) => {
    if (scene.role !== "dialogue" || scene.choices.length !== 2) throw new Error("Expected two-choice decision");
    return { title: scene.title, text: scene.text, evidenceSpanId,
      choiceA: { text: scene.choices[0].text, understanding: scene.choices[0].understanding, evidenceSpanId },
      choiceB: { text: scene.choices[1].text, understanding: scene.choices[1].understanding, evidenceSpanId } };
  };
  const ending = (scene: typeof endingAA) => ({ title: scene.title, text: scene.text, evidenceSpanId });
  const { facts } = plan;
  const rest = { learnerObjective: plan.learnerObjective, setting: plan.setting,
    fictionalElements: plan.fictionalElements, gameplayObjective: plan.gameplayObjective };
  return { ...rest, facts, instructionallyInsufficient: false, insufficiencyReason: null,
    scenes: { opening: decision(opening), afterA: decision(afterA), afterB: decision(afterB),
      endingAA: ending(endingAA), endingAB: ending(endingAB), endingBA: ending(endingBA), endingBB: ending(endingBB) } };
}

export function groqAuthoredPlanFixture(input: unknown, sourceSpanId?: string) {
  const { facts, ...rest } = authoredPlanFixture(input, sourceSpanId);
  if (facts.length < 2) throw new Error("Two facts required for Groq test transport");
  return { ...rest, fact1: facts[0], fact2: facts[1], fact3: facts[2] ?? null, fact4: facts[3] ?? null };
}
