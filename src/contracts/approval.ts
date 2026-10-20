import { randomUUID } from "node:crypto";
import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";
import type { EduFailV1 } from "./edu-fail";
import type { RiskV1 } from "./risk";

export const ApprovalV1 = z
  .object({
    contract: z.literal("APPROVAL-v1"),
    id: Uuid,
    experienceVersionId: Uuid,
    decision: z.enum(["pending", "approved", "blocked"]),
    blockers: z.array(Uuid),
    decidedAt: IsoDateTime.nullable(),
  })
  .strict()
  .refine((approval) => {
    if (approval.decision === "approved") {
      return approval.blockers.length === 0 && approval.decidedAt !== null;
    }
    if (approval.decision === "blocked") {
      return approval.blockers.length > 0;
    }
    return approval.blockers.length === 0 && approval.decidedAt === null;
  }, "Approval decision, blockers, and timestamp must agree");

export type ApprovalV1 = z.infer<typeof ApprovalV1>;

export function buildApproval(input: {
  experienceVersionId: string;
  risk: RiskV1;
  eduFails: EduFailV1[];
  now?: Date;
  id?: string;
}): ApprovalV1 {
  const blockers = [
    ...(input.risk.publicationAllowed ? [] : [input.risk.id]),
    ...input.eduFails.filter((fail) => fail.severity === "block").map((fail) => fail.id),
  ];
  const blocked = blockers.length > 0;
  return ApprovalV1.parse({
    contract: "APPROVAL-v1",
    id: input.id ?? randomUUID(),
    experienceVersionId: input.experienceVersionId,
    decision: blocked ? "blocked" : "pending",
    blockers,
    decidedAt: blocked ? (input.now ?? new Date()).toISOString() : null,
  });
}
