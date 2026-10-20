import { z } from "zod";
import { SYNTHETIC_WORKSPACE_ID, Uuid } from "./common";

export const AccessAction = z.enum(["read", "edit", "publish", "generate"]);

export const AccessV1 = z
  .object({
    contract: z.literal("ACCESS-v1"),
    workspaceId: Uuid,
    actor: z
      .object({
        kind: z.enum(["member", "guest"]),
        id: Uuid,
      })
      .strict(),
    action: AccessAction,
    resource: z
      .object({
        type: z.enum(["experience", "source", "workspace"]),
        id: Uuid,
      })
      .strict(),
    allowed: z.boolean(),
  })
  .strict()
  .refine((access) => {
    const guestLocked =
      access.actor.kind === "guest" &&
      (access.action === "publish" || access.action === "edit");
    return guestLocked ? access.allowed === false : true;
  }, "Guest identities cannot edit or publish");

export type AccessV1 = z.infer<typeof AccessV1>;

export function decideAccess(input: {
  actor: { kind: "member" | "guest"; id: string };
  action: z.infer<typeof AccessAction>;
  resource: { type: "experience" | "source" | "workspace"; id: string };
  workspaceId?: string;
}): AccessV1 {
  const guestLocked =
    input.actor.kind === "guest" &&
    (input.action === "publish" || input.action === "edit");
  return AccessV1.parse({
    contract: "ACCESS-v1",
    workspaceId: input.workspaceId ?? SYNTHETIC_WORKSPACE_ID,
    actor: input.actor,
    action: input.action,
    resource: input.resource,
    allowed: !guestLocked,
  });
}
