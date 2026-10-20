import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guideCharacter } from "./asset";
import { readCharacterLayers } from "./parse";
import { poseSignature, type PoseName } from "./poses";
import { animationFor, characterCue, characterCueChanged, reactionForScene } from "./reactions";

const svg = readFileSync(guideCharacter.file, "utf8");

describe("character reactions", () => {
  it("greets at the shelf and thinks during the dilemmas", () => {
    expect(reactionForScene("ask")).toBe("greet");
    expect(reactionForScene("purpose")).toBe("think");
    expect(reactionForScene("record")).toBe("think");
    expect(reactionForScene("board")).toBe("think");
  });

  it("celebrates only the authored card closing and leaves the other endings at rest", () => {
    expect(reactionForScene("card-ending")).toBe("celebrate");
    for (const sceneId of ["hand-tool-ending", "posted-ending", "keeper-ending"]) {
      expect(reactionForScene(sceneId)).toBe("idle");
    }
    expect(reactionForScene("unknown-scene")).toBe("idle");
  });

  it("keeps unsupported reactions on the resting pose", () => {
    expect(animationFor("explain")).toEqual({ name: "idle", supported: false });
    expect(animationFor("react-concerned")).toEqual({ name: "idle", supported: false });
    expect(animationFor("listen")).toEqual({ name: "idle", supported: false });
    expect(animationFor("celebrate")).toEqual({ name: "celebrate", supported: true });
  });

  it("changes the cue for a new scene, a replay, or reduced motion", () => {
    const greet = characterCue({ sceneId: "ask", reducedMotion: false, revision: 0, stand: 112 });
    expect(greet).toEqual({ pose: "greet", motion: "tween", stand: 112, revision: 0 });
    expect(characterCueChanged(null, greet)).toBe(true);
    expect(characterCueChanged(greet, greet)).toBe(false);
    expect(characterCueChanged(greet, { ...greet, revision: 4 })).toBe(true);
    expect(characterCue({ sceneId: "purpose", reducedMotion: false, revision: 1, stand: 112 }).pose).toBe("think");
    expect(characterCue({ sceneId: "card-ending", reducedMotion: true, revision: 2, stand: 112 }).motion).toBe("hold");
    expect(characterCue({ sceneId: "keeper-ending", reducedMotion: false, revision: 2, stand: 112 })).toMatchObject({
      pose: "idle",
      motion: "tween",
    });
  });

  it("does not derive the pose from score variables", () => {
    const source = readFileSync("src/player/character/reactions.ts", "utf8");
    expect(source).not.toContain("completed");
    expect(source).not.toContain("shared-tools");
    expect(source).not.toContain("repairs");
    expect(source).not.toContain("@adeena/player-core");
  });
});

describe("character artwork", () => {
  it("splits one lightweight SVG into head, torso, eyes, and arms", () => {
    const layers = readCharacterLayers(svg);
    expect(layers.head.width).toBeGreaterThan(0);
    expect(layers.torso.markup).toContain("#176345");
    expect(layers.eyes.markup).toContain("#173329");
    expect(layers.arm.markup).not.toContain("translate");
    expect(svg).toContain('id="arms"');
    const poses: PoseName[] = ["idle", "greet", "think", "celebrate"];
    expect(new Set(poses.map(poseSignature)).size).toBe(4);
    const bytes = Buffer.byteLength(svg);
    expect(bytes).toBeGreaterThan(800);
    expect(bytes).toBeLessThan(6000);
  });

  it("records original art with no external downloads and no animation runtime", () => {
    expect(guideCharacter.externalDownloads).toBe(0);
    expect(guideCharacter.license).toContain("Original");
    expect(guideCharacter.animationRuntime).toBe("phaser-tweens");
    expect(guideCharacter.palette).toBe("Living Knowledge");
    const manifest = readFileSync("package.json", "utf8");
    expect(manifest).not.toContain("@rive-app");
    expect(manifest).not.toContain("lottie");
  });

  it("stays out of the engine, homepage, studio, and text player", () => {
    const files = [
      "packages/player-core/src/index.ts",
      "src/app/page.tsx",
      "src/app/studio/page.tsx",
      "src/app/studio/studio-app.tsx",
      "src/app/play/demo/demo-player.tsx",
      "src/app/play/demo/renderer.tsx",
    ];
    const routes = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(routes).not.toContain("@rive-app");
    expect(routes).not.toContain("/vendor/rive");
    expect(routes).not.toContain(guideCharacter.runtimePath);
    expect(routes).not.toContain("phaser");
    const character = ["reactions.ts", "rig.ts", "textures.ts", "parse.ts", "poses.ts"]
      .map((file) => readFileSync(`src/player/character/${file}`, "utf8"))
      .join("\n");
    expect(character).not.toContain("@adeena/player-core");
    expect(character).not.toContain("@rive-app");
  });
});
