import type { ExperiencePresentation } from "@/player/types";

/**
 * Explicit Shared Shelf display copy.
 * These labels are not produced by rewriting variable ids.
 * The experience schema still has no versioned learner-facing labels or illustration descriptions.
 * A later schema revision should carry that display metadata.
 */
export const sharedShelfPresentation: ExperiencePresentation = {
  intro:
    "A neighbor is at the shared shelf. What happens next depends on what you lend, what you record, and who you tell.",
  variables: [
    {
      id: "shared-tools",
      label: "Tools on the shelf",
      changeText: (before, after) => `Tools on the shelf went from ${before} to ${after}.`,
    },
    {
      id: "repairs",
      label: "Repairs recorded",
      changeText: (before, after) => `Repairs recorded went from ${before} to ${after}.`,
    },
    {
      id: "keepers",
      label: "Keeper notes",
      changeText: (before, after) => `Keeper notes went from ${before} to ${after}.`,
    },
  ],
  scenes: {
    ask: { description: "A resource-room shelf in daylight, with hand tools, a drill, and a blank record card.", decorative: false },
    purpose: { description: "A worktable and a loose chair in the resource room.", decorative: false },
    record: { description: "The record card and the shelf keeper beside the shelf.", decorative: false },
    board: { description: "A noticeboard on the resource-room wall. The shelf is still in the room.", decorative: false },
    "card-ending": { description: "A filled record card on the counter. The drill is off the shelf.", decorative: false },
    "hand-tool-ending": { description: "A screwdriver offered at the table. The drill stays on the shelf.", decorative: false },
    "posted-ending": { description: "A request pinned to the noticeboard. The drill stays on the shelf.", decorative: false },
    "keeper-ending": { description: "The shelf keeper has a note naming who borrowed the drill. No card was written.", decorative: false },
  },
};
