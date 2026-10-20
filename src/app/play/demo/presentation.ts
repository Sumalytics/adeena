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
    ask: { description: "A shelf holding a drill, with a card nearby.", decorative: false },
    purpose: { description: "A loose chair that needs a small repair.", decorative: false },
    record: { description: "A record card and a shelf keeper beside the shelf.", decorative: false },
    board: { description: "A community board with open requests.", decorative: false },
    "card-ending": { description: "A filled record card on the shelf.", decorative: false },
    "hand-tool-ending": { description: "A screwdriver offered instead of the drill.", decorative: false },
    "posted-ending": { description: "A request posted on the community board.", decorative: false },
    "keeper-ending": { description: "The shelf keeper has been told who borrowed the drill.", decorative: false },
  },
};
