import { createChoiceLatch, createPulseGate } from "./choice-latch";
import { paintResourceRoom, type RoomPainter } from "./room-paint";
import { deriveShelfVisual, ROOM_SIZE, type ShelfObjectId } from "./shelf-view";
import type { ShelfViewInput } from "./shelf-view";

export type VisualIntent = { type: "choose"; choiceId: string };

export type ShelfRenderInput = ShelfViewInput & { reducedMotion: boolean };

type PhaserModule = typeof import("phaser");

export type ShelfAdapter = {
  readonly ready: boolean;
  mount(container: HTMLElement): Promise<void>;
  render(input: ShelfRenderInput): void;
  setFocusedChoice(choiceId: string | null): void;
  destroy(): void;
};

function loadPhaserScript(): Promise<PhaserModule> {
  const runtime = window as Window & { Phaser?: PhaserModule };
  if (runtime.Phaser?.Game) return Promise.resolve(runtime.Phaser);
  const pending = runtime as Window & { __adeenaPhaser?: Promise<PhaserModule> };
  if (pending.__adeenaPhaser) return pending.__adeenaPhaser;
  pending.__adeenaPhaser = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/phaser";
    script.async = true;
    script.onload = () => {
      if (runtime.Phaser?.Game) resolve(runtime.Phaser);
      else reject(new Error("phaser-unavailable"));
    };
    script.onerror = () => reject(new Error("phaser-unavailable"));
    document.head.appendChild(script);
  });
  return pending.__adeenaPhaser;
}

function bindPainter(graphics: Phaser.GameObjects.Graphics): RoomPainter {
  return {
    fill(color, alpha = 1) {
      graphics.fillStyle(color, alpha);
    },
    rect(x, y, width, height) {
      graphics.fillRect(x, y, width, height);
    },
    circle(x, y, radius) {
      graphics.fillCircle(x, y, radius);
    },
    roundRect(x, y, width, height, radius) {
      graphics.fillRoundedRect(x, y, width, height, radius);
    },
    strokeRect(x, y, width, height, line, color) {
      graphics.lineStyle(line, color, 1);
      graphics.strokeRect(x, y, width, height);
    },
  };
}

/**
 * Visual adapter for one resource room.
 * It never imports player-core and never applies effects.
 */
export function createShelfAdapter(options: {
  onIntent: (intent: VisualIntent) => void;
  loadEngine?: () => Promise<PhaserModule>;
}): ShelfAdapter {
  const latch = createChoiceLatch();
  const pulses = createPulseGate();
  let destroyed = false;
  let ready = false;
  let game: Phaser.Game | null = null;
  let scene: Phaser.Scene | null = null;
  let graphics: Phaser.GameObjects.Graphics | null = null;
  let zones: Phaser.GameObjects.Zone[] = [];
  let hotspotKey = "";
  let focused: string | null = null;
  let hovered: string | null = null;
  let latest: ShelfRenderInput | null = null;

  function allowed() {
    if (!latest) return new Set<string>();
    return new Set(deriveShelfVisual(latest).hotspots.map((hotspot) => hotspot.choiceId));
  }

  function activeObject(): ShelfObjectId | null {
    if (!latest) return null;
    const id = hovered ?? focused;
    if (!id) return null;
    return deriveShelfVisual(latest).hotspots.find((hotspot) => hotspot.choiceId === id)?.objectId ?? null;
  }

  function redraw() {
    if (!graphics || !latest) return;
    pulses.advance();
    graphics.clear();
    paintResourceRoom(bindPainter(graphics), deriveShelfVisual(latest), activeObject());
  }

  function syncZones() {
    if (!scene || !latest) return;
    const visual = deriveShelfVisual(latest);
    const key = visual.hotspots.map((hotspot) => hotspot.choiceId).join("|");
    if (key === hotspotKey) return;
    hotspotKey = key;
    for (const zone of zones) zone.destroy();
    zones = [];
    for (const hotspot of visual.hotspots) {
      const zone = scene.add.zone(hotspot.x, hotspot.y, hotspot.width, hotspot.height);
      zone.setOrigin(0, 0);
      zone.setInteractive({ useHandCursor: true });
      zone.setData("choiceId", hotspot.choiceId);
      zone.on("pointerover", () => {
        hovered = hotspot.choiceId;
        redraw();
      });
      zone.on("pointerout", () => {
        if (hovered === hotspot.choiceId) hovered = null;
        redraw();
      });
      zone.on("pointerdown", () => {
        latch.submit(hotspot.choiceId, allowed(), (choiceId) => {
          if (destroyed) return;
          options.onIntent({ type: "choose", choiceId });
        });
      });
      zones.push(zone);
    }
  }

  function attach(room: Phaser.Scene) {
    scene = room;
    graphics = room.add.graphics();
    ready = true;
    paint();
    room.game.canvas.tabIndex = -1;
    room.game.canvas.setAttribute("aria-hidden", "true");
  }

  function paint() {
    redraw();
    syncZones();
  }

  return {
    get ready() {
      return ready;
    },
    async mount(container) {
      if (destroyed) return;
      if (container.dataset) container.dataset.stage = "loading";
      const load = options.loadEngine ?? loadPhaserScript;
      const Phaser = await load();
      if (destroyed) return;
      if (container.dataset) container.dataset.stage = "engine";
      await new Promise<void>((resolve, reject) => {
        try {
          game = new Phaser.Game({
            type: Phaser.AUTO,
            parent: container,
            width: ROOM_SIZE.width,
            height: ROOM_SIZE.height,
            backgroundColor: "#f3e4cf",
            banner: false,
            autoFocus: false,
            audio: { noAudio: true },
            fps: { target: 30 },
            input: { keyboard: false, gamepad: false },
            scale: {
              mode: Phaser.Scale.FIT,
              autoCenter: Phaser.Scale.CENTER_BOTH,
              width: ROOM_SIZE.width,
              height: ROOM_SIZE.height,
            },
            scene: {
              key: "resource-room",
              create() {
                if (destroyed) {
                  resolve();
                  return;
                }
                attach(this);
                if (container.dataset) container.dataset.stage = "ready";
                resolve();
              },
            },
          });
        } catch (error) {
          if (container.dataset) container.dataset.stage = "failed";
          reject(error);
        }
      });
    },
    render(input) {
      latest = input;
      latch.reconcile();
      if (ready) paint();
    },
    setFocusedChoice(choiceId) {
      focused = choiceId;
      if (ready) redraw();
    },
    destroy() {
      destroyed = true;
      ready = false;
      latch.destroy();
      pulses.advance();
      for (const zone of zones) zone.destroy();
      zones = [];
      hotspotKey = "";
      const running = game;
      game = null;
      scene = null;
      graphics = null;
      running?.destroy(true);
    },
  };
}
