"use client";

import { createSceneRenderer } from "@/player/renderer";
import { BoardArt, HandToolArt, PurposeArt, RecordArt, ShelfArt } from "./art";

export const sharedShelfRenderer = createSceneRenderer({
  ask: ShelfArt,
  record: ShelfArt,
  "card-ending": RecordArt,
  purpose: PurposeArt,
  "hand-tool-ending": HandToolArt,
  board: BoardArt,
  "posted-ending": BoardArt,
});
