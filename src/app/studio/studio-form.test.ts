import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { previewJob, scoreJob, shareJob } from "@/studio/http";
import { clearJobsForTests } from "@/studio/jobs";
import {
  AUDIENCE_OPTIONS,
  canGeneratePreview,
  initialStudioDraft,
  previewPayload,
  studioReducer,
} from "./studio-form";

describe("Creator Studio audience selection", () => {
  it("accepts only the eight audience options", () => {
    expect(AUDIENCE_OPTIONS).toEqual([
      "Early childhood",
      "Primary learners",
      "Junior secondary learners",
      "Senior secondary learners",
      "Higher education",
      "Workplace learners",
      "Community learners",
      "General audience",
    ]);
    expect(canGeneratePreview({ sourceLabel: "A river", audienceLabel: "", ageBand: "8-10" })).toBe(false);
    expect(
      canGeneratePreview({
        sourceLabel: "A river",
        audienceLabel: "A general science class",
        ageBand: "8-10",
      }),
    ).toBe(false);
    expect(
      canGeneratePreview({ sourceLabel: "A river", audienceLabel: "Primary learners", ageBand: "8-10" }),
    ).toBe(true);
    expect(
      canGeneratePreview({ sourceLabel: "   ", audienceLabel: "Primary learners", ageBand: "8-10" }),
    ).toBe(false);
    expect(
      canGeneratePreview({ sourceLabel: "A river", audienceLabel: "Primary learners", ageBand: "" }),
    ).toBe(false);
  });

  it("sends the selected audience label without changing the age band", () => {
    const body = previewPayload({
      idempotencyKey: "10000000-0000-4000-8000-000000000010",
      sourceLabel: "Water moves from clouds to rivers.",
      audienceLabel: "Workplace learners",
      ageBand: "adult",
    });
    expect(body.audience).toEqual({ label: "Workplace learners", ageBand: "adult" });
  });

  it("clears a preview when the audience changes and keeps the age band", () => {
    const ready = studioReducer(
      {
        ...initialStudioDraft<string>(),
        sourceLabel: "A river",
        audienceLabel: "Primary learners",
        ageBand: "8-10",
        preview: "job-1",
        optionId: "opt-source",
        scoreText: "1 point",
        shareReasons: ["Sharing is blocked."],
      },
      { type: "audience", value: "Community learners" },
    );
    expect(ready.audienceLabel).toBe("Community learners");
    expect(ready.ageBand).toBe("8-10");
    expect(ready.preview).toBeNull();
    expect(ready.optionId).toBe("");
    expect(ready.scoreText).toBe("");
    expect(ready.shareReasons).toBeNull();
  });
});

describe("Creator Studio safeguards still hold for a dropdown audience", () => {
  beforeEach(() => {
    clearJobsForTests();
  });

  it("previews, scores, and blocks sharing", () => {
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
