import { z } from "zod";
import { AgeBand, Sha256, Uuid } from "@/contracts/common";

export const VISUAL_BLUEPRINT_LIMITS = {
  maxScenes: 12,
  maxObjectsPerScene: 32,
  maxCuesPerScene: 64,
  maxNarrationSegmentsPerScene: 12,
  maxSceneDurationMs: 120_000,
  maxCueDurationMs: 10_000,
  maxNarrationSegmentDurationMs: 30_000,
  maxNarrationCharacters: 600,
  maxCaptionCharacters: 240,
  maxInputNodes: 4_000,
  maxInputDepth: 12,
} as const;

const UnsafeText = /https?:\/\/|javascript:|data:|<script|\beval\s*\(|\bnew\s+Function\b/i;
const Id = z.string().trim().regex(/^[a-z][a-z0-9-]{0,40}$/);
const Locale = z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/);
const SafeText = (max: number) => z.string().trim().min(1).max(max).refine((value) => !UnsafeText.test(value), "content.unsafe");
const Coordinate = z.number().int().min(0).max(1000);
const Geometry = z.object({ x: Coordinate, y: Coordinate, width: z.number().int().min(1).max(1000), height: z.number().int().min(1).max(1000) }).strict();

export const ARCHETYPE_REGISTRY = {
  "process-pathway@1": { renderer: "implemented", purpose: "ordered movement through connected stages" },
  "venn-two-set@1": { renderer: "implemented", purpose: "two overlapping membership regions" },
  "timeline-sequence@1": { renderer: "not-implemented", purpose: "ordered events over time" },
  "spatial-regions@1": { renderer: "not-implemented", purpose: "items placed in meaningful regions" },
} as const;

export type VisualArchetypeId = keyof typeof ARCHETYPE_REGISTRY;
const ArchetypeId = z.enum(Object.keys(ARCHETYPE_REGISTRY) as [VisualArchetypeId, ...VisualArchetypeId[]]);
const ObjectRole = z.enum(["subject", "context", "path", "label", "example", "answer-target", "feedback", "decorative"]);
const CommonObject = { id: Id, label: SafeText(100), role: ObjectRole, geometry: Geometry };

const VisualObject = z.discriminatedUnion("kind", [
  z.object({ ...CommonObject, kind: z.literal("text"), text: SafeText(240) }).strict(),
  z.object({ ...CommonObject, kind: z.literal("illustration"), assetId: Id, altText: SafeText(180) }).strict(),
  z.object({ ...CommonObject, kind: z.literal("shape"), shape: z.enum(["circle", "ellipse", "rectangle", "line", "container"]) }).strict(),
  z.object({ ...CommonObject, kind: z.literal("icon"), icon: z.enum(["arrow", "marker", "check", "warning", "question", "person", "place", "object"]) }).strict(),
  z.object({ ...CommonObject, kind: z.literal("node"), nodeType: z.enum(["concept", "step", "item", "location"]) }).strict(),
  z.object({ ...CommonObject, kind: z.literal("edge"), fromId: Id, toId: Id, directed: z.boolean() }).strict(),
  z.object({ ...CommonObject, kind: z.literal("group"), memberIds: z.array(Id).min(1).max(16) }).strict(),
  z.object({ ...CommonObject, kind: z.literal("region"), regionType: z.enum(["inside", "outside", "overlap", "boundary"]) }).strict(),
  z.object({ ...CommonObject, kind: z.literal("quantity"), value: z.number().int().min(-1_000_000).max(1_000_000), unit: SafeText(30).optional() }).strict(),
  z.object({ ...CommonObject, kind: z.literal("character"), expression: z.enum(["neutral", "curious", "encouraging", "celebrating", "concerned"]) }).strict(),
]);

const CueTrigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("on-enter"), atMs: z.number().int().min(0).max(VISUAL_BLUEPRINT_LIMITS.maxSceneDurationMs) }).strict(),
  z.object({ kind: z.literal("narration-segment"), segmentId: Id, offsetMs: z.number().int().min(0).max(VISUAL_BLUEPRINT_LIMITS.maxNarrationSegmentDurationMs) }).strict(),
  z.object({ kind: z.literal("choice-applied"), choiceId: Id }).strict(),
]);

const CueAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["reveal", "hide", "highlight", "emphasize"]) }).strict(),
  z.object({ kind: z.literal("move"), to: z.object({ x: Coordinate, y: Coordinate }).strict() }).strict(),
  z.object({ kind: z.enum(["connect", "disconnect", "compare"]), relatedTargetId: Id }).strict(),
  z.object({ kind: z.enum(["transform", "change-state"]), state: z.enum(["default", "active", "completed", "correct", "incorrect"]) }).strict(),
]);

const VisualCue = z.object({
  id: Id,
  targetId: Id,
  trigger: CueTrigger,
  action: CueAction,
  durationMs: z.number().int().min(0).max(VISUAL_BLUEPRINT_LIMITS.maxCueDurationMs),
}).strict();

const VoiceSettings = z.object({
  locale: Locale,
  voiceProfileId: z.enum(["educator-neutral-1", "educator-warm-1", "educator-energetic-1"]),
  style: z.enum(["calm", "warm", "energetic"]),
  rate: z.number().min(0.8).max(1.2),
}).strict();

const NarrationSegment = z.object({
  id: Id,
  text: SafeText(VISUAL_BLUEPRINT_LIMITS.maxNarrationCharacters),
  caption: SafeText(VISUAL_BLUEPRINT_LIMITS.maxNarrationCharacters),
  onScreenText: SafeText(VISUAL_BLUEPRINT_LIMITS.maxCaptionCharacters).optional(),
  startMs: z.number().int().min(0).max(VISUAL_BLUEPRINT_LIMITS.maxSceneDurationMs),
  durationMs: z.number().int().min(250).max(VISUAL_BLUEPRINT_LIMITS.maxNarrationSegmentDurationMs),
  cueIds: z.array(Id).min(1).max(12),
  sourceSpanIds: z.array(Uuid).min(1).max(8),
}).strict();

const Feedback = z.object({ correct: SafeText(240), incorrect: SafeText(240) }).strict();
const InteractionBase = { id: Id, prompt: SafeText(240), feedback: Feedback, sourceSpanIds: z.array(Uuid).min(1).max(8) };
const PracticeInteraction = z.discriminatedUnion("kind", [
  z.object({ ...InteractionBase, kind: z.literal("label-visual"), objectIds: z.array(Id).min(2).max(12), answers: z.array(z.object({ objectId: Id, label: SafeText(80) }).strict()).min(2).max(12) }).strict(),
  z.object({ ...InteractionBase, kind: z.literal("sequence-steps"), itemIds: z.array(Id).min(2).max(12), correctOrder: z.array(Id).min(2).max(12) }).strict(),
  z.object({ ...InteractionBase, kind: z.literal("classify"), itemIds: z.array(Id).min(1).max(16), regionIds: z.array(Id).min(2).max(8), placements: z.array(z.object({ itemId: Id, regionId: Id }).strict()).min(1).max(16) }).strict(),
  z.object({ ...InteractionBase, kind: z.literal("sort"), itemIds: z.array(Id).min(2).max(16), rankByItemId: z.record(Id, z.number().int().min(0).max(15)) }).strict(),
  z.object({ ...InteractionBase, kind: z.literal("match"), pairs: z.array(z.object({ leftId: Id, rightId: Id }).strict()).min(2).max(12) }).strict(),
  z.object({ ...InteractionBase, kind: z.literal("calculate"), answerSpec: z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("exact-number"), answer: z.number().finite() }).strict(),
    z.object({ operation: z.literal("two-set-cardinality"), setACount: z.number().int().nonnegative(), setBCount: z.number().int().nonnegative(), intersectionCount: z.number().int().nonnegative(), unionCount: z.number().int().nonnegative(), totalCount: z.number().int().nonnegative().optional(), neitherCount: z.number().int().nonnegative().optional() }).strict(),
  ]) }).strict(),
  z.object({ ...InteractionBase, kind: z.literal("scenario-decision"), choiceIds: z.array(Id).min(2).max(4), supportedChoiceIds: z.array(Id).min(1).max(4) }).strict(),
]);

const VisualScene = z.object({
  id: Id,
  phase: z.enum(["teach", "demonstrate", "practice", "feedback", "recap"]),
  archetype: ArchetypeId,
  durationMs: z.number().int().min(1_000).max(VISUAL_BLUEPRINT_LIMITS.maxSceneDurationMs),
  visualObjects: z.array(VisualObject).min(1).max(VISUAL_BLUEPRINT_LIMITS.maxObjectsPerScene),
  cues: z.array(VisualCue).max(VISUAL_BLUEPRINT_LIMITS.maxCuesPerScene),
  narration: z.array(NarrationSegment).min(1).max(VISUAL_BLUEPRINT_LIMITS.maxNarrationSegmentsPerScene),
  sourceSpanIds: z.array(Uuid).min(1).max(12),
  interaction: PracticeInteraction.optional(),
}).strict();

export const VisualLearningBlueprintV1 = z.object({
  contract: z.literal("ADEENA-VISUAL-LEARNING-v1"),
  locale: Locale,
  ageBand: AgeBand,
  styleId: z.literal("friendly-illustrated-2d-v1"),
  voice: VoiceSettings,
  scenes: z.array(VisualScene).min(1).max(VISUAL_BLUEPRINT_LIMITS.maxScenes),
}).strict();

export type VisualLearningBlueprint = z.infer<typeof VisualLearningBlueprintV1>;
export type VisualScene = VisualLearningBlueprint["scenes"][number];
export type VisualObject = VisualScene["visualObjects"][number];
export type VisualCue = VisualScene["cues"][number];
export type VisualBlueprintDiagnostic = { code: string; path: Array<string | number>; message: string };
export type VisualBlueprintContext = {
  sceneIds: readonly string[];
  choiceIdsByScene: Readonly<Record<string, readonly string[]>>;
  sourceSpanIds: readonly string[];
  ageBand: z.infer<typeof AgeBand>;
  locale: string;
  allowedAssetIds?: readonly string[];
  implementedArchetypes?: readonly VisualArchetypeId[];
};

function inputDiagnostic(input: unknown): VisualBlueprintDiagnostic | null {
  let nodes = 0;
  const seen = new Set<object>();
  function walk(value: unknown, depth: number): boolean {
    nodes += 1;
    if (nodes > VISUAL_BLUEPRINT_LIMITS.maxInputNodes || depth > VISUAL_BLUEPRINT_LIMITS.maxInputDepth) return false;
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return false;
    if (!value || typeof value !== "object") return typeof value !== "string" || value.length <= 2_000;
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).every((item) => walk(item, depth + 1));
  }
  return walk(input, 0) ? null : { code: "bound.exceeded", path: [], message: "Blueprint input exceeds safe validation bounds." };
}

function duplicates(values: readonly string[]) {
  const seen = new Set<string>();
  return [...new Set(values.filter((value) => seen.has(value) || !seen.add(value)))];
}

export function validateVisualBlueprint(input: unknown, context: VisualBlueprintContext) {
  const bounded = inputDiagnostic(input);
  if (bounded) return { ok: false as const, diagnostics: [bounded] };
  const parsed = VisualLearningBlueprintV1.safeParse(input);
  if (!parsed.success) return { ok: false as const, diagnostics: parsed.error.issues.slice(0, 24).map((issue) => ({ code: "schema.invalid", path: issue.path, message: issue.message })) };
  const blueprint = parsed.data;
  const diagnostics: VisualBlueprintDiagnostic[] = [];
  const add = (code: string, path: Array<string | number>, message: string) => diagnostics.push({ code, path, message });
  if (blueprint.ageBand !== context.ageBand) add("context.age-band", ["ageBand"], "Blueprint age band differs from the selected audience profile.");
  if (blueprint.locale !== context.locale || blueprint.voice.locale !== blueprint.locale) add("context.locale", ["locale"], "Blueprint and voice locale must match the selected locale.");
  for (const id of duplicates(blueprint.scenes.map((scene) => scene.id))) add("id.duplicate", ["scenes"], `Duplicate scene id: ${id}`);
  const globalIds = blueprint.scenes.flatMap((scene) => [...scene.visualObjects.map((item) => item.id), ...scene.cues.map((item) => item.id), ...scene.narration.map((item) => item.id), ...(scene.interaction ? [scene.interaction.id] : [])]);
  for (const id of duplicates(globalIds)) add("id.duplicate", ["scenes"], `Blueprint ids must be globally unique: ${id}`);
  blueprint.scenes.forEach((scene, sceneIndex) => {
    const path = ["scenes", sceneIndex];
    if (!context.sceneIds.includes(scene.id)) add("reference.scene", [...path, "id"], "Scene is not present in the compiled experience.");
    if (context.implementedArchetypes && !context.implementedArchetypes.includes(scene.archetype)) add("archetype.not-implemented", [...path, "archetype"], "The selected runtime does not implement this registered archetype.");
    const objectIds = scene.visualObjects.map((object) => object.id);
    const cueIds = scene.cues.map((cue) => cue.id);
    const segmentIds = scene.narration.map((segment) => segment.id);
    for (const [name, ids] of [["visualObjects", objectIds], ["cues", cueIds], ["narration", segmentIds]] as const) {
      for (const id of duplicates(ids)) add("id.duplicate", [...path, name], `Duplicate id: ${id}`);
    }
    const objectSet = new Set(objectIds), cueSet = new Set(cueIds), segmentSet = new Set(segmentIds);
    const sourceSet = new Set(context.sourceSpanIds);
    for (const spanId of scene.sourceSpanIds) if (!sourceSet.has(spanId)) add("source.unknown", [...path, "sourceSpanIds"], "Scene references source evidence outside the validated context.");
    scene.visualObjects.forEach((object, objectIndex) => {
      const objectPath = [...path, "visualObjects", objectIndex];
      if (object.geometry.x + object.geometry.width > 1000 || object.geometry.y + object.geometry.height > 1000) add("geometry.out-of-bounds", [...objectPath, "geometry"], "Object geometry exceeds the normalized stage.");
      if (object.kind === "edge") for (const id of [object.fromId, object.toId]) if (!objectSet.has(id)) add("reference.object", objectPath, "Edge endpoint is not declared in this scene.");
      if (object.kind === "group") for (const id of object.memberIds) if (!objectSet.has(id)) add("reference.object", objectPath, "Group member is not declared in this scene.");
      if (object.kind === "illustration" && context.allowedAssetIds && !context.allowedAssetIds.includes(object.assetId)) add("asset.not-allowed", [...objectPath, "assetId"], "Illustration asset is not server-approved.");
    });
    scene.cues.forEach((cue, cueIndex) => {
      const cuePath = [...path, "cues", cueIndex];
      if (!objectSet.has(cue.targetId)) add("reference.object", [...cuePath, "targetId"], "Cue target is not declared in this scene.");
      if ("relatedTargetId" in cue.action && !objectSet.has(cue.action.relatedTargetId)) add("reference.object", [...cuePath, "action", "relatedTargetId"], "Cue related target is not declared in this scene.");
      if (cue.trigger.kind === "narration-segment" && !segmentSet.has(cue.trigger.segmentId)) add("reference.narration", [...cuePath, "trigger", "segmentId"], "Cue narration segment does not exist.");
      if (cue.trigger.kind === "choice-applied" && !(context.choiceIdsByScene[scene.id] ?? []).includes(cue.trigger.choiceId)) add("reference.choice", [...cuePath, "trigger", "choiceId"], "Cue choice is not authorized for this scene.");
      if (cue.trigger.kind === "on-enter" && cue.trigger.atMs + cue.durationMs > scene.durationMs) add("timeline.duration", cuePath, "Cue extends beyond the scene duration.");
      if (cue.trigger.kind === "narration-segment") {
        const segmentId = cue.trigger.segmentId;
        const segment = scene.narration.find((item) => item.id === segmentId);
        if (segment && cue.trigger.offsetMs + cue.durationMs > segment.durationMs) add("timeline.duration", cuePath, "Cue extends beyond its narration segment.");
      }
    });
    let narrationEnd = 0;
    for (const [segmentIndex, segment] of scene.narration.entries()) {
      const segmentPath = [...path, "narration", segmentIndex];
      if (segment.startMs < narrationEnd) add("timeline.overlap", [...segmentPath, "startMs"], "Narration segments must not overlap.");
      narrationEnd = segment.startMs + segment.durationMs;
      if (narrationEnd > scene.durationMs) add("timeline.duration", segmentPath, "Narration extends beyond the scene duration.");
      for (const cueId of segment.cueIds) if (!cueSet.has(cueId)) add("reference.cue", [...segmentPath, "cueIds"], "Narration references an unknown cue.");
      if (segment.caption !== segment.text) add("narration.caption", [...segmentPath, "caption"], "Captions must reproduce spoken narration verbatim; use onScreenText for shorter copy.");
      for (const spanId of segment.sourceSpanIds) {
        if (!sourceSet.has(spanId) || !scene.sourceSpanIds.includes(spanId)) add("source.unknown", [...segmentPath, "sourceSpanIds"], "Narration lacks valid scene source grounding.");
      }
    }
    validateInteraction(scene, objectSet, context.choiceIdsByScene[scene.id] ?? [], sourceSet, path, add);
  });
  return diagnostics.length > 0 ? { ok: false as const, diagnostics } : {
    ok: true as const,
    blueprint,
    rendererRequirements: blueprint.scenes.map((scene) => ({ sceneId: scene.id, archetype: scene.archetype, status: ARCHETYPE_REGISTRY[scene.archetype].renderer })),
  };
}

function validateInteraction(scene: z.infer<typeof VisualScene>, objectIds: Set<string>, choiceIds: readonly string[], sourceIds: Set<string>, path: Array<string | number>, add: (code: string, path: Array<string | number>, message: string) => void) {
  const interaction = scene.interaction;
  if (!interaction) return;
  const p = [...path, "interaction"];
  for (const spanId of interaction.sourceSpanIds) if (!sourceIds.has(spanId) || !scene.sourceSpanIds.includes(spanId)) add("source.unknown", [...p, "sourceSpanIds"], "Practice feedback lacks valid scene source grounding.");
  const requireObject = (id: string) => { if (!objectIds.has(id)) add("reference.object", p, "Practice references an object outside this scene."); };
  if (interaction.kind === "label-visual") { interaction.objectIds.forEach(requireObject); interaction.answers.forEach((answer) => requireObject(answer.objectId)); }
  if (interaction.kind === "sequence-steps") {
    interaction.itemIds.forEach(requireObject); interaction.correctOrder.forEach(requireObject);
    if (new Set(interaction.correctOrder).size !== interaction.itemIds.length || interaction.itemIds.some((id) => !interaction.correctOrder.includes(id))) add("practice.sequence", p, "Correct order must contain every sequence item exactly once.");
  }
  if (interaction.kind === "classify") { interaction.itemIds.forEach(requireObject); interaction.regionIds.forEach(requireObject); interaction.placements.forEach(({ itemId, regionId }) => { requireObject(itemId); requireObject(regionId); }); }
  if (interaction.kind === "sort") {
    interaction.itemIds.forEach(requireObject);
    if (Object.keys(interaction.rankByItemId).length !== interaction.itemIds.length || interaction.itemIds.some((id) => interaction.rankByItemId[id] === undefined) || new Set(Object.values(interaction.rankByItemId)).size !== interaction.itemIds.length) add("practice.sort", p, "Sort ranks must assign every item a distinct rank.");
  }
  if (interaction.kind === "match") interaction.pairs.forEach(({ leftId, rightId }) => { requireObject(leftId); requireObject(rightId); });
  if (interaction.kind === "scenario-decision") for (const id of [...interaction.choiceIds, ...interaction.supportedChoiceIds]) if (!choiceIds.includes(id)) add("reference.choice", p, "Practice references an unauthorized choice.");
  if (interaction.kind === "calculate" && interaction.answerSpec.operation === "two-set-cardinality") {
    const value = interaction.answerSpec;
    if (value.intersectionCount > Math.min(value.setACount, value.setBCount) || value.unionCount !== value.setACount + value.setBCount - value.intersectionCount) add("math.two-set-cardinality", [...p, "answerSpec"], "Two-set cardinalities are inconsistent.");
    if (value.totalCount !== undefined && (value.unionCount > value.totalCount || value.neitherCount !== undefined && value.neitherCount !== value.totalCount - value.unionCount)) add("math.two-set-cardinality", [...p, "answerSpec"], "Total and neither counts are inconsistent with the union.");
  }
}

export const NarrationCacheIdentityV1 = z.object({ normalizedText: SafeText(VISUAL_BLUEPRINT_LIMITS.maxNarrationCharacters), locale: Locale, voiceProfileId: VoiceSettings.shape.voiceProfileId, style: VoiceSettings.shape.style, rate: VoiceSettings.shape.rate, providerId: Id, modelId: Id }).strict();
export const VoiceSynthesisRequestV1 = z.object({ text: SafeText(VISUAL_BLUEPRINT_LIMITS.maxNarrationCharacters), locale: Locale, voiceProfileId: VoiceSettings.shape.voiceProfileId, style: VoiceSettings.shape.style, rate: VoiceSettings.shape.rate, idempotencyKey: Uuid }).strict();
export const VoiceSynthesisResultMetadataV1 = z.object({ mimeType: z.enum(["audio/mpeg", "audio/ogg", "audio/wav"]), durationMs: z.number().int().positive().max(VISUAL_BLUEPRINT_LIMITS.maxNarrationSegmentDurationMs), timepoints: z.array(z.object({ cueId: Id, atMs: z.number().int().nonnegative() }).strict()).max(24), providerUsage: z.object({ characterCount: z.number().int().nonnegative(), audioDurationMs: z.number().int().nonnegative() }).strict(), checksum: Sha256 }).strict();
export type VoiceSynthesisRequest = z.infer<typeof VoiceSynthesisRequestV1>;
export type VoiceSynthesisResult = z.infer<typeof VoiceSynthesisResultMetadataV1> & { bytes: Uint8Array };
export interface NarrationProvider { synthesize(input: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> }

export const NarrationAudioAssetV1 = z.object({ contract: z.literal("ADEENA-NARRATION-AUDIO-v1"), segmentId: Id, audioAssetId: Uuid, cacheKey: Sha256, checksum: Sha256, mimeType: z.enum(["audio/mpeg", "audio/ogg", "audio/wav"]), durationMs: z.number().int().positive().max(VISUAL_BLUEPRINT_LIMITS.maxNarrationSegmentDurationMs), timingCues: z.array(z.object({ cueId: Id, atMs: z.number().int().nonnegative() }).strict()).max(24), usage: z.object({ characterCount: z.number().int().nonnegative(), audioDurationMs: z.number().int().nonnegative(), cache: z.enum(["hit", "miss"]), retryCount: z.number().int().nonnegative().max(3) }).strict() }).strict().superRefine((value, context) => {
  value.timingCues.forEach((cue, index) => { if (cue.atMs > value.durationMs) context.addIssue({ code: "custom", path: ["timingCues", index, "atMs"], message: "Audio cue exceeds the asset duration." }); });
});
export const NarrationPlaybackTrackV1 = z.object({ contract: z.literal("ADEENA-NARRATION-PLAYBACK-v1"), segmentId: Id, audioAssetId: Uuid, durationMs: z.number().int().positive(), captions: z.array(z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(), text: SafeText(VISUAL_BLUEPRINT_LIMITS.maxNarrationCharacters) }).strict()).min(1).max(24), cueTimepoints: z.array(z.object({ cueId: Id, atMs: z.number().int().nonnegative() }).strict()).max(24) }).strict().superRefine((value, context) => {
  let captionEnd = 0;
  value.captions.forEach((caption, index) => {
    if (caption.startMs < captionEnd || caption.endMs <= caption.startMs || caption.endMs > value.durationMs) context.addIssue({ code: "custom", path: ["captions", index], message: "Caption timing must be ordered within the audio duration." });
    captionEnd = caption.endMs;
  });
  value.cueTimepoints.forEach((cue, index) => { if (cue.atMs > value.durationMs) context.addIssue({ code: "custom", path: ["cueTimepoints", index, "atMs"], message: "Playback cue exceeds the audio duration." }); });
});

export const VISUAL_STAGE_CONTRACT = {
  coordinateSpace: { width: 1000, height: 1000 },
  clock: "narration-audio-current-time-or-deterministic-scene-time",
  requiredInputModes: ["keyboard", "touch"],
  reducedMotion: "replace-movement-with-immediate-state-change",
  unsupportedArchetype: "fail-with-archetype.not-implemented",
  playbackInference: "none",
  outputModes: ["interactive-web", "future-linear-export"],
} as const;
