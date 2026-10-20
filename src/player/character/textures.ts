import { GUIDE_LAYER_IDS, GUIDE_TEXTURES, guideCharacter } from "./asset";
import { layerDocument, readLayer } from "./parse";

export type TextureScene = {
  textures: {
    exists(key: string): boolean;
    remove(key: string): void;
    addImage(key: string, source: HTMLImageElement): unknown;
  };
};

export function rasterizeSvg(document: string) {
  const blob = new Blob([document], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const finish = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    const fail = () => {
      URL.revokeObjectURL(url);
      reject(new Error("character-raster-failed"));
    };
    image.onload = () => {
      if (typeof image.decode !== "function") {
        finish();
        return;
      }
      image.decode().then(finish, fail);
    };
    image.onerror = fail;
    image.src = url;
  });
}

/** Loads the shared SVG once per scene. No animation service is called. */
export async function prepareGuideTextures(scene: TextureScene) {
  const response = await fetch(guideCharacter.runtimePath);
  if (!response.ok) throw new Error("character-asset-unavailable");
  const svg = await response.text();
  if (!svg.includes('id="torso"') || !svg.includes('id="head"') || !svg.includes('id="eyes"') || !svg.includes('id="arms"')) {
    throw new Error("character-asset-incomplete");
  }
  await Promise.all(
    GUIDE_LAYER_IDS.map(async (id) => {
      const image = await rasterizeSvg(layerDocument(readLayer(svg, id)));
      const key = GUIDE_TEXTURES[id];
      if (scene.textures.exists(key)) scene.textures.remove(key);
      scene.textures.addImage(key, image);
    }),
  );
}
