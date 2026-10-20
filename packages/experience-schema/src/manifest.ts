import { z } from "zod";
import { SceneId, Uuid, plainText } from "./text";

const Effect = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("adjust"),
      variableId: SceneId,
      delta: z.number().int().min(-100).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("set"),
      variableId: SceneId,
      value: z.number().int().min(-100).max(100),
    })
    .strict(),
]);

const Choice = z
  .object({
    id: SceneId,
    text: plainText(200),
    effects: z.array(Effect).max(4),
    nextSceneId: SceneId,
  })
  .strict();

const Retry = z
  .object({
    policy: z.literal("bounded-retry"),
    maxAttempts: z.number().int().min(1).max(5),
    onExhaustedSceneId: SceneId,
  })
  .strict();

const SceneBase = {
  id: SceneId,
  title: plainText(80),
  text: plainText(400),
  assetIds: z.array(SceneId).max(4),
  required: z.boolean(),
};

const DialogueScene = z
  .object({
    ...SceneBase,
    role: z.literal("dialogue"),
    choices: z.array(Choice).min(1).max(4),
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
    min: z.number().int().min(-100).max(100),
    max: z.number().int().min(-100).max(100),
    initial: z.number().int().min(-100).max(100),
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
    schema: z.literal("adeena.experience-manifest"),
    schemaVersion: z.literal("1"),
    experienceId: Uuid,
    versionId: Uuid,
    title: plainText(120),
    locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
    mechanics: z.array(z.literal("branching-dialogue@1")).min(1).max(1),
    initialSceneId: SceneId,
    scenes: z.array(z.discriminatedUnion("role", [DialogueScene, EndingScene])).min(1).max(16),
    state: z
      .object({
        variables: z.array(Variable).max(8),
      })
      .strict(),
    assets: z.array(Asset).max(8),
    sources: z.array(Source).min(1).max(4),
    events: z
      .object({
        schemaVersion: z.literal("1"),
      })
      .strict(),
    accessibility: z
      .object({
        textAlternative: z.enum(["provided", "not-applicable"]),
        motion: z.enum(["none", "optional"]),
      })
      .strict(),
  })
  .strict();

export type ExperienceManifest = z.infer<typeof ManifestSchema>;
export type ManifestScene = ExperienceManifest["scenes"][number];
export type DialogueScene = Extract<ManifestScene, { role: "dialogue" }>;
