import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/auth/server";

export async function POST() {
  const supabase = await createSupabaseServer();
  await supabase.auth.signOut();
  redirect("/");
}
