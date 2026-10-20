import { SYNTHETIC_WORKSPACE_ID, Uuid } from "@/contracts/common";
import { SourceError } from "./errors";

const brand = Symbol("adeena.verified-membership");

/**
 * A membership proof can only be created inside this module.
 * Request JSON cannot carry the brand, and this module does not read sessions.
 * Production authorization is not implemented. See docs/source-of-truth/access-v1.md.
 */
export type VerifiedMembership = {
  readonly [brand]: true;
  readonly workspaceId: string;
  readonly actorId: string;
};

export function assertMembership(value: unknown): VerifiedMembership {
  if (!value || typeof value !== "object" || !(brand in value) || value[brand] !== true) {
    throw new SourceError("unauthenticated");
  }
  const candidate = value as VerifiedMembership;
  const workspaceId = Uuid.safeParse(candidate.workspaceId);
  const actorId = Uuid.safeParse(candidate.actorId);
  if (!workspaceId.success || !actorId.success || workspaceId.data === SYNTHETIC_WORKSPACE_ID) {
    throw new SourceError("unauthenticated");
  }
  return candidate;
}

/** Isolated tests only. Application routes must not import this function. */
export function issueMembershipForIsolatedTests(workspaceId: string, actorId: string): VerifiedMembership {
  const parsedWorkspace = Uuid.parse(workspaceId);
  const parsedActor = Uuid.parse(actorId);
  if (parsedWorkspace === SYNTHETIC_WORKSPACE_ID) throw new SourceError("unauthenticated");
  return { [brand]: true, workspaceId: parsedWorkspace, actorId: parsedActor };
}
