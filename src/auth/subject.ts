import { identityFromVerifiedSubject, type VerifiedIdentity } from "@/db/identity";

export type CreatorSession = {
  userId: string;
  identity: VerifiedIdentity;
};

/** Accepts only the subject returned by verified Supabase Auth data. */
export function sessionFromAuthUser(user: { id?: string | null } | null): CreatorSession | null {
  if (!user?.id) return null;
  try {
    const identity = identityFromVerifiedSubject(user.id);
    return { userId: identity.userId, identity };
  } catch {
    return null;
  }
}
