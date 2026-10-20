import type { EmailOtpType } from "@supabase/supabase-js";
import { ensureIndividualWorkspace } from "@/db/creator";
import { creatorDatabase } from "./database";
import { safeNextPath } from "./paths";
import { createSupabaseServer } from "./server";
import { sessionFromAuthUser } from "./subject";

const emailOtpTypes = new Set<EmailOtpType>(["signup", "invite", "magiclink", "recovery", "email_change", "email"]);

function emailOtpType(value: string | null): EmailOtpType | null {
  if (value && emailOtpTypes.has(value as EmailOtpType)) return value as EmailOtpType;
  return null;
}

export async function finishEmailConfirmation(requestUrl: string) {
  const url = new URL(requestUrl);
  const supabase = await createSupabaseServer();
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = emailOtpType(url.searchParams.get("type"));
  if (code) {
    const exchanged = await supabase.auth.exchangeCodeForSession(code);
    if (exchanged.error) return { ok: false as const };
  } else if (tokenHash && type) {
    const verified = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (verified.error) return { ok: false as const };
  } else {
    return { ok: false as const };
  }
  const { data, error } = await supabase.auth.getUser();
  const session = !error && data.user ? sessionFromAuthUser({ id: data.user.id }) : null;
  if (!session) return { ok: false as const };
  await ensureIndividualWorkspace(creatorDatabase(), session.identity);
  return { ok: true as const, next: safeNextPath(url.searchParams.get("next")) };
}
