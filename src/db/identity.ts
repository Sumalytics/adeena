import { SYNTHETIC_WORKSPACE_ID, Uuid } from "@/contracts/common";
import { SourceError } from "@/source/errors";

const identityBrand = Symbol("adeena.verified-identity");

/**
 * Server code mints this value only after Supabase Auth `getUser()` succeeds.
 * A user id in request JSON is not an identity. This module does not check passwords.
 */
export type VerifiedIdentity = {
  readonly [identityBrand]: true;
  readonly userId: string;
};

export function assertVerifiedIdentity(value: unknown): VerifiedIdentity {
  if (!value || typeof value !== "object" || !(identityBrand in value) || value[identityBrand] !== true) {
    throw new SourceError("unauthenticated");
  }
  const userId = Uuid.safeParse((value as VerifiedIdentity).userId);
  if (!userId.success || userId.data === SYNTHETIC_WORKSPACE_ID) throw new SourceError("unauthenticated");
  return { [identityBrand]: true, userId: userId.data };
}

/** Production mint. Only the Auth server may call this, and only with a `getUser()` id. */
export function identityFromVerifiedSubject(userId: string): VerifiedIdentity {
  const parsed = Uuid.safeParse(userId);
  if (!parsed.success || parsed.data === SYNTHETIC_WORKSPACE_ID) throw new SourceError("unauthenticated");
  return { [identityBrand]: true, userId: parsed.data };
}

/** Isolated tests only. Application routes must not import this function. */
export function issueIdentityForIsolatedTests(userId: string): VerifiedIdentity {
  const parsed = Uuid.parse(userId);
  if (parsed === SYNTHETIC_WORKSPACE_ID) throw new SourceError("unauthenticated");
  return { [identityBrand]: true, userId: parsed };
}
