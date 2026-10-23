"use client";

import type { ExperienceManifest } from "@adeena/experience-schema";
import { draftPresentation } from "@/experience/present";
import { PlayerApp } from "@/player/player-app";
import { cssRenderer } from "@/player/renderer";

export function ExperiencePreview({ manifest, notice }: { manifest: ExperienceManifest; notice: string }) {
  return <PlayerApp manifest={manifest} presentation={draftPresentation(manifest, notice)} renderer={cssRenderer} />;
}
