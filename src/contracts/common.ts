import { z } from "zod";

export const Uuid = z.string().uuid();
export const IsoDateTime = z.string().datetime();
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const AgeBand = z.enum([
  "5-7",
  "8-10",
  "11-13",
  "14-18",
  "adult",
  "unspecified",
]);

export const RightsStatus = z.enum(["unverified", "cleared", "blocked"]);

/** Fixed workspace for synthetic studio sessions. Not a customer tenant. */
export const SYNTHETIC_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

export function plainText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) => !/<script|javascript:/i.test(value),
      "Executable content is not allowed",
    );
}
