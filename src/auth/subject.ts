import { identityFromVerifiedSubject, type VerifiedIdentity } from "@/db/identity";

export type CreatorSession = {
  userId: string;
  identity: VerifiedIdentity;
};

/** Accepts only the id returned by Supabase Auth `getUser()`. */
export function sessionFromAuthUser(user: { id?: string | null } | null): CreatorSession | null {
  if (!user?.id) return null;
  try {
    const identity = identityFromVerifiedSubject(user.id);
    return { userId: identity.userId, identity };
  } catch {
    return null;
  }
}
