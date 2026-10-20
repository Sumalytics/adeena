import { GUIDE_LAYER_IDS, type GuideLayerId } from "./asset";

export type CharacterLayer = {
  markup: string;
  width: number;
  height: number;
};

export function extractGroup(svg: string, id: string) {
  const marker = `id="${id}"`;
  const start = svg.indexOf(marker);
  if (start < 0) throw new Error(`character-layer-${id}`);
  const open = svg.lastIndexOf("<g", start);
  const contentStart = svg.indexOf(">", start);
  if (open < 0 || contentStart < 0) throw new Error(`character-layer-${id}`);
  let depth = 1;
  let index = contentStart + 1;
  while (index < svg.length && depth > 0) {
    const nextOpen = svg.indexOf("<g", index);
    const nextClose = svg.indexOf("</g>", index);
    if (nextClose < 0) throw new Error(`character-layer-${id}`);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      index = nextOpen + 2;
      continue;
    }
    depth -= 1;
    if (depth === 0) return svg.slice(open, nextClose + 4);
    index = nextClose + 4;
  }
  throw new Error(`character-layer-${id}`);
}

export function readLayer(svg: string, id: GuideLayerId): CharacterLayer {
  const markup = extractGroup(svg, id);
  const width = Number(/data-width="(\d+(?:\.\d+)?)"/.exec(markup)?.[1]);
  const height = Number(/data-height="(\d+(?:\.\d+)?)"/.exec(markup)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`character-layer-${id}`);
  }
  return { markup, width, height };
}

export function layerDocument(layer: CharacterLayer) {
  const width = layer.width * 2;
  const height = layer.height * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${layer.width} ${layer.height}">${layer.markup}</svg>`;
}

export function readCharacterLayers(svg: string) {
  return Object.fromEntries(GUIDE_LAYER_IDS.map((id) => [id, readLayer(svg, id)])) as Record<
    GuideLayerId,
    CharacterLayer
  >;
}
