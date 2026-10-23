import { createSupabaseServer } from "./server";
import { sessionFromAuthUser, type CreatorSession } from "./subject";

/** Verifies the signed access-token claims. Cookie contents alone are not a session. */
export async function readVerifiedSession(): Promise<CreatorSession | null> {
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase.auth.getClaims();
  const subject = error ? null : data?.claims?.sub;
  if (typeof subject !== "string") return null;
  return sessionFromAuthUser({ id: subject });
}
