/**
 * Ghana-first presentation defaults for the resource room.
 * These values configure art. They are not gameplay rules.
 *
 * A future versioned presentation contract could carry a region, a material
 * palette, and object names beside the manifest, in the same way
 * ExperiencePresentation already carries learner-facing labels.
 * The v1 experience manifest is unchanged and has no culture field.
 * Creator Studio does not ask for a culture.
 */
export const ghanaResourceRoom = {
  profile: "ghana-resource-room",
  region: "GH",
  setting: "Community learning and resource room",
  provenance:
    "Original prototype geometry drawn in code for Adeena. Not approved brand art and not a cultural validation.",
  license: "Original work owned by the Adeena project.",
  externalDownloads: 0,
} as const;

export const ROOM_COLORS = {
  plaster: 0xf3e4cf,
  plasterShade: 0xe7d3b8,
  floor: 0xcbb89a,
  floorLine: 0xb59a78,
  wood: 0x8d5a32,
  woodDark: 0x5c3a22,
  forest: 0x176345,
  forestDeep: 0x103e2f,
  forestMid: 0x277655,
  orange: 0xed9343,
  cream: 0xfbf9f1,
  ink: 0x173329,
  skin: 0x6d3b2a,
  skinShade: 0x4e2a1e,
  shirt: 0x1f6b4a,
  trousers: 0x173329,
  metal: 0x8a9390,
  paper: 0xfffaf2,
  daylight: 0xfff6e4,
  sky: 0xd7ebe3,
} as const;

/** Modular pieces. Each one is drawn in code and can be reused by a later room. */
export const ROOM_MODULES = [
  "plaster-wall",
  "cement-floor",
  "daylight-window",
  "timber-shelf",
  "worktable",
  "hand-drill",
  "screwdriver",
  "record-card",
  "noticeboard",
  "side-chair",
  "keeper",
  "resource-guide",
] as const;
