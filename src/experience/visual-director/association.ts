import { z } from "zod";
import { Sha256, Uuid } from "@/contracts/common";
import { NarrationPlaybackTrackV1, VisualLearningBlueprintV1 } from "./schema";

const Id = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/);
export const VISUAL_RENDERER_VERSION = "visual-renderer@1" as const;
export const VisualSceneMappingV1 = z.object({
  contract: z.literal("ADEENA-VISUAL-SCENE-MAPPING-v1"),
  legacyExperienceId: Uuid,
  scenes: z.array(z.object({ visualSceneId: Id, legacySceneId: Id }).strict()).min(1).max(12),
  choices: z.array(z.object({ visualSceneId: Id, visualChoiceId: Id, legacyChoiceId: Id }).strict()).max(32),
}).strict();

export const StoredVisualContextV1 = z.object({
  sceneIds: z.array(Id).min(1).max(12),
  choiceIdsByScene: z.record(Id, z.array(Id).max(16)),
  sourceSpanIds: z.array(Uuid).min(1).max(64),
  ageBand: z.enum(["5-7", "8-10", "11-13", "14-18", "adult", "unspecified"]),
  locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
  implementedArchetypes: z.array(z.enum(["process-pathway@1", "venn-two-set@1", "timeline-sequence@1", "spatial-regions@1"])).min(1),
}).strict();

export const VisualExperienceAssociationV1 = z.object({
  contract: z.literal("ADEENA-VISUAL-EXPERIENCE-ASSOCIATION-v1"),
  associationId: Uuid,
  experienceVersionId: Uuid,
  blueprintHash: Sha256,
  rendererVersion: z.literal(VISUAL_RENDERER_VERSION),
  authoredFixture: z.boolean(),
  fixtureLabel: z.string().trim().min(1).max(120).nullable(),
  blueprint: VisualLearningBlueprintV1,
  mapping: VisualSceneMappingV1,
}).strict();

export const VisualNarrationBindingV1 = z.object({
  segmentId: Id,
  playback: NarrationPlaybackTrackV1,
  source: z.string().regex(/^\/api\/creator\/audio\/[0-9a-f-]{36}$/),
}).strict();

export type VisualSceneMapping = z.infer<typeof VisualSceneMappingV1>;
export type StoredVisualContext = z.infer<typeof StoredVisualContextV1>;
export type VisualExperienceAssociation = z.infer<typeof VisualExperienceAssociationV1>;
export type VisualNarrationBinding = z.infer<typeof VisualNarrationBindingV1>;
export type CreatorVisualExperience =
  | { status: "ready"; association: VisualExperienceAssociation; narration: VisualNarrationBinding[] }
  | { status: "invalid" | "unsupported"; message: string };
