import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessV1, decideAccess } from "@/contracts/access";
import { ApprovalV1, buildApproval } from "@/contracts/approval";
import { PlayerV1 } from "@/contracts/player";
import { assessRisk } from "@/contracts/risk";
import { planRevision } from "@/contracts/rev";
import { scoreChoice } from "@/engine/score";
import { previewJob, scoreJob, shareJob } from "@/studio/http";
import { clearJobsForTests, createJob, publicationDecision } from "@/studio/jobs";

const source = "Water moves from clouds to rivers and back again.";
const audience = "A general science class";

function previewBody(idempotencyKey = randomUUID()) {
  return {
    idempotencyKey,
    source: { label: source },
    audience: { label: audience, ageBand: "8-10" as const },
  };
}

describe("creator studio contracts", () => {
  beforeEach(() => {
    clearJobsForTests();
  });

  it("builds an immutable synthetic preview and hides answer keys", () => {
    const first = previewJob(previewBody());
    expect(first.status).toBe(201);
    const body = first.body as {
      jobId: string;
      version: number;
      scene: { options: { id: string; label: string }[] };
      cost: { minor: number; vendor: string; status: string };
      publication: { allowed: boolean };
    };
    expect(body.version).toBe(1);
    expect(body.publication.allowed).toBe(false);
    expect(body.cost).toMatchObject({ minor: 0, vendor: "synthetic", status: "unbilled" });
    expect(JSON.stringify(body)).not.toContain("correct");

    const key = randomUUID();
    const created = createJob({
      idempotencyKey: key,
      sourceLabel: source,
      audienceLabel: audience,
      ageBand: "8-10",
    });
    if ("conflict" in created) throw new Error("expected a job");
    const replay = createJob({
      idempotencyKey: key,
      sourceLabel: source,
      audienceLabel: audience,
      ageBand: "8-10",
    });
    if ("conflict" in replay) throw new Error("expected a replay");
    expect(replay.replayed).toBe(true);
    expect(replay.job.player.id).toBe(created.job.player.id);
    expect(replay.job.player.version).toBe(1);

    const conflict = createJob({
      idempotencyKey: key,
      sourceLabel: "A different source with enough length.",
      audienceLabel: audience,
      ageBand: "8-10",
    });
    expect(conflict).toEqual({ conflict: true });
    expect(created.job.brief.version).toBe(1);
  });

  it("blocks sharing for a guest while rights are unverified", () => {
    const created = previewJob(previewBody());
    const jobId = (created.body as { jobId: string }).jobId;
    const shared = shareJob({ jobId });
    expect(shared.status).toBe(403);
    const issues = (shared.body as { issues: string[] }).issues;
    expect(issues).toContain("This guest identity cannot publish.");
    expect(issues).toContain("Source rights are not cleared.");
    expect(issues).toContain("Publication approval is not granted.");
  });

  it("adds a blocking educational failure when the source is too thin", () => {
    const created = previewJob({
      ...previewBody(),
      source: { label: "Rain" },
    });
    const jobId = (created.body as { jobId: string }).jobId;
    const shared = shareJob({ jobId });
    const issues = (shared.body as { issues: string[] }).issues;
    expect(issues).toContain("The source is too thin to trace a learning claim.");
  });

  it("scores from the rule table, not from narration text", () => {
    const key = randomUUID();
    const created = createJob({
      idempotencyKey: key,
      sourceLabel: source,
      audienceLabel: audience,
      ageBand: "11-13",
    });
    if ("conflict" in created) throw new Error("expected a job");
    const manifest = created.job.player;
    expect(scoreChoice(manifest, "scene-1", "opt-source")).toEqual({
      status: "scored",
      correct: true,
      points: 1,
    });
    expect(scoreChoice(manifest, "scene-1", "opt-extra")).toEqual({
      status: "scored",
      correct: false,
      points: 0,
    });
    expect(scoreChoice(manifest, "missing", "opt-source").status).toBe("unknown-scene");

    const scored = scoreJob({
      jobId: created.job.cost.jobId,
      sceneId: "scene-1",
      optionId: "opt-extra",
    });
    expect(scored.body).toEqual({ correct: false, points: 0 });
    expect(JSON.stringify(scored.body)).not.toContain("opt-source");
  });

  it("rejects learner scripts and an LLM playback runtime", () => {
    const created = createJob({
      idempotencyKey: randomUUID(),
      sourceLabel: source,
      audienceLabel: audience,
      ageBand: "adult",
    });
    if ("conflict" in created) throw new Error("expected a job");
    const player = created.job.player;
    expect(player.runtime).toEqual({
      requiresLlm: false,
      executableScripts: false,
      animation: "css",
    });
    expect(() =>
      PlayerV1.parse({
        ...player,
        runtime: { ...player.runtime, requiresLlm: true },
      }),
    ).toThrow();
    expect(() =>
      PlayerV1.parse({
        ...player,
        runtime: { ...player.runtime, executableScripts: true },
      }),
    ).toThrow();
    expect(() => PlayerV1.parse({ ...player, script: "alert(1)" })).toThrow();
  });

  it("keeps the parent version when planning a revision", () => {
    const parent = {
      version: 1,
      manifestId: randomUUID(),
      experienceId: randomUUID(),
    };
    Object.freeze(parent);
    const revision = planRevision(parent, "Clarify the source boundary");
    expect(parent.version).toBe(1);
    expect(revision.toVersion).toBe(2);
    expect(revision.safety.executableScriptsIntroduced).toBe(false);
  });

  it("allows publication only when access, rights, and approval all pass", () => {
    const experienceVersionId = randomUUID();
    const risk = assessRisk({
      experienceVersionId,
      rights: "cleared",
      privacy: "no-identifiable-learner",
    });
    const member = decideAccess({
      actor: { kind: "member", id: randomUUID() },
      action: "publish",
      resource: { type: "experience", id: randomUUID() },
    });
    const pending = buildApproval({
      experienceVersionId,
      risk,
      eduFails: [],
    });
    expect(pending.decision).toBe("pending");
    expect(
      publicationDecision({
        access: member,
        risk,
        approval: pending,
        eduFails: [],
      }).allowed,
    ).toBe(false);

    const approved = ApprovalV1.parse({
      contract: "APPROVAL-v1",
      id: randomUUID(),
      experienceVersionId,
      decision: "approved",
      blockers: [],
      decidedAt: new Date().toISOString(),
    });
    expect(
      publicationDecision({
        access: member,
        risk,
        approval: approved,
        eduFails: [],
      }).allowed,
    ).toBe(true);

    expect(() =>
      AccessV1.parse({
        ...decideAccess({
          actor: { kind: "guest", id: randomUUID() },
          action: "publish",
          resource: { type: "experience", id: randomUUID() },
        }),
        allowed: true,
      }),
    ).toThrow();
  });
});
