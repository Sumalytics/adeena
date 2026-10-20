"use client";

import { createBrowserClient } from "@supabase/ssr";
import { supabaseBrowserConfig } from "./public-config";

export function createSupabaseBrowser() {
  const { url, key } = supabaseBrowserConfig();
  return createBrowserClient(url, key);
}
