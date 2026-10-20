import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { scoreChoice } from "@/engine/score";
import { previewJob, scoreJob, shareJob } from "@/studio/http";
import { clearJobsForTests, createJob } from "@/studio/jobs";

describe("player route leaves Creator Studio safeguards in place", () => {
  beforeEach(() => {
    clearJobsForTests();
  });

  it("keeps preview, scoring, and blocked sharing unchanged", () => {
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

    const job = createJob({
      idempotencyKey: randomUUID(),
      sourceLabel: "Water moves from clouds to rivers and back again.",
      audienceLabel: "A general science class",
      ageBand: "8-10",
    });
    if ("conflict" in job) throw new Error("expected a studio job");
    expect(scoreChoice(job.job.player, "scene-1", "opt-source")).toEqual({
      status: "scored",
      correct: true,
      points: 1,
    });
  });
});
