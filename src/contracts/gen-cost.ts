import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

export const GenCostV1 = z
  .object({
    contract: z.literal("GEN-COST-v1"),
    jobId: Uuid,
    experienceVersionId: Uuid,
    idempotencyKey: Uuid,
    vendor: z.string().trim().min(1).max(80),
    usage: z
      .object({
        unit: z.enum(["tokens", "images", "seconds"]),
        quantity: z.number().int().nonnegative(),
      })
      .strict(),
    amount: z
      .object({
        currency: z.literal("USD"),
        minor: z.number().int().nonnegative(),
      })
      .strict(),
    status: z.enum(["estimated", "reconciled", "unbilled"]),
    reconciledAt: IsoDateTime.nullable(),
  })
  .strict()
  .refine((cost) => {
    if (cost.status === "reconciled") return cost.reconciledAt !== null;
    return cost.reconciledAt === null;
  }, "Reconciled costs need a timestamp; open costs do not");

export type GenCostV1 = z.infer<typeof GenCostV1>;

export function syntheticCost(input: {
  jobId: string;
  experienceVersionId: string;
  idempotencyKey: string;
}): GenCostV1 {
  return GenCostV1.parse({
    contract: "GEN-COST-v1",
    jobId: input.jobId,
    experienceVersionId: input.experienceVersionId,
    idempotencyKey: input.idempotencyKey,
    vendor: "synthetic",
    usage: { unit: "tokens", quantity: 0 },
    amount: { currency: "USD", minor: 0 },
    status: "unbilled",
    reconciledAt: null,
  });
}
