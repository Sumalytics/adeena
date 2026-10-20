/**
 * One reusable guide for Adeena scenes.
 * The drawing is original project geometry. It is not approved brand art
 * and it is not a cultural validation.
 */
export const guideCharacter = {
  assetId: "abena",
  file: "public/character/abena.svg",
  runtimePath: "/character/abena.svg",
  role: "Resource room guide",
  palette: "Living Knowledge",
  license: "Original work owned by the Adeena project.",
  provenance:
    "Original layered SVG drawn for Adeena. Contemporary shirt and trousers, one adult, one hairstyle. Not approved brand art and not a cultural validation.",
  animationRuntime: "phaser-tweens",
  externalDownloads: 0,
  production: {
    artwork: "One reusable SVG with separate head, torso, eyes, and arms. No external illustration service.",
    motion: "Four pose recipes driven by the Phaser tween system already in the resource room.",
    maintenance: "Edit the SVG layers or the pose table. Do not generate a new character per experience.",
  },
} as const;

export const GUIDE_TEXTURES = {
  torso: "abena-torso",
  head: "abena-head",
  eyes: "abena-eyes",
  arm: "abena-arm",
} as const;

export const GUIDE_LAYER_IDS = ["torso", "head", "eyes", "arm"] as const;

export type GuideLayerId = (typeof GUIDE_LAYER_IDS)[number];
