import { z } from "zod";
import { Sha256, Uuid, plainText } from "./common";

const ChoiceOption = z
  .object({
    id: z.string().trim().min(1).max(80),
    label: plainText(300),
    correct: z.boolean(),
  })
  .strict();

const Interaction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("choice"),
      options: z.array(ChoiceOption).min(2).max(6),
    })
    .strict(),
  z
    .object({
      type: z.literal("sort"),
      itemIds: z.array(z.string().trim().min(1).max(80)).min(2).max(8),
    })
    .strict(),
]);

const Scene = z
  .object({
    id: z.string().trim().min(1).max(80),
    title: plainText(200),
    narration: plainText(2000),
    interaction: Interaction,
  })
  .strict()
  .refine((scene) => {
    if (scene.interaction.type !== "choice") return true;
    const correct = scene.interaction.options.filter((option) => option.correct);
    return correct.length === 1;
  }, "A choice scene has exactly one correct option");

export const PlayerV1 = z
  .object({
    contract: z.literal("PLAYER-v1"),
    id: Uuid,
    experienceId: Uuid,
    version: z.number().int().positive(),
    contentHash: Sha256,
    objectives: z.array(plainText(200)).min(1).max(8),
    scenes: z.array(Scene).min(1).max(12),
    rules: z
      .object({
        engine: z.literal("adeena.rules.v1"),
        scoring: z.literal("deterministic-choice"),
      })
      .strict(),
    runtime: z
      .object({
        requiresLlm: z.literal(false),
        executableScripts: z.literal(false),
        animation: z.enum(["css", "svg", "phaser", "rive"]),
      })
      .strict(),
    sources: z
      .array(
        z
          .object({
            sourceId: Uuid,
            locator: z.string().min(1).max(500),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type PlayerV1 = z.infer<typeof PlayerV1>;
export type PlayerScene = PlayerV1["scenes"][number];
