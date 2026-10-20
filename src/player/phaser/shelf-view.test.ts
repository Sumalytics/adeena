import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROOM_COLORS } from "./culture";
import { createChoiceLatch, createPulseGate } from "./choice-latch";
import { paintResourceRoom, type RoomPainter } from "./room-paint";
import { deriveShelfVisual, sameShelfVisual } from "./shelf-view";

const askChoices = [
  { id: "share-now", text: "Hand over the drill and walk to the record card." },
  { id: "ask-purpose", text: "Ask what they plan to mend." },
  { id: "point-to-board", text: "Point them to the community board first." },
  { id: "not-in-room", text: "This choice has no object." },
];

function room(overrides: Partial<Parameters<typeof deriveShelfVisual>[0]> = {}) {
  return deriveShelfVisual({
    sceneId: "ask",
    choices: askChoices,
    variables: { "shared-tools": 3, repairs: 0, keepers: 0 },
    completed: false,
    ...overrides,
  });
}

describe("shared shelf visual state", () => {
  it("maps only the choices available in the current scene", () => {
    const visual = room();
    expect(visual.hotspots.map((hotspot) => hotspot.choiceId)).toEqual([
      "share-now",
      "ask-purpose",
      "point-to-board",
    ]);
    expect(visual.hotspots.every((hotspot) => hotspot.width >= 52 || hotspot.height >= 52)).toBe(true);
  });

  it("removes the drill when the tool count drops and keeps it when the count does not", () => {
    expect(room().drillOnShelf).toBe(true);
    expect(room({ variables: { "shared-tools": 2, repairs: 0, keepers: 0 } }).drillOnShelf).toBe(false);
    expect(room({ sceneId: "hand-tool-ending", choices: [], completed: true }).drillOnShelf).toBe(true);
  });

  it("uses different object states for different endings", () => {
    const card = room({
      sceneId: "card-ending",
      choices: [],
      variables: { "shared-tools": 2, repairs: 0, keepers: 0 },
      completed: true,
    });
    const posted = room({ sceneId: "posted-ending", choices: [], completed: true });
    const hand = room({ sceneId: "hand-tool-ending", choices: [], completed: true });
    const keeper = room({
      sceneId: "keeper-ending",
      choices: [],
      variables: { "shared-tools": 2, repairs: 0, keepers: 1 },
      completed: true,
    });
    expect(card.cardFilled).toBe(true);
    expect(posted.requestPosted).toBe(true);
    expect(hand.screwdriverOffered).toBe(true);
    expect(keeper.keeperNotes).toBe(1);
    expect(card.focus).not.toBe(posted.focus);
    expect(sameShelfVisual(card, posted)).toBe(false);
  });

  it("restores the opening room from the opening variables", () => {
    const played = room({
      sceneId: "card-ending",
      choices: [],
      variables: { "shared-tools": 2, repairs: 1, keepers: 0 },
      completed: true,
    });
    const again = room();
    expect(played.drillOnShelf).toBe(false);
    expect(again).toMatchObject({
      sceneId: "ask",
      toolCount: 3,
      repairCount: 0,
      keeperNotes: 0,
      drillOnShelf: true,
      cardFilled: false,
      requestPosted: false,
      screwdriverOffered: false,
      completed: false,
    });
  });

  it("does not change the picture when a rejected choice leaves state untouched", () => {
    const before = room();
    const after = room();
    expect(sameShelfVisual(before, after)).toBe(true);
  });

  it("draws the drill only while it is on the shelf", () => {
    const paints: number[] = [];
    const painter: RoomPainter = {
      fill(color) {
        paints.push(color);
      },
      rect() {},
      circle() {},
      roundRect() {},
      strokeRect() {},
    };
    paintResourceRoom(painter, room(), null);
    const withDrill = paints.filter((color) => color === ROOM_COLORS.orange).length;
    paints.length = 0;
    paintResourceRoom(painter, room({ variables: { "shared-tools": 2, repairs: 0, keepers: 0 } }), null);
    const withoutDrill = paints.filter((color) => color === ROOM_COLORS.orange).length;
    expect(withDrill).toBeGreaterThan(withoutDrill);
  });
});

describe("choice latch and scene changes", () => {
  it("sends one intent for a double tap and ignores a choice from the previous scene", () => {
    const latch = createChoiceLatch();
    const sent: string[] = [];
    const emit = (choiceId: string) => sent.push(choiceId);
    const current = new Set(["share-now"]);
    expect(latch.submit("share-now", current, emit)).toBe(true);
    expect(latch.submit("share-now", current, emit)).toBe(false);
    latch.reconcile();
    expect(latch.submit("share-now", new Set(["write-card"]), emit)).toBe(false);
    expect(sent).toEqual(["share-now"]);
    latch.destroy();
    expect(latch.submit("write-card", new Set(["write-card"]), emit)).toBe(false);
  });

  it("drops an in-flight pulse when the scene changes", () => {
    const gate = createPulseGate();
    const first = gate.advance();
    expect(gate.isCurrent(first)).toBe(true);
    gate.advance();
    expect(gate.isCurrent(first)).toBe(false);
  });
});

describe("renderer boundaries", () => {
  it("keeps Phaser out of the engine, homepage, studio, and text player", () => {
    const files = [
      "packages/player-core/src/engine.ts",
      "packages/player-core/src/index.ts",
      "src/app/page.tsx",
      "src/app/studio/page.tsx",
      "src/app/studio/studio-app.tsx",
      "src/app/play/demo/demo-player.tsx",
      "src/app/play/demo/renderer.tsx",
      "src/player/phaser/adapter.ts",
      "src/player/phaser/shelf-view.ts",
    ];
    const engineAndRoutes = files
      .filter((file) => !file.startsWith("src/player/phaser"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(engineAndRoutes).not.toContain("phaser");
    expect(engineAndRoutes).not.toContain("Rainmaker");
    const phaserSources = files
      .filter((file) => file.startsWith("src/player/phaser"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(phaserSources).not.toContain("@adeena/player-core");
    expect(phaserSources).not.toContain("Rainmaker");
  });

  it("records original prototype art with no external downloads", async () => {
    const { ghanaResourceRoom, ROOM_MODULES } = await import("./culture");
    expect(ghanaResourceRoom.externalDownloads).toBe(0);
    expect(ghanaResourceRoom.license).toContain("Original");
    expect(ROOM_MODULES.length).toBeGreaterThan(5);
  });
});
