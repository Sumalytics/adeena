import { GUIDE_TEXTURES } from "./asset";
import { CHARACTER_POSES, type PoseName } from "./poses";
import type { CharacterMotion } from "./reactions";

const ROOT_Y = 102;
const EYES = { x: 0, y: -24 };

type Sprite = {
  angle: number;
  x: number;
  y: number;
  setOrigin(x: number, y: number): Sprite;
  setDisplaySize(width: number, height: number): Sprite;
  setFlipX?(flip: boolean): Sprite;
  destroy(): void;
};

type RigNode = {
  angle: number;
  x: number;
  y: number;
  add(children: object[]): void;
  setDepth?(depth: number): void;
  destroy(): void;
};

export type CharacterScene = {
  add: {
    image(x: number, y: number, key: string): Sprite;
    container(x: number, y: number): RigNode;
  };
  tweens: {
    add(config: {
      targets: object;
      duration: number;
      yoyo?: boolean;
      repeat?: number;
      ease?: string;
      angle?: number;
      x?: number;
      y?: number;
    }): { stop(): void };
    killTweensOf(target: object): void;
  };
};

export type CharacterSnapshot = {
  pose: PoseName | null;
  motion: CharacterMotion | null;
  leftArm: number;
  rightArm: number;
  head: number;
  eyesX: number;
  eyesY: number;
  x: number;
  y: number;
  tweens: number;
  destroyed: boolean;
};

export type CharacterRig = {
  play(pose: PoseName, options: { motion: CharacterMotion; stand: number }): void;
  destroy(): void;
  snapshot(): CharacterSnapshot;
};

function place(sprite: Sprite, x: number, y: number, originX: number, originY: number, width: number, height: number) {
  sprite.setOrigin(originX, originY);
  sprite.setDisplaySize(width, height);
  sprite.x = x;
  sprite.y = y;
  return sprite;
}

/**
 * Layered guide inside an existing Phaser scene.
 * The caller supplies the pose. This object does not read player-core.
 */
export function createCharacterRig(scene: CharacterScene): CharacterRig {
  const root = scene.add.container(112, ROOT_Y);
  root.setDepth?.(5);
  const torso = place(scene.add.image(0, 16, GUIDE_TEXTURES.torso), 0, 16, 0.5, 0, 56, 78);
  const leftArm = place(scene.add.image(-22, 24, GUIDE_TEXTURES.arm), -22, 24, 0.5, 0.05, 14, 62);
  const rightArm = place(scene.add.image(22, 24, GUIDE_TEXTURES.arm), 22, 24, 0.5, 0.05, 14, 62);
  rightArm.setFlipX?.(true);
  const head = scene.add.container(0, 16);
  const face = place(scene.add.image(0, 0, GUIDE_TEXTURES.head), 0, 0, 0.5, 1, 52, 48);
  const eyes = place(scene.add.image(EYES.x, EYES.y, GUIDE_TEXTURES.eyes), EYES.x, EYES.y, 0.5, 0.5, 30, 13);
  head.add([face, eyes]);
  root.add([torso, leftArm, rightArm, head]);

  const live = new Set<{ stop(): void }>();
  let pose: PoseName | null = null;
  let motion: CharacterMotion | null = null;
  let destroyed = false;

  function stopMotion() {
    for (const tween of live) tween.stop();
    live.clear();
    scene.tweens.killTweensOf(root);
    scene.tweens.killTweensOf(leftArm);
    scene.tweens.killTweensOf(rightArm);
    scene.tweens.killTweensOf(head);
    scene.tweens.killTweensOf(eyes);
  }

  function loop(target: object, props: { angle?: number; y?: number }, duration: number, repeat: number) {
    const tween = scene.tweens.add({
      targets: target,
      duration,
      yoyo: true,
      repeat,
      ease: "Sine.easeInOut",
      ...props,
    });
    live.add(tween);
  }

  return {
    play(next, options) {
      if (destroyed) return;
      stopMotion();
      const recipe = CHARACTER_POSES[next];
      root.x = options.stand;
      root.y = ROOT_Y - recipe.rise;
      leftArm.x = -22;
      leftArm.y = 24;
      rightArm.x = 22;
      rightArm.y = 24;
      leftArm.angle = recipe.leftArm;
      rightArm.angle = recipe.rightArm;
      head.angle = recipe.head;
      eyes.x = EYES.x + recipe.eyesX;
      eyes.y = EYES.y + recipe.eyesY;
      pose = next;
      motion = options.motion;
      if (options.motion === "hold") return;
      if (next === "idle") loop(root, { y: ROOT_Y - 3 }, 900, -1);
      if (next === "greet") loop(leftArm, { angle: recipe.leftArm - 28 }, 280, -1);
      if (next === "think") loop(head, { angle: recipe.head + 4 }, 800, -1);
      if (next === "celebrate") loop(root, { y: ROOT_Y - recipe.rise - 8 }, 220, 1);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopMotion();
      root.destroy();
    },
    snapshot() {
      return {
        pose,
        motion,
        leftArm: leftArm.angle,
        rightArm: rightArm.angle,
        head: head.angle,
        eyesX: eyes.x,
        eyesY: eyes.y,
        x: root.x,
        y: root.y,
        tweens: live.size,
        destroyed,
      };
    },
  };
}
