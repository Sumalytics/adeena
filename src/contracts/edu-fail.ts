import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

export const EduFailCode = z.enum([
  "source-gap",
  "age-mismatch",
  "unsupported-claim",
  "missing-objective",
]);

export const EduFailV1 = z
  .object({
    contract: z.literal("EDU-FAIL-v1"),
    id: Uuid,
    experienceVersionId: Uuid,
    code: EduFailCode,
    severity: z.enum(["block", "warn"]),
    message: z.string().trim().min(1).max(300),
    sourceRef: Uuid.nullable(),
    recordedAt: IsoDateTime,
  })
  .strict();

export type EduFailV1 = z.infer<typeof EduFailV1>;
