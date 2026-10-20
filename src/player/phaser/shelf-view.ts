import type { SceneChoice } from "@/player/types";

export const ROOM_SIZE = { width: 360, height: 240 } as const;

export type ShelfObjectId =
  | "drill"
  | "screwdriver"
  | "card"
  | "board"
  | "chair"
  | "keeper"
  | "shelf";

export type ShelfHotspot = {
  choiceId: string;
  objectId: ShelfObjectId;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ShelfFocus = "shelf" | "table" | "board" | "keeper" | "card";

export type ShelfVisualState = {
  sceneId: string;
  toolCount: number;
  repairCount: number;
  keeperNotes: number;
  drillOnShelf: boolean;
  screwdriverOffered: boolean;
  cardFilled: boolean;
  requestPosted: boolean;
  chairMended: boolean;
  focus: ShelfFocus;
  hotspots: readonly ShelfHotspot[];
  completed: boolean;
};

export type ShelfViewInput = {
  sceneId: string;
  choices: readonly SceneChoice[];
  variables: Readonly<Record<string, number>>;
  completed: boolean;
};

const CHOICE_OBJECT: Record<string, ShelfObjectId> = {
  "share-now": "drill",
  "ask-purpose": "chair",
  "point-to-board": "board",
  "lend-for-repair": "drill",
  "offer-hand-tool": "screwdriver",
  "write-card": "card",
  "tell-keeper": "keeper",
  "post-request": "board",
  "walk-back": "shelf",
};

const OBJECT_BOUNDS: Record<ShelfObjectId, { x: number; y: number; width: number; height: number }> = {
  drill: { x: 198, y: 46, width: 52, height: 48 },
  screwdriver: { x: 28, y: 128, width: 64, height: 52 },
  card: { x: 220, y: 132, width: 68, height: 56 },
  board: { x: 254, y: 12, width: 96, height: 72 },
  chair: { x: 68, y: 154, width: 56, height: 56 },
  keeper: { x: 292, y: 96, width: 52, height: 88 },
  shelf: { x: 136, y: 42, width: 128, height: 92 },
};

export function objectBounds(id: ShelfObjectId) {
  return OBJECT_BOUNDS[id];
}

const SCENE_FOCUS: Record<string, ShelfFocus> = {
  ask: "shelf",
  purpose: "table",
  record: "card",
  board: "board",
  "card-ending": "card",
  "keeper-ending": "keeper",
  "hand-tool-ending": "table",
  "posted-ending": "board",
};

function count(variables: Readonly<Record<string, number>>, id: string) {
  const value = variables[id];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function deriveShelfVisual(input: ShelfViewInput): ShelfVisualState {
  const sceneId = typeof input.sceneId === "string" ? input.sceneId : "";
  const variables = input.variables ?? {};
  const choices = Array.isArray(input.choices) ? input.choices : [];
  const toolCount = count(variables, "shared-tools");
  const repairCount = count(variables, "repairs");
  const keeperNotes = count(variables, "keepers");
  const hotspots: ShelfHotspot[] = [];
  const seen = new Set<string>();
  for (const choice of choices) {
    if (!choice || typeof choice.id !== "string" || seen.has(choice.id)) continue;
    const objectId = CHOICE_OBJECT[choice.id];
    if (!objectId) continue;
    seen.add(choice.id);
    const bounds = OBJECT_BOUNDS[objectId];
    hotspots.push({
      choiceId: choice.id,
      objectId,
      label: typeof choice.text === "string" ? choice.text : choice.id,
      ...bounds,
    });
  }
  return {
    sceneId,
    toolCount,
    repairCount,
    keeperNotes,
    drillOnShelf: toolCount >= 3,
    screwdriverOffered: sceneId === "hand-tool-ending",
    cardFilled: sceneId === "card-ending",
    requestPosted: sceneId === "posted-ending",
    chairMended: repairCount > 0,
    focus: SCENE_FOCUS[sceneId] ?? "shelf",
    hotspots,
    completed: input.completed === true,
  };
}

export function sameShelfVisual(left: ShelfVisualState, right: ShelfVisualState) {
  return JSON.stringify(left) === JSON.stringify(right);
}
