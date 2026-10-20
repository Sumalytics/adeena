import { z } from "zod";

const Executable = /<script|javascript:|\beval\s*\(|\bnew\s+Function\b/i;

export function plainText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !Executable.test(value), "content.executable");
}

export const SceneId = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{0,40}$/);

export const Uuid = z.string().uuid();
