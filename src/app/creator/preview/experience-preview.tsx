"use client";

import type { ExperienceManifest } from "@adeena/experience-schema";
import { draftPresentation } from "@/experience/present";
import { PlayerApp } from "@/player/player-app";
import styles from "@/player/player.module.css";
import type { ExperienceRenderer } from "@/player/types";

const frame: ExperienceRenderer = {
  kind: "css",
  Visual({ title }) {
    return (
      <div className={styles.fallback} role="img" aria-label={title}>
        <p>{title}</p>
      </div>
    );
  },
};

export function ExperiencePreview({ manifest, notice }: { manifest: ExperienceManifest; notice: string }) {
  return <PlayerApp manifest={manifest} presentation={draftPresentation(manifest, notice)} renderer={frame} />;
}
