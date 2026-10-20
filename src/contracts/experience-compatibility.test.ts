import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { parseManifest, sharedShelf } from "../../packages/experience-schema/src/index";
import { PlayerV1, type PlayerV1 as PlayerRecord } from "@/contracts/player";
import { scoreChoice } from "@/engine/score";
import { previewJob, scoreJob, shareJob } from "@/studio/http";
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
    expect(legacyAsBranching.diagnostics.map((item) => item.code)).not.toContain("runtime.defaulted");

    expect(PlayerV1.safeParse(sharedShelf).success).toBe(false);
    const branching = parseManifest(sharedShelf);
    expect(branching.ok).toBe(true);
    if (branching.ok) expect(branching.manifest.mechanics).toEqual(["branching-dialogue@1"]);
    expect(scoreChoice(sharedShelf as unknown as PlayerRecord, "ask", "share-now")).toEqual({
      status: "unknown-scene",
    });
  });

  it("previews and scores the synthetic studio contract and keeps sharing closed", () => {
    const created = previewJob({
      idempotencyKey: randomUUID(),
      source: { label: "Water moves from clouds to rivers and back again." },
      audience: { label: "A general science class", ageBand: "8-10" },
    });
    expect(created.status).toBe(201);
    const jobId = (created.body as { jobId: string }).jobId;
    expect(JSON.stringify(created.body)).not.toContain("correct");
    const scored = scoreJob({ jobId, sceneId: "scene-1", optionId: "opt-source" });
    expect(scored.status).toBe(200);
    expect(scored.body).toEqual({ correct: true, points: 1 });
    const shared = shareJob({ jobId });
    expect(shared.status).toBe(403);
    expect(shared.body).toMatchObject({ error: "publication-blocked" });
  });
});
