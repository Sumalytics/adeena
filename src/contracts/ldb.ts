import { z } from "zod";
import { AgeBand, IsoDateTime, RightsStatus, Sha256, Uuid, plainText } from "./common";

const SourceLabel = plainText(500);

export const LdbV1 = z
  .object({
    contract: z.literal("LDB-v1"),
    id: Uuid,
    version: z.number().int().positive(),
    workspaceId: Uuid,
    createdAt: IsoDateTime,
    source: z
      .object({
        kind: z.enum(["upload", "reference"]),
        label: SourceLabel,
        locator: z.string().min(1).max(500),
        contentHash: Sha256.nullable(),
        rightsStatus: RightsStatus,
      })
      .strict(),
    audience: z
      .object({
        label: plainText(120),
        ageBand: AgeBand,
      })
      .strict(),
    status: z.literal("draft"),
  })
  .strict();

export type LdbV1 = z.infer<typeof LdbV1>;
