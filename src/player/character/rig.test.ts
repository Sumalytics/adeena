import { describe, expect, it } from "vitest";
import { GUIDE_TEXTURES } from "./asset";
import { CHARACTER_POSES } from "./poses";
import { createCharacterRig, type CharacterScene } from "./rig";

type Sprite = ReturnType<CharacterScene["add"]["image"]>;

function fakeScene() {
  const tweens: Array<{ targets: object; stop(): void }> = [];
  const destroyed: object[] = [];
  function sprite(): Sprite {
    const node: Sprite = {
      angle: 0,
      x: 0,
      y: 0,
      setOrigin() {
        return node;
      },
      setDisplaySize() {
        return node;
      },
      setFlipX() {
        return node;
      },
      destroy() {
        destroyed.push(node);
      },
    };
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
  const scene: CharacterScene = {
    add: {
      image: () => sprite(),
      container,
    },
    tweens: {
      add(config) {
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
      killTweensOf(target) {
        for (let index = tweens.length - 1; index >= 0; index -= 1) {
          if (tweens[index]?.targets === target) tweens.splice(index, 1);
        }
      },
    },
  };
  return { scene, tweens, destroyed };
}

describe("character rig", () => {
  it("transitions between four distinct poses and replays the opening pose", () => {
    const fake = fakeScene();
    const rig = createCharacterRig(fake.scene);
    rig.play("idle", { motion: "tween", stand: 112 });
    expect(rig.snapshot()).toMatchObject({
      pose: "idle",
      leftArm: CHARACTER_POSES.idle.leftArm,
      rightArm: CHARACTER_POSES.idle.rightArm,
      tweens: 1,
    });

    rig.play("greet", { motion: "tween", stand: 112 });
    expect(rig.snapshot()).toMatchObject({
      pose: "greet",
      leftArm: CHARACTER_POSES.greet.leftArm,
      head: CHARACTER_POSES.greet.head,
      tweens: 1,
    });
    expect(rig.snapshot().leftArm).not.toBe(CHARACTER_POSES.idle.leftArm);

    rig.play("think", { motion: "tween", stand: 112 });
    const thinking = rig.snapshot();
    expect(thinking).toMatchObject({
      pose: "think",
      rightArm: CHARACTER_POSES.think.rightArm,
      head: CHARACTER_POSES.think.head,
      tweens: 1,
    });
    expect(thinking.eyesX).not.toBe(0);

    rig.play("celebrate", { motion: "tween", stand: 112 });
    expect(rig.snapshot()).toMatchObject({
      pose: "celebrate",
      leftArm: CHARACTER_POSES.celebrate.leftArm,
      rightArm: CHARACTER_POSES.celebrate.rightArm,
      y: 102 - CHARACTER_POSES.celebrate.rise,
      tweens: 1,
    });

    rig.play("greet", { motion: "tween", stand: 112 });
    expect(rig.snapshot()).toMatchObject({
      pose: "greet",
      leftArm: CHARACTER_POSES.greet.leftArm,
      rightArm: CHARACTER_POSES.greet.rightArm,
      tweens: 1,
    });
    expect(fake.tweens).toHaveLength(1);
  });

  it("holds a pose without tweens when motion is reduced", () => {
    const fake = fakeScene();
    const rig = createCharacterRig(fake.scene);
    rig.play("celebrate", { motion: "hold", stand: 156 });
    expect(rig.snapshot()).toMatchObject({
      pose: "celebrate",
      motion: "hold",
      leftArm: CHARACTER_POSES.celebrate.leftArm,
      rightArm: CHARACTER_POSES.celebrate.rightArm,
      x: 156,
      tweens: 0,
    });
    expect(fake.tweens).toHaveLength(0);
    rig.play("greet", { motion: "hold", stand: 112 });
    expect(rig.snapshot().tweens).toBe(0);
    expect(rig.snapshot().leftArm).toBe(CHARACTER_POSES.greet.leftArm);
  });

  it("destroys sprites and tweens, then ignores later poses", () => {
    const fake = fakeScene();
    const rig = createCharacterRig(fake.scene);
    rig.play("greet", { motion: "tween", stand: 112 });
    rig.destroy();
    expect(rig.snapshot().destroyed).toBe(true);
    expect(fake.tweens).toHaveLength(0);
    expect(fake.destroyed.length).toBeGreaterThan(0);
    rig.play("celebrate", { motion: "tween", stand: 112 });
    expect(rig.snapshot().pose).toBe("greet");
    expect(fake.tweens).toHaveLength(0);
    expect(GUIDE_TEXTURES.arm).toBe("abena-arm");
  });
});
