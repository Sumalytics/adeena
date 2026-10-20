import { z } from "zod";
import { MANIFEST_LIMITS } from "./limits";
import {
  EVENT_SCHEMA_VERSION,
  MECHANIC_ID,
  RUNTIME_COMPATIBILITY,
  RUNTIME_PROFILE,
  SCHEMA_ID,
  SCHEMA_VERSION,
} from "./semantics";
import { SceneId, Uuid, plainText } from "./text";

const integerBound = z
  .number()
  .int()
  .min(-MANIFEST_LIMITS.maxAbsoluteInteger)
  .max(MANIFEST_LIMITS.maxAbsoluteInteger);

const Effect = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("adjust"),
      variableId: SceneId,
      delta: integerBound,
    })
    .strict(),
  z
    .object({
      type: z.literal("set"),
      variableId: SceneId,
      value: integerBound,
    })
    .strict(),
]);

const Choice = z
  .object({
    id: SceneId,
    text: plainText(200),
    effects: z.array(Effect).max(MANIFEST_LIMITS.maxEffectsPerChoice),
    nextSceneId: SceneId,
  })
  .strict();

const Retry = z
  .object({
    policy: z.literal("bounded-retry"),
    maxAttempts: z.number().int().min(1).max(MANIFEST_LIMITS.maxRetryAttempts),
    onExhaustedSceneId: SceneId,
  })
  .strict();

const SceneBase = {
  id: SceneId,
  title: plainText(80),
  text: plainText(400),
  assetIds: z.array(SceneId).max(MANIFEST_LIMITS.maxAssetIdsPerScene),
  required: z.boolean(),
};

const DialogueScene = z
  .object({
    ...SceneBase,
    role: z.literal("dialogue"),
    choices: z.array(Choice).min(1).max(MANIFEST_LIMITS.maxChoicesPerScene),
    retry: Retry.optional(),
  })
  .strict();

const EndingScene = z
  .object({
    ...SceneBase,
    role: z.literal("ending"),
  })
  .strict();

const Variable = z
  .object({
    id: SceneId,
    type: z.literal("integer"),
    min: integerBound,
    max: integerBound,
    initial: integerBound,
  })
  .strict();

const Asset = z
  .object({
    id: SceneId,
    kind: z.enum(["image", "audio", "text"]),
    locator: z.string().trim().min(1).max(180),
  })
  .strict();

const Source = z
  .object({
    sourceId: Uuid,
    locator: z.string().trim().min(1).max(200),
    note: plainText(300),
  })
  .strict();

export const ManifestSchema = z
  .object({
    schema: z.literal(SCHEMA_ID),
    schemaVersion: z.literal(SCHEMA_VERSION),
    experienceId: Uuid,
    versionId: Uuid,
    title: plainText(120),
    locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
    mechanics: z.array(z.literal(MECHANIC_ID)).min(1).max(1),
    initialSceneId: SceneId,
    scenes: z
      .array(z.discriminatedUnion("role", [DialogueScene, EndingScene]))
      .min(1)
      .max(MANIFEST_LIMITS.maxScenes),
    state: z
      .object({
        variables: z.array(Variable).max(MANIFEST_LIMITS.maxVariables),
      })
      .strict(),
    assets: z.array(Asset).max(MANIFEST_LIMITS.maxAssets),
    sources: z.array(Source).min(1).max(MANIFEST_LIMITS.maxSources),
    events: z
      .object({
        schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
      })
      .strict(),
    accessibility: z
      .object({
        textAlternative: z.enum(["provided", "not-applicable"]),
        motion: z.enum(["none", "optional"]),
      })
      .strict(),
    runtime: z
      .object({
        compatibility: z.literal(RUNTIME_COMPATIBILITY),
        profile: z.literal(RUNTIME_PROFILE),
        requiresLlm: z.literal(false),
        executableScripts: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type ExperienceManifest = z.infer<typeof ManifestSchema>;
export type ManifestScene = ExperienceManifest["scenes"][number];
export type DialogueScene = Extract<ManifestScene, { role: "dialogue" }>;
