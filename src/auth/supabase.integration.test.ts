import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

function localSetting(name: string) {
  const text = readFileSync(".env.local", "utf8");
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

describe("supabase auth", () => {
  it("uses the Supabase Auth server for registration, invalid credentials, and forged tokens", async () => {
    const url = localSetting("NEXT_PUBLIC_SUPABASE_URL");
    const key = localSetting("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    const settingsResponse = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
    const settings = (await settingsResponse.json()) as { disable_signup?: boolean; mailer_autoconfirm?: boolean };
    expect(settingsResponse.status).toBe(200);
    expect(settings.disable_signup).toBe(false);
    expect(settings.mailer_autoconfirm).toBe(false);

    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const forged = await supabase.auth.getUser("aaaa.bbbb.cccc");
    expect(forged.data.user).toBeNull();
    expect(forged.error).toBeTruthy();

    const unknown = `missing-${randomUUID()}@gmail.com`;
    const invalid = await supabase.auth.signInWithPassword({ email: unknown, password: "wrong-password" });
    expect(invalid.data.session).toBeNull();
    expect(invalid.error?.code).toBe("invalid_credentials");

    const email = `eng007-${randomUUID()}@gmail.com`;
    const password = `Adeena-${randomUUID()}`;
    const signUp = await supabase.auth.signUp({ email, password });
    if (signUp.error?.code === "over_email_send_rate_limit") {
      expect(signUp.data.user).toBeNull();
      return;
    }
    expect(signUp.error?.code ?? "ok").toBe("ok");
    expect(signUp.data.user?.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(signUp.data.session).toBeNull();
    const signIn = await supabase.auth.signInWithPassword({ email, password });
    expect(signIn.data.session).toBeNull();
    expect(signIn.error?.code).toBe("email_not_confirmed");
  });
});
