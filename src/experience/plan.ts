import { z } from "zod";
import { AgeBand, Uuid } from "@/contracts/common";
import { COMPILER_VERSION, PROMPT_VERSION, LIVE_PLAN_PROMPT_VERSION } from "./provider";

const Executable = /<script|javascript:|\beval\s*\(|\bnew\s+Function\b/i;
const SceneId = z.string().trim().regex(/^[a-z][a-z0-9-]{0,40}$/);

function text(max: number) {
  return z.string().trim().min(1).max(max).refine((value) => !Executable.test(value), "content.executable");
}

const Fact = z.object({
  kind: z.literal("source"),
  claim: text(180),
  spanId: Uuid,
}).strict();

const Choice = z.object({
  id: SceneId,
  text: text(200),
  nextSceneId: SceneId,
  understanding: z.number().int().min(0).max(2),
}).strict();

const Dialogue = z.object({
  id: SceneId,
  role: z.literal("dialogue"),
  title: text(80),
  text: text(400),
  choices: z.array(Choice).min(2).max(4),
}).strict();

const Ending = z.object({
  id: SceneId,
  role: z.literal("ending"),
  title: text(80),
  text: text(400),
}).strict();

export const ExperiencePlanV1 = z.object({
  contract: z.literal("EXPERIENCE-PLAN-v1"),
  compilerVersion: z.literal(COMPILER_VERSION),
  promptVersion: z.enum([PROMPT_VERSION, LIVE_PLAN_PROMPT_VERSION]),
  topicTitle: text(80),
  audienceLabel: text(80),
  ageBand: AgeBand,
  learnerObjective: text(200),
  setting: z.object({
    kind: z.literal("fictional"),
    label: text(80),
  }).strict(),
  facts: z.array(Fact).min(1).max(4),
  fictionalElements: z.array(text(80)).min(1).max(4),
  gameplayObjective: text(200),
  progression: z.array(z.discriminatedUnion("role", [Dialogue, Ending])).min(4).max(8),
  stateVariables: z.array(z.object({
    id: z.literal("understanding"),
    initial: z.literal(0),
    min: z.literal(0),
    max: z.literal(2),
  }).strict()).length(1),
  sourceReferences: z.array(z.object({
    documentVersionId: Uuid,
    spanId: Uuid,
  }).strict()).min(1).max(4),
  accessibility: z.array(text(80)).min(1).max(4),
  visualTreatment: z.literal("existing-fallback-scene"),
}).strict();

export type ExperiencePlan = z.infer<typeof ExperiencePlanV1>;
