import { randomUUID } from "node:crypto";
import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

export const RevV1 = z
  .object({
    contract: z.literal("REV-v1"),
    id: Uuid,
    experienceId: Uuid,
    fromVersion: z.number().int().positive(),
    toVersion: z.number().int().positive(),
    parentManifestId: Uuid,
    createdAt: IsoDateTime,
    reason: z.string().trim().min(1).max(300),
    safety: z
      .object({
        preservesSourceTrace: z.literal(true),
        executableScriptsIntroduced: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .refine((revision) => revision.toVersion === revision.fromVersion + 1, {
    message: "A revision creates the next version and leaves the parent unchanged",
  });

export type RevV1 = z.infer<typeof RevV1>;

export function planRevision(parent: {
  version: number;
  manifestId: string;
  experienceId: string;
}, reason: string, now = new Date()): RevV1 {
  return RevV1.parse({
    contract: "REV-v1",
    id: randomUUID(),
    experienceId: parent.experienceId,
    fromVersion: parent.version,
    toVersion: parent.version + 1,
    parentManifestId: parent.manifestId,
    createdAt: now.toISOString(),
    reason,
    safety: {
      preservesSourceTrace: true,
      executableScriptsIntroduced: false,
    },
  });
}
