"use client";

import { useState } from "react";
import { BoardArt, HandToolArt, PurposeArt, RecordArt, ShelfArt } from "@/app/play/demo/art";
import { createSceneRenderer } from "@/player/renderer";
import { PhaserShelfVisual } from "@/player/phaser/phaser-visual";
import type { ExperienceRenderer, SceneVisualProps } from "@/player/types";

const cssArt = createSceneRenderer({
  ask: ShelfArt,
  record: ShelfArt,
  "card-ending": RecordArt,
  purpose: PurposeArt,
  "hand-tool-ending": HandToolArt,
  board: BoardArt,
  "posted-ending": BoardArt,
});

function WorldVisual(props: SceneVisualProps) {
  const [useCss, setUseCss] = useState(false);
  if (useCss) {
    const Visual = cssArt.Visual;
    return <Visual {...props} />;
  }
  return <PhaserShelfVisual {...props} onUnavailable={() => setUseCss(true)} />;
}

export const worldRenderer: ExperienceRenderer = {
  kind: "phaser",
  Visual: WorldVisual,
};
