import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RightsStatus, Uuid } from "./common";

export const PrivacyStatus = z.enum([
  "no-identifiable-learner",
  "review-required",
  "blocked",
]);

export const RiskV1 = z
  .object({
    contract: z.literal("RISK-v1"),
    id: Uuid,
    experienceVersionId: Uuid,
    rights: RightsStatus,
    privacy: PrivacyStatus,
    publicationAllowed: z.boolean(),
  })
  .strict()
  .refine(
    (risk) =>
      risk.publicationAllowed ===
      (risk.rights === "cleared" && risk.privacy === "no-identifiable-learner"),
    { message: "publicationAllowed must follow rights and privacy" },
  );

export type RiskV1 = z.infer<typeof RiskV1>;

export function assessRisk(input: {
  experienceVersionId: string;
  rights: z.infer<typeof RightsStatus>;
  privacy: z.infer<typeof PrivacyStatus>;
  id?: string;
}): RiskV1 {
  const publicationAllowed =
    input.rights === "cleared" && input.privacy === "no-identifiable-learner";
  return RiskV1.parse({
    contract: "RISK-v1",
    id: input.id ?? randomUUID(),
    experienceVersionId: input.experienceVersionId,
    rights: input.rights,
    privacy: input.privacy,
    publicationAllowed,
  });
}
