import { VisualSceneMappingV1 } from "./association";
import { validateVisualBlueprint } from "./schema";
import {
  InstructionalPlanV1,
  VisualDirectorProposalV1,
  type VisualDirectorInput,
  type VisualDirectorProposal,
  visualContext,
} from "./model-plan";

export type VisualDirectorDiagnostic = { code: string; path: Array<string | number>; message: string };
export type ValidatedVisualProposal =
  | { ok: true; status: "supported"; proposal: Extract<VisualDirectorProposal, { result: "supported" }>; context: ReturnType<typeof visualContext> }
  | { ok: true; status: "unsupported-visual-treatment"; proposal: Extract<VisualDirectorProposal, { result: "unsupported-visual-treatment" }> }
  | { ok: false; status: "rejected"; diagnostics: VisualDirectorDiagnostic[] };

const words = (value: string): string[] => value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const normalized = (value: string) => words(value).join(" ");

function contradictoryEvidence(quotes: string[]) {
  const signatures = new Map<string, boolean>();
  for (const quote of quotes) {
    const tokens = words(quote);
    const negative = tokens.includes("not") || tokens.includes("never") || tokens.includes("no");
    const signature = tokens.filter((token) => token !== "not" && token !== "never" && token !== "no" && token !== "does" && token !== "do" && token !== "is").join(" ");
    if (signature.length < 12) continue;
    const prior = signatures.get(signature);
    if (prior !== undefined && prior !== negative) return true;
    signatures.set(signature, negative);
  }
  return false;
}

function ageMismatch(ageBand: VisualDirectorInput["source"]["ageBand"], text: string) {
  if (ageBand !== "5-7" && ageBand !== "8-10") return false;
  const sentences = text.split(/[.!?]+/).map((item) => words(item).length).filter(Boolean);
  const limit = ageBand === "5-7" ? 14 : 20;
  return sentences.some((count) => count > limit) || words(text).some((word) => word.length > (ageBand === "5-7" ? 13 : 16));
}

function exactCoverage(actual: string[], declared: string[]) {
  return actual.length === declared.length && new Set(actual).size === actual.length && actual.every((id) => declared.includes(id));
}

export function validateVisualDirectorProposal(value: unknown, input: VisualDirectorInput): ValidatedVisualProposal {
  const parsed = VisualDirectorProposalV1.safeParse(value);
  if (!parsed.success) return { ok: false, status: "rejected", diagnostics: parsed.error.issues.slice(0, 24).map((issue) => ({ code: "proposal.schema", path: issue.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number"), message: issue.message })) };
  if (parsed.data.result === "unsupported-visual-treatment") {
    const requiredCapability = parsed.data.requiredCapability;
    if (input.implementedArchetypes.some((id) => id === requiredCapability)) return { ok: false, status: "rejected", diagnostics: [{ code: "capability.false-unsupported", path: ["requiredCapability"], message: "The requested capability is already implemented and cannot justify an unsupported result." }] };
    return { ok: true, status: parsed.data.result, proposal: parsed.data };
  }
  const proposal = parsed.data;
  const context = visualContext(input);
  const blueprint = validateVisualBlueprint(proposal.blueprint, context);
  const diagnostics: VisualDirectorDiagnostic[] = blueprint.ok ? [] : blueprint.diagnostics.map((item) => ({ ...item, path: item.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number") }));
  const plan = InstructionalPlanV1.parse(proposal.plan);
  const spanText = new Map(input.source.spans.map((span) => [span.id, normalized(span.excerpt)]));
  const outcomes = new Map(plan.learningOutcomes.map((outcome) => [outcome.id, outcome]));
  if (outcomes.size !== plan.learningOutcomes.length) diagnostics.push({ code: "plan.outcome-duplicate", path: ["plan", "learningOutcomes"], message: "Learning outcome ids must be unique." });
  for (const [index, outcome] of plan.learningOutcomes.entries()) {
    const source = spanText.get(outcome.evidence.spanId);
    if (!source || !source.includes(normalized(outcome.evidence.quote))) diagnostics.push({ code: "grounding.quote", path: ["plan", "learningOutcomes", index, "evidence"], message: "Evidence must be copied from the referenced source passage." });
    if (normalized(outcome.statement) !== normalized(outcome.evidence.quote)) diagnostics.push({ code: "grounding.claim", path: ["plan", "learningOutcomes", index, "statement"], message: "The machine-checked learning claim must exactly match its source evidence." });
  }
  if (contradictoryEvidence(plan.learningOutcomes.map((outcome) => outcome.evidence.quote))) diagnostics.push({ code: "grounding.contradictory-source", path: ["plan", "learningOutcomes"], message: "The selected evidence contains contradictory statements and needs review." });
  const scenePlans = new Map(plan.scenes.map((scene) => [scene.blueprintSceneId, scene]));
  if (scenePlans.size !== plan.scenes.length || !exactCoverage(proposal.blueprint.scenes.map((scene) => scene.id), plan.scenes.map((scene) => scene.blueprintSceneId))) diagnostics.push({ code: "plan.scene-coverage", path: ["plan", "scenes"], message: "Every blueprint scene needs exactly one instructional-plan entry." });
  for (const [sceneIndex, scene] of proposal.blueprint.scenes.entries()) {
    const planned = scenePlans.get(scene.id);
    if (!planned) continue;
    if (scene.archetype !== plan.visualTreatment) diagnostics.push({ code: "plan.archetype", path: ["blueprint", "scenes", sceneIndex, "archetype"], message: "The blueprint archetype differs from the planned treatment." });
    const outcomeIds = new Set(planned.outcomeIds);
    const evidenceLists = [planned.objectEvidence, planned.cueEvidence, planned.narrationEvidence, ...(planned.interactionEvidence ? [[planned.interactionEvidence]] : [])];
    for (const evidence of evidenceLists.flat()) for (const outcomeId of evidence.outcomeIds) if (!outcomes.has(outcomeId) || !outcomeIds.has(outcomeId)) diagnostics.push({ code: "grounding.element", path: ["plan", "scenes", sceneIndex], message: "A scene element points to evidence outside its declared learning outcomes." });
    for (const id of outcomeIds) if (!outcomes.has(id)) diagnostics.push({ code: "grounding.outcome", path: ["plan", "scenes", sceneIndex, "outcomeIds"], message: "A scene references an unknown learning outcome." });
    const objectIds = scene.visualObjects.filter((item) => item.role !== "decorative").map((item) => item.id);
    if (!exactCoverage(objectIds, planned.objectEvidence.map((item) => item.elementId))) diagnostics.push({ code: "grounding.object-coverage", path: ["plan", "scenes", sceneIndex, "objectEvidence"], message: "Every educational visual object needs evidence." });
    if (!exactCoverage(scene.cues.map((item) => item.id), planned.cueEvidence.map((item) => item.elementId))) diagnostics.push({ code: "grounding.cue-coverage", path: ["plan", "scenes", sceneIndex, "cueEvidence"], message: "Every animation cue needs evidence." });
    if (!exactCoverage(scene.narration.map((item) => item.id), planned.narrationEvidence.map((item) => item.elementId))) diagnostics.push({ code: "grounding.narration-coverage", path: ["plan", "scenes", sceneIndex, "narrationEvidence"], message: "Every narration segment needs evidence." });
    if ((scene.interaction?.id ?? null) !== (planned.interactionEvidence?.elementId ?? null)) diagnostics.push({ code: "grounding.practice-coverage", path: ["plan", "scenes", sceneIndex, "interactionEvidence"], message: "Practice must be explicitly tied to source evidence." });
    for (const narration of scene.narration) if (ageMismatch(input.source.ageBand, narration.text)) diagnostics.push({ code: "audience.language", path: ["blueprint", "scenes", sceneIndex, "narration"], message: "Narration sentence length does not match the selected young age band." });
  }
  const mapping = VisualSceneMappingV1.safeParse(proposal.mapping);
  if (!mapping.success || mapping.data.legacyExperienceId !== input.manifest.experienceId) diagnostics.push({ code: "mapping.invalid", path: ["mapping"], message: "The visual proposal is not mapped to this manifest." });
  else {
    const visualScenes = new Set(proposal.blueprint.scenes.map((scene) => scene.id));
    const legacyScenes = new Map(input.manifest.scenes.map((scene) => [scene.id, scene]));
    if (mapping.data.scenes.length !== visualScenes.size || mapping.data.scenes.some((item) => !visualScenes.has(item.visualSceneId) || !legacyScenes.has(item.legacySceneId))) diagnostics.push({ code: "mapping.scene", path: ["mapping", "scenes"], message: "Every visual scene must map to a real manifest scene." });
    for (const item of mapping.data.choices) {
      const sceneMap = mapping.data.scenes.find((entry) => entry.visualSceneId === item.visualSceneId);
      const legacy = sceneMap ? legacyScenes.get(sceneMap.legacySceneId) : null;
      if (!legacy || legacy.role !== "dialogue" || !legacy.choices.some((choice) => choice.id === item.legacyChoiceId)) diagnostics.push({ code: "mapping.choice", path: ["mapping", "choices"], message: "A visual choice is not mapped to a real choice in its manifest scene." });
    }
    const visualChoices = proposal.blueprint.scenes.flatMap((scene) => scene.cues.flatMap((cue) => cue.trigger.kind === "choice-applied" ? [`${scene.id}:${cue.trigger.choiceId}`] : []));
    const mappedChoices = mapping.data.choices.map((item) => `${item.visualSceneId}:${item.visualChoiceId}`);
    if (!exactCoverage(visualChoices, mappedChoices)) diagnostics.push({ code: "mapping.choice-coverage", path: ["mapping", "choices"], message: "Every visual choice cue needs exactly one real manifest-choice mapping." });
  }
  return diagnostics.length ? { ok: false, status: "rejected", diagnostics } : { ok: true, status: "supported", proposal, context };
}
