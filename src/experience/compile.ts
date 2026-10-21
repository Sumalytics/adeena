import { randomUUID } from "node:crypto";
import {
  MECHANIC_ID,
  SCHEMA_ID,
  SCHEMA_VERSION,
  parseManifest,
  type ExperienceManifest,
} from "@adeena/experience-schema";
import { AgeBand } from "@/contracts/common";
import { limitedSensitivityMatch } from "@/topic/analyze";
import { collapsed, groundFacts } from "./ground";
import { ExperiencePlanV1, type ExperiencePlan } from "./plan";
import { COMPILER_VERSION, PROMPT_VERSION } from "./provider";
import { simulateExperience, type SimulationReport } from "./simulate";

const Executable = /<script|javascript:|\beval\s*\(|\bnew\s+Function\b/i;

export type GenerationSource = {
  documentVersionId: string;
  topicTitle: string;
  audienceLabel: string;
  ageBand: AgeBand;
  spans: { id: string; excerpt: string }[];
  experienceId: string;
  versionId: string;
};

export type Compilation =
  | { ok: true; plan: ExperiencePlan; manifest: ExperienceManifest; simulation: SimulationReport }
  | {
      ok: false;
      code: "insufficient-source" | "invalid-experience" | "review-required";
      diagnostics: { code: string; message: string }[];
      simulation: { ok: false };
    };

export function compileExperiencePlan(source: GenerationSource): Compilation {
  const blocked = [source.topicTitle, ...source.spans.map((span) => span.excerpt)].some((value) => limitedSensitivityMatch(value));
  if (blocked) {
    return {
      ok: false,
      code: "review-required",
      diagnostics: [{ code: "safety.review-required", message: "The limited sensitivity screen needs a person to review this source." }],
      simulation: { ok: false },
    };
  }
  const plan = planFromSource(source);
  if (!plan) {
    return {
      ok: false,
      code: "insufficient-source",
      diagnostics: [{ code: "source.insufficient", message: "No source span was long enough to support a choice." }],
      simulation: { ok: false },
    };
  }
  const parsed = ExperiencePlanV1.safeParse(plan);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid-experience",
      diagnostics: [{ code: "plan.invalid", message: "The experience plan did not match the compiler contract." }],
      simulation: { ok: false },
    };
  }
  const grounding = groundFacts(parsed.data.facts, source.spans);
  if (grounding.length > 0) {
    return { ok: false, code: "invalid-experience", diagnostics: grounding, simulation: { ok: false } };
  }
  const structure = structureDiagnostics(parsed.data);
  if (structure.length > 0) {
    return { ok: false, code: "invalid-experience", diagnostics: structure, simulation: { ok: false } };
  }
  const manifest = manifestFromPlan(parsed.data, source);
  const validated = parseManifest(manifest);
  if (!validated.ok) {
    return {
      ok: false,
      code: "invalid-experience",
      diagnostics: validated.diagnostics.slice(0, 8).map((item) => ({ code: item.code, message: "Manifest validation failed." })),
      simulation: { ok: false },
    };
  }
  const simulated = simulateExperience(validated.manifest);
  if (!simulated.ok) {
    return {
      ok: false,
      code: "invalid-experience",
      diagnostics: [{ code: simulated.code, message: "Gameplay simulation failed." }],
      simulation: { ok: false },
    };
  }
  return { ok: true, plan: parsed.data, manifest: validated.manifest, simulation: simulated.report };
}

function planFromSource(source: GenerationSource): ExperiencePlan | null {
  const title = collapsed(source.topicTitle).slice(0, 60);
  if (title.length < 2 || Executable.test(title)) return null;
  const span = [...source.spans]
    .map((item) => ({ ...item, text: collapsed(item.excerpt) }))
    .filter((item) => item.text.length >= 80 && !Executable.test(item.text))
    .sort((a, b) => b.text.length - a.text.length)[0];
  if (!span) return null;
  const claim = span.text.slice(0, 120).replace(/\s+\S*$/, "").trim();
  if (claim.length < 40 || !span.text.toLowerCase().includes(claim.toLowerCase())) return null;
  const goal = source.ageBand === "5-7" || source.ageBand === "8-10"
    ? "Your goal is to use the source note."
    : "Your goal is to decide using only the source note.";
  const opening = `This practice room is fictional. The source does not describe this room. ${goal} The note is titled “${title}”.`;
  const decision = `The source note says: “${claim}”. The guide is fictional and asks what you will do next.`;
  const applied = `You stayed with the source note. It says: “${claim}”. The practice room was fictional.`;
  const revisit = "You set the source note aside. A replacement detail was not in the source. The practice room was fictional. Play again to use the note.";
  return {
    contract: "EXPERIENCE-PLAN-v1",
    compilerVersion: COMPILER_VERSION,
    promptVersion: PROMPT_VERSION,
    topicTitle: title,
    audienceLabel: source.audienceLabel,
    ageBand: source.ageBand,
    learnerObjective: goal,
    setting: { kind: "fictional", label: "A fictional practice room" },
    facts: [{ kind: "source", claim, spanId: span.id }],
    fictionalElements: ["practice room", "guide"],
    gameplayObjective: "Choose whether to keep the source wording.",
    progression: [
      {
        id: "opening",
        role: "dialogue",
        title: "A fictional practice",
        text: opening,
        choices: [
          { id: "read-note", text: "Read the source note", nextSceneId: "decision", understanding: 1 },
          { id: "set-aside", text: "Set the source note aside", nextSceneId: "ending-revisit", understanding: 0 },
        ],
      },
      {
        id: "decision",
        role: "dialogue",
        title: "The source note",
        text: decision,
        choices: [
          { id: "keep-note", text: "Keep the source wording", nextSceneId: "ending-applied", understanding: 2 },
          { id: "replace-note", text: "Replace it with a new claim", nextSceneId: "ending-revisit", understanding: 0 },
        ],
      },
      { id: "ending-applied", role: "ending", title: "Note kept", text: applied },
      { id: "ending-revisit", role: "ending", title: "Note set aside", text: revisit },
    ],
    stateVariables: [{ id: "understanding", initial: 0, min: 0, max: 2 }],
    sourceReferences: [{ documentVersionId: source.documentVersionId, spanId: span.id }],
    accessibility: ["Text stays on the screen.", "Choices are buttons."],
    visualTreatment: "existing-fallback-scene",
  };
}

function structureDiagnostics(plan: ExperiencePlan) {
  const diagnostics: { code: string; message: string }[] = [];
  const ids = new Set(plan.progression.map((scene) => scene.id));
  if (ids.size !== plan.progression.length) {
    diagnostics.push({ code: "scene.duplicate", message: "Scene ids must be unique." });
  }
  const opening = plan.progression[0];
  if (!opening || opening.role !== "dialogue" || !opening.text.includes("fictional")) {
    diagnostics.push({ code: "setting.unlabeled", message: "An invented setting must be labeled as fictional." });
  }
  const endings = plan.progression.filter((scene) => scene.role === "ending");
  if (endings.length < 2) diagnostics.push({ code: "ending.missing", message: "The plan needs two endings." });
  for (const scene of plan.progression) {
    if (scene.role !== "dialogue") continue;
    const targets = new Set(scene.choices.map((choice) => choice.nextSceneId));
    if (targets.size < 2) diagnostics.push({ code: "choice.same-target", message: "Choices need different results." });
    for (const choice of scene.choices) {
      if (!ids.has(choice.nextSceneId)) diagnostics.push({ code: "scene.transition-missing", message: "A choice target is missing." });
    }
  }
  const sceneText = plan.progression.map((scene) => scene.text).join("\n");
  for (const fact of plan.facts) {
    if (!sceneText.includes(fact.claim)) {
      diagnostics.push({ code: "grounding.claim-omitted", message: "A source claim is missing from the scenes." });
    }
  }
  return diagnostics;
}

function manifestFromPlan(plan: ExperiencePlan, source: GenerationSource): unknown {
  const locator = `synthetic:doc-${source.documentVersionId}`;
  const claim = plan.facts[0]?.claim ?? "";
  return {
    schema: SCHEMA_ID,
    schemaVersion: SCHEMA_VERSION,
    experienceId: source.experienceId,
    versionId: source.versionId,
    title: `Practice: ${plan.topicTitle}`.slice(0, 120),
    locale: "en",
    mechanics: [MECHANIC_ID],
    initialSceneId: plan.progression[0]?.id ?? "opening",
    scenes: plan.progression.map((scene) => scene.role === "ending"
      ? { id: scene.id, role: "ending", title: scene.title, text: scene.text, assetIds: ["note"], required: true }
      : {
          id: scene.id,
          role: "dialogue",
          title: scene.title,
          text: scene.text,
          assetIds: ["note"],
          required: true,
          choices: scene.choices.map((choice) => ({
            id: choice.id,
            text: choice.text,
            effects: [{ type: "set", variableId: "understanding", value: choice.understanding }],
            nextSceneId: choice.nextSceneId,
          })),
        }),
    state: { variables: plan.stateVariables.map((variable) => ({ ...variable, type: "integer" })) },
    assets: [{ id: "note", kind: "text", locator: "synthetic:source-note" }],
    sources: [{ sourceId: source.documentVersionId, locator, note: `Source note: ${claim}`.slice(0, 300) }],
    events: { schemaVersion: "1" },
    accessibility: { textAlternative: "provided", motion: "none" },
    runtime: {
      compatibility: "adeena.experience-runtime@1",
      profile: "lightweight",
      requiresLlm: false,
      executableScripts: false,
    },
  };
}

export function newExperienceIds() {
  return { experienceId: randomUUID(), versionId: randomUUID() };
}
