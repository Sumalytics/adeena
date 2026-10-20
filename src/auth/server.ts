import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseBrowserConfig } from "./public-config";

export async function createSupabaseServer() {
  const cookieStore = await cookies();
  const { url, key } = supabaseBrowserConfig();
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // A Server Component can read the session. The proxy writes refreshed cookies.
        }
      },
    },
  });
}
