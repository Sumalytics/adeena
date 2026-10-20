import { createSupabaseServer } from "./server";
import { sessionFromAuthUser, type CreatorSession } from "./subject";

/** Verifies the caller with the Supabase Auth server. Cookie contents alone are not a session. */
export async function readVerifiedSession(): Promise<CreatorSession | null> {
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return sessionFromAuthUser({ id: data.user.id });
}
