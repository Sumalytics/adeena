import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sharedShelf } from "@adeena/experience-schema";
import { sharedShelfPresentation } from "@/app/play/demo/presentation";
import { WorldPlayer } from "@/app/play/world/world-player";
import { presentPlayer } from "@/player/present";
import { PlayerScreen } from "@/player/player-screen";
import { createPlayerController } from "@/player/session";
import { GUIDE_TEXTURES } from "@/player/character/asset";
import { CHARACTER_POSES } from "@/player/character/poses";
import { createShelfAdapter } from "./adapter";

type Handler = () => void;

function fakeZone() {
  const handlers: Record<string, Handler> = {};
  return {
    setOrigin() {
      return this;
    },
    setInteractive() {
      return this;
    },
    setData() {
      return this;
    },
    on(event: string, handler: Handler) {
      handlers[event] = handler;
      return this;
    },
    destroy() {},
    press() {
      handlers.pointerdown?.();
    },
  };
}

function fakeEngine() {
  const zones: Array<ReturnType<typeof fakeZone>> = [];
  const nodes: Array<{ remove(): void }> = [];
  class Scene {
    add = {
      graphics: () => ({
        clear() {},
        fillStyle() {},
        fillRect() {},
        fillCircle() {},
        fillRoundedRect() {},
        lineStyle() {},
        strokeRect() {},
      }),
      zone: () => {
        const zone = fakeZone();
        zones.push(zone);
        return zone;
      },
    };
    game = { canvas: { tabIndex: 0, setAttribute() {} } };
  }
  class Game {
    constructor(config: {
      parent: { appendChild(node: { remove(): void }): void };
      scene: { create: () => void };
    }) {
      const canvas = {
        remove() {
          const index = nodes.indexOf(canvas);
          if (index >= 0) nodes.splice(index, 1);
        },
      };
      nodes.push(canvas);
      config.parent.appendChild(canvas);
      const room = new Scene();
      config.scene.create.call(room);
    }
    destroy() {
      nodes.splice(0, nodes.length);
    }
  }
  const parent = {
    appendChild(node: { remove(): void }) {
      if (!nodes.includes(node)) nodes.push(node);
    },
    querySelectorAll() {
      return nodes;
    },
  };
  const engine = {
    AUTO: 0,
    Game,
    Scene,
    Scale: { FIT: 1, CENTER_BOTH: 1 },
  };
  return { engine, zones, nodes, parent };
}

const opening = {
  sceneId: "ask",
  choices: [
    { id: "share-now", text: "Hand over the drill and walk to the record card." },
    { id: "ask-purpose", text: "Ask what they plan to mend." },
  ],
  variables: { "shared-tools": 3, repairs: 0, keepers: 0 },
  completed: false,
  reducedMotion: true,
};

describe("Phaser shelf adapter", () => {
  it("mounts one canvas, cleans it up, and mounts again", async () => {
    const first = fakeEngine();
    const adapter = createShelfAdapter({
      onIntent() {},
      loadEngine: async () => first.engine as never,
    });
    await adapter.mount(first.parent as never);
    expect(first.nodes).toHaveLength(1);
    adapter.destroy();
    expect(first.nodes).toHaveLength(0);

    const second = fakeEngine();
    const again = createShelfAdapter({
      onIntent() {},
      loadEngine: async () => second.engine as never,
    });
    await again.mount(second.parent as never);
    expect(second.nodes).toHaveLength(1);
    again.destroy();
  });

  it("routes one choice intent and ignores a stale tap from the previous scene", async () => {
    const fake = fakeEngine();
    const intents: string[] = [];
    const adapter = createShelfAdapter({
      onIntent(intent) {
        intents.push(intent.choiceId);
      },
      loadEngine: async () => fake.engine as never,
    });
    await adapter.mount(fake.parent as never);
    adapter.render(opening);
    fake.zones[0]?.press();
    fake.zones[0]?.press();
    expect(intents).toEqual(["share-now"]);
    const previous = fake.zones[0];
    adapter.render({
      ...opening,
      sceneId: "record",
      choices: [{ id: "write-card", text: "Write the borrower's name and a return day on the card." }],
      variables: { "shared-tools": 2, repairs: 0, keepers: 0 },
    });
    previous?.press();
    expect(intents).toEqual(["share-now"]);
    adapter.destroy();
    fake.zones.at(-1)?.press();
    expect(intents).toEqual(["share-now"]);
  });

  it("does not emit after unmount resolves", async () => {
    const fake = fakeEngine();
    let release: (() => void) | undefined;
    const adapter = createShelfAdapter({
      onIntent() {
        throw new Error("stale intent");
      },
      loadEngine: () =>
        new Promise((resolve) => {
          release = () => resolve(fake.engine as never);
        }),
    });
    const pending = adapter.mount(fake.parent as never);
    adapter.destroy();
    release?.();
    await pending;
    expect(fake.nodes).toHaveLength(0);
  });
});

describe("resource room player", () => {
  it("keeps semantic choice buttons beside the phaser renderer", () => {
    const html = renderToStaticMarkup(<WorldPlayer />);
    expect(html).toContain('data-renderer="phaser"');
    expect(html).toContain(">Begin<");
    expect(html).toContain("Use the text player");

    const controller = createPlayerController(sharedShelf);
    controller.beginPlay();
    const view = presentPlayer(controller.snapshot(), sharedShelfPresentation);
    const sceneHtml = renderToStaticMarkup(
      <PlayerScreen
        view={view}
        renderer={{ kind: "phaser", Visual: () => null }}
        onBegin={() => {}}
        onChoose={() => {}}
        onReplay={() => {}}
      />,
    );
    expect(sceneHtml).toContain('data-choice="share-now"');
    expect(sceneHtml).toContain("Hand over the drill");
    expect(sceneHtml).toContain('aria-live="polite"');
    expect(sceneHtml).not.toContain("<canvas");
  });
});

function rigEngine() {
  const created: Array<{ key: string; angle: number }> = [];
  const tweens: Array<{ stop(): void }> = [];
  const destroyed: object[] = [];
  const zones: Array<ReturnType<typeof fakeZone>> = [];
  function sprite(key: string) {
    const node = {
      key,
      angle: 0,
      x: 0,
      y: 0,
      setOrigin() {
        return this;
      },
      setDisplaySize() {
        return this;
      },
      setFlipX() {
        return this;
      },
      destroy() {
        destroyed.push(node);
      },
    };
    created.push(node);
    return node;
  }
  function container(x: number, y: number) {
    const node = {
      x,
      y,
      angle: 0,
      children: [] as Array<{ destroy(): void }>,
      add(children: Array<{ destroy(): void }>) {
        node.children.push(...children);
      },
      setDepth() {},
      destroy() {
        for (const child of node.children) child.destroy();
        destroyed.push(node);
      },
    };
    return node;
  }
  class Scene {
    add = {
      graphics: () => ({
        clear() {},
        fillStyle() {},
        fillRect() {},
        fillCircle() {},
        fillRoundedRect() {},
        lineStyle() {},
        strokeRect() {},
      }),
      zone: () => {
        const zone = fakeZone();
        zones.push(zone);
        return zone;
      },
      image: (_x: number, _y: number, key: string) => sprite(key),
      container,
    };
    tweens = {
      add(config: { targets: object }) {
        const tween = {
          targets: config.targets,
          stop() {
            const index = tweens.indexOf(tween);
            if (index >= 0) tweens.splice(index, 1);
          },
        };
        tweens.push(tween);
        return tween;
      },
      killTweensOf() {},
    };
    textures = {
      exists() {
        return false;
      },
      remove() {},
      addImage() {},
    };
    game = { canvas: { tabIndex: 0, setAttribute() {} } };
  }
  class Game {
    constructor(config: { parent: { appendChild(node: { remove(): void }): void }; scene: { create: () => void } }) {
      config.parent.appendChild({ remove() {} });
      config.scene.create.call(new Scene());
    }
    destroy() {}
  }
  const parent = {
    dataset: {} as DOMStringMap,
    appendChild() {},
  };
  return {
    engine: { AUTO: 0, Game, Scene, Scale: { FIT: 1, CENTER_BOTH: 1 } },
    parent,
    created,
    tweens,
    destroyed,
    zones,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("resource-room character", () => {
  it("follows presentation cues, replays, and cleans up", async () => {
    const fake = rigEngine();
    const adapter = createShelfAdapter({
      onIntent() {},
      loadEngine: async () => fake.engine as never,
      prepareCharacter: async () => {},
    });
    await adapter.mount(fake.parent as never);
    adapter.render({ ...opening, reducedMotion: false, revision: 0 });
    await flush();
    expect(fake.parent.dataset.character).toBe("abena");
    expect(fake.parent.dataset.characterReaction).toBe("greet");
    expect(fake.parent.dataset.characterMotion).toBe("tween");
    expect(fake.parent.dataset.characterFallback).toBe("sprite");
    const leftArm = fake.created.find((node) => node.key === GUIDE_TEXTURES.arm);
    expect(leftArm?.angle).toBe(CHARACTER_POSES.greet.leftArm);
    const tweenCount = fake.tweens.length;
    adapter.render({ ...opening, reducedMotion: false, revision: 0 });
    expect(fake.tweens.length).toBe(tweenCount);

    adapter.render({
      ...opening,
      sceneId: "card-ending",
      choices: [],
      completed: true,
      reducedMotion: false,
      revision: 2,
    });
    expect(fake.parent.dataset.characterReaction).toBe("celebrate");
    expect(leftArm?.angle).toBe(CHARACTER_POSES.celebrate.leftArm);

    adapter.render({ ...opening, reducedMotion: true, revision: 0 });
    expect(fake.parent.dataset.characterReaction).toBe("greet");
    expect(fake.parent.dataset.characterMotion).toBe("hold");
    expect(fake.tweens).toHaveLength(0);

    adapter.render({ ...opening, reducedMotion: false, revision: 3 });
    expect(fake.parent.dataset.characterReaction).toBe("greet");
    expect(leftArm?.angle).toBe(CHARACTER_POSES.greet.leftArm);
    expect(fake.tweens.length).toBeGreaterThan(0);
    adapter.destroy();
    expect(fake.tweens).toHaveLength(0);
    expect(fake.destroyed.length).toBeGreaterThan(0);
  });

  it("keeps the painted neighbor when the character asset fails", async () => {
    const fake = rigEngine();
    const intents: string[] = [];
    const adapter = createShelfAdapter({
      onIntent(intent) {
        intents.push(intent.choiceId);
      },
      loadEngine: async () => fake.engine as never,
      prepareCharacter: async () => {
        throw new Error("character-asset-unavailable");
      },
    });
    await adapter.mount(fake.parent as never);
    adapter.render(opening);
    await flush();
    expect(fake.parent.dataset.characterFallback).toBe("painted");
    expect(fake.created).toHaveLength(0);
    fake.zones[0]?.press();
    expect(intents).toEqual(["share-now"]);
    adapter.destroy();
  });

  it("does not build a rig after unmount", async () => {
    const fake = rigEngine();
    let release: (() => void) | undefined;
    const adapter = createShelfAdapter({
      onIntent() {},
      loadEngine: async () => fake.engine as never,
      prepareCharacter: () =>
        new Promise((resolve) => {
          release = () => resolve();
        }),
    });
    await adapter.mount(fake.parent as never);
    adapter.destroy();
    release?.();
    await flush();
    expect(fake.created).toHaveLength(0);
  });
});
