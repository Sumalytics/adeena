import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { previewJob, scoreJob, shareJob } from "@/studio/http";
import { clearJobsForTests } from "@/studio/jobs";

describe("existing Studio responses stay in place", () => {
  beforeEach(() => {
    clearJobsForTests();
  });

  it("returns preview 201, score 200, and share 403", () => {
    const created = previewJob({
      idempotencyKey: randomUUID(),
      source: { label: "Water moves from clouds to rivers and back again." },
      audience: { label: "Primary learners", ageBand: "8-10" },
    });
    expect(created.status).toBe(201);
    const jobId = (created.body as { jobId: string }).jobId;
    const scored = scoreJob({ jobId, sceneId: "scene-1", optionId: "opt-source" });
    expect(scored.status).toBe(200);
    expect(scored.body).toEqual({ correct: true, points: 1 });
    const shared = shareJob({ jobId });
    expect(shared.status).toBe(403);
    expect(shared.body).toMatchObject({ error: "publication-blocked" });
  });
});
