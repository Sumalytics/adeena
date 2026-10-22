import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { readVerifiedSession } from "@/auth/session";
import { studioFixturesAllowed } from "@/studio/availability";
import { StudioApp } from "./studio-app";

export const metadata: Metadata = {
  title: "Creator Studio",
};

export default function StudioPage() {
  return (
    <Suspense fallback={<main id="content"><p>Checking your session…</p></main>}>
      <StudioGate />
    </Suspense>
  );
}

async function StudioGate() {
  await connection();
  if (!studioFixturesAllowed()) notFound();
  const session = await readVerifiedSession();
  if (!session) redirect("/login?next=/studio");
  return <StudioApp />;
}
