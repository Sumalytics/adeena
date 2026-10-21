import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseManifest, type ExperienceManifest } from "@adeena/experience-schema";
import { simulateExperience } from "./simulate";

const Executable = /<script|javascript:|\beval\s*\(|\bnew\s+Function\b/i;
const SceneId = z.string().trim().regex(/^[a-z][a-z0-9-]{0,40}$/);
const Uuid = z.string().uuid();

export const EDIT_POLICY_VERSION = "1" as const;
export const EDIT_PROMPT_VERSION = "fixture-edit@1" as const;
export const MODEL_EDIT_PROMPT_VERSION = "model-edit@1" as const;
export const EDIT_MODEL_INSTRUCTIONS = [
  "You edit one existing branching-dialogue draft.",
  "Return one JSON object as the assistant message, with no markdown fence.",
  "Use only rewrite-text, revise-choice, retarget-choice, insert-decision, and set-presentation.",
  "factualChange and objectiveChange must be false.",
  "Do not add facts, scripts, HTML, links, or new mechanics.",
  "Keep every quoted source note, the learning objective, and the word fictional.",
  "A new scene must say that the guide is fictional.",
].join(" ");
export const GROQ_DIALOGUE_INSTRUCTIONS = [
  "You replace one editable dialogue passage in an existing draft.",
  "Return one JSON object as the assistant message, with no markdown fence.",
  "The object contains sceneId and text, or sceneId and parts when more than one passage is supplied.",
  "Return only the replacement for the editable passage.",
  "Do not add facts, scripts, HTML, links, choices, or a learning objective.",
].join(" ");
export const GROQ_GRAPH_INSTRUCTIONS = [
  "You retarget one existing choice.",
  "Return one JSON object with sceneId, choiceId, and nextSceneId.",
  "Do not rewrite dialogue, facts, or the learning objective.",
].join(" ");
export const EDIT_ALTERNATIVES = [
  "Simplify the dialogue.",
  "Add one decision before the final scene.",
  "Explain a wrong choice before the draft ends.",
] as const;

function prose(max: number) {
  return z.string().trim().min(1).max(max).refine((value) => !Executable.test(value), "content.executable");
}

export const ExperienceEditRequestV1 = z.object({
  contract: z.literal("EXPERIENCE-EDIT-REQUEST-v1"),
  workspaceId: Uuid,
  baseVersionId: Uuid,
  expectedBaseVersionId: Uuid,
  instruction: prose(500),
  sceneId: SceneId.optional(),
  idempotencyKey: Uuid,
  editPolicyVersion: z.literal(EDIT_POLICY_VERSION),
  authorizeEdit: z.literal(true),
}).strict();

const RewriteText = z.object({ op: z.literal("rewrite-text"), sceneId: SceneId, text: prose(400) }).strict();
const ReviseChoice = z.object({
  op: z.literal("revise-choice"),
  sceneId: SceneId,
  choiceId: SceneId,
  text: prose(200),
}).strict();
const RetargetChoice = z.object({
  op: z.literal("retarget-choice"),
  sceneId: SceneId,
  choiceId: SceneId,
  nextSceneId: SceneId,
}).strict();
const InsertDecision = z.object({
  op: z.literal("insert-decision"),
  sceneId: SceneId,
  title: prose(80),
  text: prose(400),
  choices: z.array(z.object({
    id: SceneId,
    text: prose(200),
    nextSceneId: SceneId,
    understanding: z.number().int().min(0).max(2),
  }).strict()).length(2),
}).strict();
const SetPresentation = z.object({
  op: z.literal("set-presentation"),
  sceneId: SceneId,
  title: prose(80),
}).strict();

export const ExperiencePatchOperationV1 = z.discriminatedUnion("op", [
  RewriteText,
  ReviseChoice,
  RetargetChoice,
  InsertDecision,
  SetPresentation,
]);

export const ExperiencePatchV1 = z.object({
  contract: z.literal("EXPERIENCE-PATCH-v1"),
  operations: z.array(ExperiencePatchOperationV1).min(1).max(8),
}).strict();

export const ExperienceEditPlanV1 = z.object({
  contract: z.literal("EXPERIENCE-EDIT-PLAN-v1"),
  editPolicyVersion: z.literal(EDIT_POLICY_VERSION),
  promptVersion: z.enum([EDIT_PROMPT_VERSION, MODEL_EDIT_PROMPT_VERSION]),
  intent: prose(200),
  scope: z.enum(["scene", "experience"]),
  gameplayChange: z.boolean(),
  factualChange: z.literal(false),
  objectiveChange: z.literal(false),
  uncertainty: prose(300).nullable(),
  reviewRequirements: z.array(prose(160)).max(4),
  preserved: z.array(prose(160)).min(1).max(8),
  summary: prose(300),
}).strict();

export const ExperienceEditValidationV1 = z.object({
  contract: z.literal("EXPERIENCE-EDIT-VALIDATION-v1"),
  ok: z.boolean(),
  diagnostics: z.array(z.object({ code: z.string().max(80), message: prose(200) }).strict()).max(8),
  simulation: z.union([
    z.object({ ok: z.literal(true), endingSceneIds: z.array(SceneId).max(8), replayReset: z.literal(true) }).strict(),
    z.object({ ok: z.literal(false) }).strict(),
  ]),
  scenesTouched: z.number().int().min(0).max(16),
  choicesChanged: z.number().int().min(0).max(64),
  nodesAdded: z.number().int().min(0).max(16),
  graphChanged: z.boolean(),
  factualChange: z.literal(false),
}).strict();

export const ExperienceRevisionV1 = z.object({
  contract: z.literal("EXPERIENCE-REVISION-v1"),
  versionId: Uuid,
  parentVersionId: Uuid,
  experienceId: Uuid,
  publicationStatus: z.literal("unpublished"),
}).strict();

export const ExperienceEditAuditEventV1 = z.object({
  contract: z.literal("EXPERIENCE-EDIT-AUDIT-v1"),
  kind: z.enum(["requested", "planning", "proposed", "validating", "ready", "accepted", "rejected", "failed", "expired"]),
  summary: prose(300),
}).strict();

export type ExperienceEditRequest = z.infer<typeof ExperienceEditRequestV1>;
export type ExperiencePatch = z.infer<typeof ExperiencePatchV1>;
export type ExperienceEditPlan = z.infer<typeof ExperienceEditPlanV1>;
export type ExperienceEditValidation = z.infer<typeof ExperienceEditValidationV1>;

export type CreatorEditProposal = {
  editJobId: string;
  status: "ready";
  baseVersionId: string;
  proposedVersionId: string;
  summary: string;
  graphChanged: boolean;
  uncertainty: string | null;
  reviewNote: string | null;
  scenesTouched: number;
  choicesChanged: number;
  previewPath: string;
  liveModel: boolean;
  publicationStatus: "unpublished";
  provider: "deterministic-fixture" | "configured-provider";
  usage: {
    kind: "none" | "estimate" | "actual";
    currency: "USD";
    actualCostMicros: number;
    estimatedCostMicros: number;
    callCount: number;
    inputTokens: number;
    outputTokens: number;
  };
  replayed: boolean;
};

export type ExperienceRevisionItem = {
  id: string;
  title: string;
  current: boolean;
  summary: string | null;
  kind: "original" | "revision";
};

const PRESERVED = [
  "Experience ownership stays with this workspace.",
  "Source references stay in place.",
  "The learning objective stays in place.",
  "Unmodified scenes and choices stay in place.",
] as const;

const Medical = /\b(surgical|surgery|dosage|diagnosis|prescription|vaccine)\b/i;
const Flip = /change the answer|option a is correct|make option|change the facts so|wrong answer becomes correct/i
const Provenance = /remove (the )?source|drop (the )?provenance|make it public|\bpublish\b|public link/i;
const ObjectiveRewrite = /\b(change|replace|drop|remove)\b[^.]*\b(learning objective|goal)\b/i;
const Decision = /meaningful decision|before the final|two different ways|increase the difficulty|another way/i;
const Feedback = /useful feedback|wrong decision|consequence/i;
const Ambiguous = /make (this|it) better|improve this\b/i;
const ShortenIntro = /shorten the introduction|shorten the intro/i;
const Classroom = /ghana|classroom/i;
const TitleChange = /change the title|visual theme|scene presentation/i;
const Simplify = /simplify|shorten|easier|engaging|12-year|twelve-year|young children|tone|pacing|natural/i;
const ChoiceWording = /choice wording|reword the choices/i;

export type EditRefusal = {
  ok: false;
  code: "unsupported-edit" | "review-required" | "invalid-experience" | "invalid-edit";
  alternatives: string[];
  diagnostic?: string;
};

export type RevisionResult =
  | {
      ok: true;
      manifest: ExperienceManifest;
      plan: ExperienceEditPlan;
      patch: ExperiencePatch;
      validation: ExperienceEditValidation;
    }
  | EditRefusal;

export function reviseManifest(
  manifest: ExperienceManifest,
  instruction: string,
  sceneId: string | undefined,
  nextVersionId: string,
): RevisionResult {
  const interpreted = interpretEdit(manifest, instruction, sceneId);
  if (!interpreted.ok) return interpreted;
  return applyPatch(manifest, interpreted, nextVersionId);
}

export function screenEditInstruction(manifest: ExperienceManifest, instruction: string, sceneId: string | undefined): EditRefusal | { ok: true } {
  const text = instruction.trim();
  if (sceneId && !manifest.scenes.some((scene) => scene.id === sceneId)) return refuse("invalid-edit");
  if (Executable.test(text)) return refuse("unsupported-edit");
  if (Medical.test(text)) return refuse("review-required");
  if (Flip.test(text) || ObjectiveRewrite.test(text) || Provenance.test(text)) return refuse("unsupported-edit");
  return { ok: true };
}

const ObjectiveSentence = /\b(goal|objective)\b/i;
const CleanObjective = /^(your |the )?(learning )?(goal|objective)\b/i;
const QuotedClaim = /“[^”]+”/;
const FictionalSentence = /\bfictional\b/i;

export type DialogueTarget = {
  sceneId: string;
  editableParts: string[];
  protectedSpans: string[];
  restore: (parts: string[]) => { ok: true; text: string } | { ok: false; diagnostic: string };
};

export function prepareDialogueTarget(manifest: ExperienceManifest, sceneId: string | undefined): { ok: true; target: DialogueTarget } | { ok: false; diagnostic: string } {
  const scene = sceneId
    ? manifest.scenes.find((item) => item.id === sceneId)
    : manifest.scenes.find((item) => item.role === "dialogue");
  if (!scene) return { ok: false, diagnostic: "protection.scene" };
  const sentences = scene.text.split(/(?<=\.)\s/).map((sentence) => sentence.trim()).filter(Boolean);
  if (sentences.length === 0) return { ok: false, diagnostic: "protection.no-editable-text" };
  const fused = sentences.some((sentence) => ObjectiveSentence.test(sentence) && !CleanObjective.test(sentence));
  const editable = sentences.filter((sentence) => sentenceKind(sentence) === "editable");
  if (fused && editable.length === 0) return { ok: false, diagnostic: "protection.unseparable" };
  if (editable.length === 0) return { ok: false, diagnostic: "protection.no-editable-text" };
  const groups: { kind: "protected" | "editable"; text: string }[] = [];
  for (const sentence of sentences) {
    const kind = sentenceKind(sentence) === "editable" ? "editable" : "protected";
    const last = groups[groups.length - 1];
    if (last?.kind === kind) last.text = `${last.text} ${sentence}`;
    else groups.push({ kind, text: sentence });
  }
  const editableParts = groups.filter((group) => group.kind === "editable").map((group) => group.text);
  const protectedSpans = groups.filter((group) => group.kind === "protected").map((group) => group.text);
  return {
    ok: true,
    target: {
      sceneId: scene.id,
      editableParts,
      protectedSpans,
      restore(parts: string[]) {
        if (parts.length !== editableParts.length) return { ok: false, diagnostic: "protection.segment-count" };
        let index = 0;
        const next = groups.map((group) => {
          if (group.kind === "protected") return group.text;
          const replacement = parts[index] ?? "";
          const original = editableParts[index] ?? "";
          index += 1;
          const checked = checkEditableReplacement(original, replacement);
          if (!checked.ok) return checked;
          return checked.text;
        });
        const refused = next.find((item) => typeof item !== "string") as { ok: false; diagnostic: string } | undefined;
        if (refused) return refused;
        if (parts.every((part, partIndex) => part.trim() === editableParts[partIndex])) return { ok: false, diagnostic: "protection.unchanged" };
        return { ok: true, text: next.join(" ") };
      },
    },
  };
}

function sentenceKind(sentence: string) {
  if (ObjectiveSentence.test(sentence) || /[“”]/.test(sentence) || FictionalSentence.test(sentence)) return "protected";
  return "editable";
}

function checkEditableReplacement(original: string, replacement: string) {
  const text = replacement.trim();
  if (!text) return { ok: false as const, diagnostic: "protection.empty-text" };
  if (Executable.test(text)) return { ok: false as const, diagnostic: "content.executable" };
  if (/private:\/\/|https?:\/\//i.test(text)) return { ok: false as const, diagnostic: "model.locator" };
  if (/[“”]/.test(text) && !QuotedClaim.test(original)) return { ok: false as const, diagnostic: "grounding.quote" };
  if (ObjectiveSentence.test(text) && !ObjectiveSentence.test(original)) return { ok: false as const, diagnostic: "protection.objective" };
  for (const quote of [...text.matchAll(/“([^”]+)”/g)].map((match) => match[1] ?? "")) {
    if (quote && !original.includes(quote)) return { ok: false as const, diagnostic: "grounding.quote" };
  }
  return { ok: true as const, text };
}

export function groqEditKind(instruction: string) {
  if (/\b(retarget|add a decision|new decision|change the transition|change the path)\b/i.test(instruction)) return "graph" as const;
  return "dialogue" as const;
}

export function graphEditContext(manifest: ExperienceManifest, instruction: string, audience?: { label: string; ageBand: string }) {
  const scenes = manifest.scenes.map((scene) => scene.role === "dialogue"
    ? { id: scene.id, choiceIds: scene.choices.map((choice) => choice.id) }
    : { id: scene.id, choiceIds: [] as string[] });
  return JSON.stringify({ instruction, audience: audience ?? null, permittedOperation: "retarget-choice", scenes });
}

export function dialogueEditContext(instruction: string, target: DialogueTarget, audience?: { label: string; ageBand: string }) {
  return JSON.stringify({
    instruction,
    sceneId: target.sceneId,
    audience: audience ?? null,
    permittedOperation: "rewrite-editable-text",
    editableText: target.editableParts,
  });
}

export function editModelContext(manifest: ExperienceManifest, instruction: string, sceneId: string | undefined) {
  const scenes = manifest.scenes.map((scene) => scene.role === "ending"
    ? { id: scene.id, role: scene.role, title: scene.title, text: scene.text }
    : {
        id: scene.id,
        role: scene.role,
        title: scene.title,
        text: scene.text,
        choices: scene.choices.map((choice) => ({ id: choice.id, text: choice.text, nextSceneId: choice.nextSceneId })),
      });
  const sources = manifest.sources.map((source) => ({
    sourceId: source.sourceId,
    locator: source.locator.startsWith("synthetic:") ? source.locator : "omitted",
    note: source.note,
  }));
  return JSON.stringify({ instruction, sceneId: sceneId ?? null, title: manifest.title, scenes, sources });
}

const ModelEditOutput = z.object({
  intent: prose(200),
  scope: z.enum(["scene", "experience"]),
  gameplayChange: z.boolean(),
  factualChange: z.literal(false),
  objectiveChange: z.literal(false),
  uncertainty: prose(300).nullable(),
  reviewRequirements: z.array(prose(160)).max(4),
  operations: z.array(ExperiencePatchOperationV1).min(1).max(8),
}).strict();

type EditIssue = {
  code?: string;
  path: PropertyKey[];
  expected?: unknown;
  maximum?: number | bigint;
  minimum?: number | bigint;
  format?: unknown;
  values?: unknown;
  input?: unknown;
  keys?: string[];
  errors?: unknown;
};

export function describeEditIssue(issue: EditIssue | undefined): string {
  const leaf = issue ? leafIssue(issue) : undefined;
  if (!leaf) return "model.output";
  const path = leaf.path.length > 0 ? leaf.path.map(String).join(".") : "root";
  const code = leaf.code ?? "invalid";
  let expected = code;
  if (typeof leaf.expected === "string") expected = leaf.expected;
  else if (typeof leaf.maximum === "number") expected = `max_${leaf.maximum}`;
  else if (typeof leaf.minimum === "number") expected = `min_${leaf.minimum}`;
  else if (typeof leaf.format === "string") expected = leaf.format;
  else if (Array.isArray(leaf.values)) {
    const names = leaf.values.filter((value): value is string => typeof value === "string" && /^[a-z0-9_-]{1,40}$/i.test(value));
    if (names.length > 0) expected = names.join("|");
  } else if (leaf.code === "unrecognized_keys" && Array.isArray(leaf.keys)) {
    const names = leaf.keys.filter((key) => /^[a-z0-9_-]{1,40}$/i.test(key));
    if (names.length > 0) expected = names.join("|");
  }
  const actual = receivedType(leaf.input);
  return `${path}:${code}:expected_${expected}:actual_${actual}`.replace(/[^a-z0-9._:()|-]/gi, "").slice(0, 120);
}

function leafIssue(issue: EditIssue): EditIssue {
  if (issue.code === "invalid_union" && Array.isArray(issue.errors)) {
    const group = issue.errors.find((entry) => Array.isArray(entry) && entry.length > 0);
    const nested = Array.isArray(group) ? asEditIssue(group[0]) : undefined;
    if (nested) {
      const child = leafIssue(nested);
      return { ...child, path: [...issue.path, ...child.path] };
    }
  }
  return issue;
}

function asEditIssue(value: unknown): EditIssue | undefined {
  if (!value || typeof value !== "object" || !("path" in value) || !Array.isArray(value.path)) return undefined;
  return value as EditIssue;
}

function receivedType(input: unknown) {
  if (typeof input === "string") return /^[a-z0-9_-]{1,40}$/i.test(input) ? input : `string(${input.length})`;
  if (typeof input === "number" || typeof input === "boolean") return String(input);
  if (input === null) return "null";
  if (input === undefined) return "undefined";
  if (Array.isArray(input)) return `array(${input.length})`;
  return typeof input;
}

export function parseModelEdit(raw: unknown) {
  const parsed = ModelEditOutput.safeParse(raw);
  if (!parsed.success) return { ok: false as const, diagnostic: describeEditIssue(parsed.error.issues[0]) };
  return { ok: true as const, edit: parsed.data };
}

export function applyModelOutput(
  manifest: ExperienceManifest,
  instruction: string,
  raw: unknown,
  nextVersionId: string,
  sceneId: string | undefined,
): RevisionResult {
  const screened = screenEditInstruction(manifest, instruction, sceneId);
  if (!screened.ok) return screened;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return failedValidation("model.output", "The model output was not an edit.");
  const record = raw as Record<string, unknown>;
  if (record.factualChange !== false || record.objectiveChange !== false) return refuse("unsupported-edit");
  const parsed = parseModelEdit(record);
  if (!parsed.ok) return failedValidation(parsed.diagnostic, "The model output did not match the edit contract.");
  const original = JSON.stringify(manifest);
  if (/private:\/\/|https?:\/\//i.test(JSON.stringify(parsed.edit.operations))) return failedValidation("model.locator", "The model output included a link.");
  for (const operation of parsed.edit.operations) {
    for (const quote of operationText(operation).flatMap((text) => [...text.matchAll(/“([^”]+)”/g)].map((match) => match[1]))) {
      if (!original.includes(quote)) return failedValidation("grounding.quote", "A new quoted claim was not in the draft.");
    }
  }
  const patch = ExperiencePatchV1.safeParse({ contract: "EXPERIENCE-PATCH-v1", operations: parsed.edit.operations });
  if (!patch.success) return failedValidation(describeEditIssue(patch.error.issues[0]), "A requested change did not fit this draft.");
  const reviewRequirements = [...parsed.edit.reviewRequirements];
  if (reviewRequirements.length < 4 && unlabeledAddition(manifest, patch.data)) {
    reviewRequirements.push("A person should check wording that was not in the original draft.");
  }
  return applyPatch(manifest, { ...parsed.edit, reviewRequirements, patch: patch.data }, nextVersionId, MODEL_EDIT_PROMPT_VERSION);
}

function operationText(operation: ExperiencePatch["operations"][number]) {
  if (operation.op === "rewrite-text" || operation.op === "set-presentation") return [operation.op === "rewrite-text" ? operation.text : operation.title];
  if (operation.op === "revise-choice") return [operation.text];
  if (operation.op === "insert-decision") return [operation.title, operation.text, ...operation.choices.map((choice) => choice.text)];
  return [];
}

function unlabeledAddition(manifest: ExperienceManifest, patch: ExperiencePatch) {
  const original = manifest.scenes.map((scene) => `${scene.title}\n${scene.text}`).join("\n");
  return patch.operations.some((operation) => operationText(operation).some((text) => text.length > 40 && !original.includes(text) && !/fictional|source/i.test(text)));
}

function interpretEdit(manifest: ExperienceManifest, instruction: string, sceneId: string | undefined): EditRefusal | {
  ok: true;
  intent: string;
  scope: "scene" | "experience";
  gameplayChange: boolean;
  uncertainty: string | null;
  reviewRequirements: string[];
  patch: ExperiencePatch;
} {
  const screened = screenEditInstruction(manifest, instruction, sceneId);
  if (!screened.ok) return screened;
  const text = instruction.trim();

  if (Decision.test(text)) {
    const patch = decisionPatch(manifest);
    if (!patch) return refuse("unsupported-edit");
    return {
      ok: true,
      intent: "Add one decision before an ending.",
      scope: "experience",
      gameplayChange: true,
      uncertainty: null,
      reviewRequirements: ["A person should review the new decision. No new source fact was added."],
      patch,
    };
  }
  if (Feedback.test(text)) {
    const patch = textPatch(manifest, "feedback", undefined);
    if (!patch) return refuse("unsupported-edit");
    return {
      ok: true,
      intent: "Explain a consequence before an ending.",
      scope: "experience",
      gameplayChange: false,
      uncertainty: null,
      reviewRequirements: [],
      patch,
    };
  }
  if (Ambiguous.test(text) && !ShortenIntro.test(text) && !Classroom.test(text)) {
    const patch = textPatch(manifest, "short", sceneId ?? firstDialogueId(manifest));
    if (!patch) return refuse("unsupported-edit");
    return {
      ok: true,
      intent: "Shorten only the opening.",
      scope: "scene",
      gameplayChange: false,
      uncertainty: "The request did not name a scene or a mechanic, so this proposal only shortens the opening.",
      reviewRequirements: ["Accept this bounded proposal before it can become the current draft."],
      patch,
    };
  }
  if (Classroom.test(text)) {
    const patch = textPatch(manifest, "classroom", sceneId);
    if (!patch) return refuse("unsupported-edit");
    return {
      ok: true,
      intent: "Use a fictional classroom voice.",
      scope: sceneId ? "scene" : "experience",
      gameplayChange: false,
      uncertainty: null,
      reviewRequirements: ["The classroom is fictional. This does not certify a local or age-group fit."],
      patch,
    };
  }
  if (ShortenIntro.test(text)) {
    const patch = textPatch(manifest, "short", sceneId ?? firstDialogueId(manifest));
    if (!patch) return refuse("unsupported-edit");
    return {
      ok: true,
      intent: "Shorten the introduction.",
      scope: "scene",
      gameplayChange: false,
      uncertainty: null,
      reviewRequirements: [],
      patch,
    };
  }
  if (TitleChange.test(text)) {
    const target = sceneId ?? firstDialogueId(manifest);
    if (!target) return refuse("unsupported-edit");
    const patch = ExperiencePatchV1.safeParse({
      contract: "EXPERIENCE-PATCH-v1",
      operations: [{ op: "set-presentation", sceneId: target, title: "A fictional opening" }],
    });
    if (!patch.success) return refuse("unsupported-edit");
    return {
      ok: true,
      intent: "Change the opening title.",
      scope: "scene",
      gameplayChange: false,
      uncertainty: null,
      reviewRequirements: [],
      patch: patch.data,
    };
  }
  if (ChoiceWording.test(text)) {
    const patch = choicePatch(manifest, sceneId);
    if (!patch) return refuse("unsupported-edit");
    return {
      ok: true,
      intent: "Revise choice wording.",
      scope: sceneId ? "scene" : "experience",
      gameplayChange: false,
      uncertainty: null,
      reviewRequirements: [],
      patch,
    };
  }
  if (Simplify.test(text) || /young children/i.test(text)) {
    const patch = textPatch(manifest, "short", sceneId);
    if (!patch) return refuse("unsupported-edit");
    const age = /12-year|twelve-year|young children|engaging/i.test(text);
    return {
      ok: true,
      intent: "Shorten the language in the draft.",
      scope: sceneId ? "scene" : "experience",
      gameplayChange: false,
      uncertainty: null,
      reviewRequirements: age ? ["This shortens language. It does not certify the draft for children."] : [],
      patch,
    };
  }
  return refuse("unsupported-edit");
}

function refuse(code: "unsupported-edit" | "review-required" | "invalid-edit"): EditRefusal {
  return { ok: false, code, alternatives: code === "invalid-edit" ? [] : [...EDIT_ALTERNATIVES] };
}

function firstDialogueId(manifest: ExperienceManifest) {
  return manifest.scenes.find((scene) => scene.role === "dialogue")?.id;
}

function decisionPatch(manifest: ExperienceManifest): ExperiencePatch | null {
  const endings = manifest.scenes.filter((scene) => scene.role === "ending").map((scene) => scene.id);
  if (new Set(endings).size < 2) return null;
  let best: { sceneId: string; choiceId: string; next: string; value: number } | null = null;
  for (const scene of manifest.scenes) {
    if (scene.role !== "dialogue") continue;
    for (const choice of scene.choices) {
      if (!endings.includes(choice.nextSceneId)) continue;
      const effect = choice.effects.find((item) => item.type === "set" && item.variableId === "understanding");
      const value = effect?.type === "set" ? effect.value : 0;
      if (!best || value > best.value) best = { sceneId: scene.id, choiceId: choice.id, next: choice.nextSceneId, value };
    }
  }
  if (!best) return null;
  const other = endings.find((id) => id !== best.next);
  if (!other) return null;
  const sceneId = manifest.scenes.some((scene) => scene.id === "added-decision") ? "added-choice" : "added-decision";
  if (manifest.scenes.some((scene) => scene.id === sceneId) || manifest.scenes.length >= 16) return null;
  const parsed = ExperiencePatchV1.safeParse({
    contract: "EXPERIENCE-PATCH-v1",
    operations: [
      {
        op: "insert-decision",
        sceneId,
        title: "One more choice",
        text: "The guide is fictional. The source note is unchanged. Choose how to finish.",
        choices: [
          { id: "stay-with-note", text: "Stay with the source note", nextSceneId: best.next, understanding: 2 },
          { id: "leave-the-note", text: "Leave the source note", nextSceneId: other, understanding: 0 },
        ],
      },
      { op: "retarget-choice", sceneId: best.sceneId, choiceId: best.choiceId, nextSceneId: sceneId },
    ],
  });
  return parsed.success ? parsed.data : null;
}

function textPatch(manifest: ExperienceManifest, mode: "short" | "feedback" | "classroom", sceneId: string | undefined) {
  const operations = [];
  for (const scene of manifest.scenes) {
    if (sceneId && scene.id !== sceneId) continue;
    if (mode === "feedback" && scene.role !== "ending") continue;
    if (mode !== "feedback" && scene.role === "ending") continue;
    const text = rewriteKeepingEvidence(scene.text, mode);
    if (!text || text === scene.text) continue;
    operations.push({ op: "rewrite-text" as const, sceneId: scene.id, text });
  }
  if (operations.length === 0) return null;
  const parsed = ExperiencePatchV1.safeParse({ contract: "EXPERIENCE-PATCH-v1", operations });
  return parsed.success ? parsed.data : null;
}

const CHOICE_TEXT: Record<string, string> = {
  "Read the source note": "Read the note",
  "Set the source note aside": "Set the note aside",
  "Keep the source wording": "Keep the source note",
  "Replace it with a new claim": "Use a new claim",
};

function choicePatch(manifest: ExperienceManifest, sceneId: string | undefined) {
  const operations = [];
  for (const scene of manifest.scenes) {
    if (scene.role !== "dialogue" || (sceneId && scene.id !== sceneId)) continue;
    for (const choice of scene.choices) {
      const text = CHOICE_TEXT[choice.text];
      if (!text || text === choice.text) continue;
      operations.push({ op: "revise-choice" as const, sceneId: scene.id, choiceId: choice.id, text });
    }
  }
  if (operations.length === 0) return null;
  const parsed = ExperiencePatchV1.safeParse({ contract: "EXPERIENCE-PATCH-v1", operations });
  return parsed.success ? parsed.data : null;
}

function rewriteKeepingEvidence(text: string, mode: "short" | "feedback" | "classroom") {
  const quotes = [...text.matchAll(/“([^”]+)”/g)].map((match) => match[1]);
  const fictional = text.includes("fictional");
  const goal = text.split(/(?<=\.)\s/).find((sentence) => /\b(goal|objective)\b/i.test(sentence))?.trim();
  let next = "";
  if (mode === "feedback") {
    next = `This choice explains the consequence before the draft ends. ${text}`;
  } else if (mode === "classroom") {
    next = "The guide speaks in a fictional classroom. The classroom is not described by the source.";
    if (quotes[0]) next += ` The source note says: “${quotes[0]}”.`;
  } else {
    next = fictional ? "This part stays fictional." : "This part stays with the source.";
    next += " The passage is shorter now.";
    if (quotes[0]) next += ` The source note says: “${quotes[0]}”.`;
    else next += ` ${text.split(/(?<=\.)\s/)[0] ?? text}`;
  }
  if (goal && !next.includes(goal)) next = `${next} ${goal}`;
  next = next.trim();
  if (next.length < 1 || next.length > 400 || Executable.test(next)) return null;
  if (fictional && !next.includes("fictional")) return null;
  for (const quote of quotes) {
    if (quote.length <= 180 && !next.includes(quote)) return null;
  }
  return next;
}

function applyPatch(
  manifest: ExperienceManifest,
  interpreted: {
    intent: string;
    scope: "scene" | "experience";
    gameplayChange: boolean;
    uncertainty: string | null;
    reviewRequirements: string[];
    patch: ExperiencePatch;
  },
  nextVersionId: string,
  promptVersion: typeof EDIT_PROMPT_VERSION | typeof MODEL_EDIT_PROMPT_VERSION = EDIT_PROMPT_VERSION,
): RevisionResult {
  if (!Uuid.safeParse(nextVersionId).success) {
    return { ok: false, code: "invalid-edit", alternatives: [] };
  }
  const next = structuredClone(manifest);
  next.versionId = nextVersionId;
  for (const operation of interpreted.patch.operations) {
    const applied = applyOperation(next, operation);
    if (!applied) {
      return failedValidation("patch.rejected", "A requested change did not fit this draft.");
    }
  }
  const parsed = parseManifest(next);
  if (!parsed.ok) {
    const code = parsed.diagnostics.find((item) => item.severity === "error")?.code;
    return failedValidation(code && /^[a-z0-9.-]{1,80}$/.test(code) ? code : "manifest.invalid", "The revised draft did not pass validation.");
  }
  if (parsed.manifest.runtime.requiresLlm !== false || parsed.manifest.runtime.executableScripts !== false) {
    return failedValidation("manifest.invalid", "The revised draft did not pass validation.");
  }
  const preserved = preservationDiagnostics(manifest, parsed.manifest, interpreted.patch);
  if (preserved.length > 0) return failedValidation(preserved[0]?.code ?? "preservation.rejected", preserved[0]?.message ?? "The revision was not kept.");
  const simulated = simulateExperience(parsed.manifest);
  const measured = measureChange(manifest, parsed.manifest);
  if (!simulated.ok) return failedValidation(simulated.code, "Gameplay simulation failed.");
  const summary = changeSummary(measured);
  const plan = ExperienceEditPlanV1.safeParse({
    contract: "EXPERIENCE-EDIT-PLAN-v1",
    editPolicyVersion: EDIT_POLICY_VERSION,
    promptVersion,
    intent: interpreted.intent,
    scope: interpreted.scope,
    gameplayChange: measured.graphChanged || interpreted.gameplayChange,
    factualChange: false,
    objectiveChange: false,
    uncertainty: interpreted.uncertainty,
    reviewRequirements: interpreted.reviewRequirements,
    preserved: [...PRESERVED],
    summary,
  });
  const validation = ExperienceEditValidationV1.safeParse({
    contract: "EXPERIENCE-EDIT-VALIDATION-v1",
    ok: true,
    diagnostics: [{ code: "grounding.unchanged", message: "Source notes and quoted claims stayed in place." }],
    simulation: { ok: true, endingSceneIds: simulated.report.endingSceneIds, replayReset: true },
    ...measured,
    factualChange: false,
  });
  if (!plan.success || !validation.success) return failedValidation("plan.invalid", "The edit plan did not match the editor contract.");
  return { ok: true, manifest: parsed.manifest, plan: plan.data, patch: interpreted.patch, validation: validation.data };
}

function applyOperation(manifest: ExperienceManifest, operation: ExperiencePatch["operations"][number]) {
  if (operation.op === "insert-decision") {
    if (manifest.scenes.some((scene) => scene.id === operation.sceneId) || manifest.scenes.length >= 16) return false;
    const variable = manifest.state.variables.find((item) => item.id === "understanding");
    if (!variable) return false;
    const assetIds = manifest.assets.some((asset) => asset.id === "note") ? ["note"] : [];
    manifest.scenes.push({
      id: operation.sceneId,
      role: "dialogue",
      title: operation.title,
      text: operation.text,
      assetIds,
      required: true,
      choices: operation.choices.map((choice) => ({
        id: choice.id,
        text: choice.text,
        effects: [{ type: "set", variableId: "understanding", value: choice.understanding }],
        nextSceneId: choice.nextSceneId,
      })),
    });
    return true;
  }
  const scene = manifest.scenes.find((item) => item.id === operation.sceneId);
  if (!scene) return false;
  if (operation.op === "rewrite-text") {
    scene.text = operation.text;
    return true;
  }
  if (operation.op === "set-presentation") {
    scene.title = operation.title;
    return true;
  }
  if (scene.role !== "dialogue") return false;
  const choice = scene.choices.find((item) => item.id === operation.choiceId);
  if (!choice) return false;
  if (operation.op === "revise-choice") choice.text = operation.text;
  if (operation.op === "retarget-choice") choice.nextSceneId = operation.nextSceneId;
  return true;
}

function preservationDiagnostics(before: ExperienceManifest, after: ExperienceManifest, patch: ExperiencePatch) {
  const diagnostics: { code: string; message: string }[] = [];
  if (before.experienceId !== after.experienceId) diagnostics.push({ code: "preservation.identity", message: "The experience identity changed." });
  if (JSON.stringify(before.sources) !== JSON.stringify(after.sources)) diagnostics.push({ code: "preservation.source", message: "Source references changed." });
  if (JSON.stringify(before.state) !== JSON.stringify(after.state)) diagnostics.push({ code: "preservation.state", message: "State variables changed." });
  if (JSON.stringify(before.runtime) !== JSON.stringify(after.runtime)) diagnostics.push({ code: "preservation.runtime", message: "Runtime flags changed." });
  if (JSON.stringify(before.accessibility) !== JSON.stringify(after.accessibility)) diagnostics.push({ code: "preservation.accessibility", message: "Accessibility metadata changed." });
  if (JSON.stringify(before.assets) !== JSON.stringify(after.assets)) diagnostics.push({ code: "preservation.assets", message: "Assets changed." });
  if (before.initialSceneId !== after.initialSceneId || before.locale !== after.locale) {
    diagnostics.push({ code: "preservation.identity", message: "The opening or locale changed." });
  }
  const afterText = after.scenes.map((scene) => scene.text).join("\n");
  for (const scene of before.scenes) {
    const revised = after.scenes.find((item) => item.id === scene.id);
    if (!revised) {
      diagnostics.push({ code: "preservation.scene", message: "A scene was removed." });
      continue;
    }
    const textTouched = patch.operations.some((operation) => operation.sceneId === scene.id && (operation.op === "rewrite-text" || operation.op === "set-presentation"));
    if (!textTouched && (scene.text !== revised.text || scene.title !== revised.title)) {
      diagnostics.push({ code: "preservation.scene", message: "An unrequested scene changed." });
    }
    if (scene.role === "dialogue" && revised.role === "dialogue") {
      for (const choice of scene.choices) {
        const nextChoice = revised.choices.find((item) => item.id === choice.id);
        const touched = patch.operations.some((operation) => (operation.op === "revise-choice" || operation.op === "retarget-choice") && operation.sceneId === scene.id && operation.choiceId === choice.id);
        if (!touched && JSON.stringify(choice) !== JSON.stringify(nextChoice)) {
          diagnostics.push({ code: "preservation.choice", message: "An unrequested choice changed." });
        }
      }
    }
    for (const quote of [...scene.text.matchAll(/“([^”]+)”/g)].map((match) => match[1])) {
      if (quote.length <= 180 && !afterText.includes(quote)) diagnostics.push({ code: "grounding.quote", message: "A quoted source claim was removed." });
    }
    const goal = scene.text.split(/(?<=\.)\s/).find((sentence) => /\b(goal|objective)\b/i.test(sentence))?.trim();
    if (goal && !afterText.includes(goal)) diagnostics.push({ code: "preservation.objective", message: "The learning objective was removed." });
  }
  if (before.scenes.some((scene) => scene.text.includes("fictional")) && !afterText.includes("fictional")) {
    diagnostics.push({ code: "preservation.fiction", message: "The fictional label was removed." });
  }
  return diagnostics.slice(0, 8);
}

function measureChange(before: ExperienceManifest, after: ExperienceManifest) {
  let scenesTouched = 0;
  let choicesChanged = 0;
  let graphChanged = before.scenes.length !== after.scenes.length;
  for (const scene of after.scenes) {
    const prior = before.scenes.find((item) => item.id === scene.id);
    if (!prior) {
      scenesTouched += 1;
      graphChanged = true;
      choicesChanged += scene.role === "dialogue" ? scene.choices.length : 0;
      continue;
    }
    let touched = prior.text !== scene.text || prior.title !== scene.title;
    if (prior.role === "dialogue" && scene.role === "dialogue") {
      for (const choice of scene.choices) {
        const old = prior.choices.find((item) => item.id === choice.id);
        if (!old || old.text !== choice.text || old.nextSceneId !== choice.nextSceneId || JSON.stringify(old.effects) !== JSON.stringify(choice.effects)) {
          choicesChanged += 1;
          touched = true;
          if (!old || old.nextSceneId !== choice.nextSceneId || JSON.stringify(old.effects) !== JSON.stringify(choice.effects)) graphChanged = true;
        }
      }
    }
    if (touched) scenesTouched += 1;
  }
  return { scenesTouched, choicesChanged, nodesAdded: Math.max(0, after.scenes.length - before.scenes.length), graphChanged };
}

export function changeSummary(measured: { scenesTouched: number; choicesChanged: number; graphChanged: boolean }) {
  const scenes = `${measured.scenesTouched} scene${measured.scenesTouched === 1 ? "" : "s"}`;
  const choices = `${measured.choicesChanged} choice${measured.choicesChanged === 1 ? "" : "s"}`;
  const path = measured.graphChanged ? "The path through the draft changed." : "The path through the draft is unchanged.";
  return `Updated ${scenes} and ${choices}. ${path} The learning objective and source references stay in place.`;
}

function failedValidation(code: string, message: string): EditRefusal {
  void message;
  return { ok: false, code: "invalid-experience", alternatives: [], diagnostic: code };
}

export function newEditIds() {
  return { editJobId: randomUUID(), versionId: randomUUID() };
}
