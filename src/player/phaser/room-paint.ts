import { ROOM_COLORS } from "./culture";
import { objectBounds, type ShelfObjectId, type ShelfVisualState } from "./shelf-view";

export type RoomPainter = {
  fill(color: number, alpha?: number): void;
  rect(x: number, y: number, width: number, height: number): void;
  circle(x: number, y: number, radius: number): void;
  roundRect(x: number, y: number, width: number, height: number, radius: number): void;
  strokeRect(x: number, y: number, width: number, height: number, line: number, color: number): void;
};

function person(painter: RoomPainter, x: number, y: number, shirt: number) {
  painter.fill(ROOM_COLORS.skinShade);
  painter.circle(x, y, 11);
  painter.fill(ROOM_COLORS.skin);
  painter.circle(x, y - 1, 10);
  painter.fill(ROOM_COLORS.ink);
  painter.rect(x - 9, y - 14, 18, 6);
  painter.fill(shirt);
  painter.roundRect(x - 12, y + 10, 24, 28, 4);
  painter.fill(ROOM_COLORS.trousers);
  painter.rect(x - 10, y + 36, 8, 22);
  painter.rect(x + 2, y + 36, 8, 22);
  painter.fill(ROOM_COLORS.skin);
  painter.rect(x - 18, y + 16, 6, 16);
  painter.rect(x + 12, y + 16, 6, 16);
}

function toolSlots(count: number) {
  return Math.max(0, Math.min(3, Math.floor(count)));
}

export function paintResourceRoom(
  painter: RoomPainter,
  visual: ShelfVisualState,
  activeObject: ShelfObjectId | null,
  options?: { neighbor?: "painted" | "sprite" },
) {
  const colors = ROOM_COLORS;
  painter.fill(colors.plaster);
  painter.rect(0, 0, 360, 168);
  painter.fill(colors.plasterShade);
  painter.rect(0, 150, 360, 18);
  painter.fill(colors.floor);
  painter.rect(0, 168, 360, 72);
  painter.fill(colors.floorLine);
  painter.rect(0, 168, 360, 4);

  painter.fill(colors.cream);
  painter.rect(16, 14, 78, 58);
  painter.fill(colors.sky);
  painter.rect(22, 20, 66, 46);
  painter.fill(colors.daylight, 0.55);
  painter.rect(22, 20, 28, 46);
  painter.fill(colors.wood);
  painter.rect(52, 20, 4, 46);
  painter.rect(22, 40, 66, 4);

  painter.fill(colors.woodDark);
  painter.rect(148, 46, 8, 110);
  painter.rect(252, 46, 8, 110);
  painter.fill(colors.wood);
  painter.rect(140, 78, 128, 8);
  painter.rect(140, 118, 128, 8);

  const shown = toolSlots(visual.toolCount);
  if (shown >= 1) {
    painter.fill(colors.ink);
    painter.rect(158, 58, 8, 18);
    painter.fill(colors.metal);
    painter.rect(154, 52, 16, 8);
  }
  if (shown >= 2) {
    painter.fill(colors.forestMid);
    painter.roundRect(174, 56, 22, 18, 3);
  }
  if (visual.drillOnShelf) {
    painter.fill(colors.orange);
    painter.roundRect(204, 54, 28, 16, 3);
    painter.fill(colors.ink);
    painter.rect(228, 58, 12, 6);
    painter.fill(colors.metal);
    painter.rect(236, 56, 6, 10);
  }

  painter.fill(colors.wood);
  painter.rect(16, 156, 150, 10);
  painter.fill(colors.woodDark);
  painter.rect(22, 166, 8, 28);
  painter.rect(150, 166, 8, 28);

  const screwX = visual.screwdriverOffered ? 108 : 36;
  painter.fill(colors.orange);
  painter.roundRect(screwX, 140, 18, 10, 2);
  painter.fill(colors.metal);
  painter.rect(screwX + 16, 143, 28, 4);

  const chairX = visual.chairMended ? 78 : 74;
  painter.fill(colors.wood);
  painter.rect(chairX, 176, 36, 8);
  painter.fill(colors.woodDark);
  painter.rect(chairX + 4, 184, 6, 22);
  painter.rect(chairX + 26, 184, 6, 22);
  painter.rect(chairX + 14, 160, 6, 18);
  if (!visual.chairMended) {
    painter.fill(colors.floor);
    painter.rect(chairX + 16, 178, 8, 4);
  }

  painter.fill(colors.paper);
  painter.roundRect(228, 142, 52, 40, 3);
  painter.strokeRect(228, 142, 52, 40, 2, colors.ink);
  if (visual.cardFilled) {
    painter.fill(colors.ink);
    painter.rect(236, 152, 34, 3);
    painter.rect(236, 162, 28, 3);
    painter.fill(colors.forest);
    painter.rect(236, 170, 18, 3);
  }

  painter.fill(colors.forestDeep);
  painter.roundRect(258, 16, 88, 64, 4);
  painter.fill(colors.cream);
  painter.rect(266, 26, 30, 14);
  painter.fill(colors.forestMid);
  painter.rect(302, 26, 30, 14);
  if (visual.requestPosted) {
    painter.fill(colors.paper);
    painter.rect(276, 46, 52, 24);
    painter.fill(colors.orange);
    painter.circle(302, 50, 3);
  }

  if (options?.neighbor !== "sprite") {
    person(painter, visual.focus === "board" ? 196 : 112, 132, colors.shirt);
  }
  person(painter, 312, 118, colors.wood);
  if (visual.keeperNotes > 0) {
    painter.fill(colors.paper);
    painter.rect(284, 96, 24, 18);
    painter.fill(colors.ink);
    painter.rect(288, 102, 16, 2);
    painter.rect(288, 107, 12, 2);
  }

  if (activeObject) {
    const mark = objectBounds(activeObject);
    painter.strokeRect(mark.x, mark.y, mark.width, mark.height, 3, colors.ink);
    painter.fill(colors.orange);
    painter.rect(mark.x, mark.y, 16, 4);
  }
}
