import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Uuid } from "@/contracts/common";
import { ReleasePlayer } from "./release-player";

export const metadata = { title: "Play Adeena", robots: { index: false, follow: false } };

export default function ReleasePage({ params }: { params: Promise<{ releaseId: string }> }) {
  return <Suspense fallback={<main id="content">Opening experience…</main>}><Release params={params} /></Suspense>;
}

async function Release({ params }: { params: Promise<{ releaseId: string }> }) {
  await connection();
  const { releaseId } = await params;
  if (!Uuid.safeParse(releaseId).success) notFound();
  // No playable content in the router cache: the client rechecks the release.
  return <ReleasePlayer key={releaseId} releaseId={releaseId} />;
}
