import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { parseManifest, sharedShelf } from "../../packages/experience-schema/src/index";
import { PlayerV1 } from "@/contracts/player";
import { scoreChoice } from "@/engine/score";
import { clearJobsForTests, createJob } from "@/studio/jobs";

describe("PLAYER-v1 compatibility", () => {
  beforeEach(() => {
    clearJobsForTests();
  });

  it("keeps synthetic scoring and does not treat PLAYER-v1 as branching dialogue", () => {
    const created = createJob({
      idempotencyKey: randomUUID(),
      sourceLabel: "Water moves from clouds to rivers and back again.",
      audienceLabel: "A general science class",
      ageBand: "8-10",
    });
    if ("conflict" in created) throw new Error("expected a studio job");
    expect(PlayerV1.parse(created.job.player).contract).toBe("PLAYER-v1");
    expect(scoreChoice(created.job.player, "scene-1", "opt-source")).toEqual({
      status: "scored",
      correct: true,
      points: 1,
    });

    const legacyAsBranching = parseManifest(created.job.player);
    expect(legacyAsBranching.ok).toBe(false);
    expect(legacyAsBranching.diagnostics.map((item) => item.code)).toContain("schema.unknown-field");

    expect(PlayerV1.safeParse(sharedShelf).success).toBe(false);
    const branching = parseManifest(sharedShelf);
    expect(branching.ok).toBe(true);
    if (branching.ok) expect(branching.manifest.mechanics).toEqual(["branching-dialogue@1"]);
  });
});
