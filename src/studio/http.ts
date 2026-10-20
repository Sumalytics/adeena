import { z } from "zod";
import { AgeBand, Uuid, plainText } from "@/contracts/common";
import { decideAccess } from "@/contracts/access";
import { scoreChoice } from "@/engine/score";
import {
  createJob,
  getJob,
  publicationDecision,
  type StudioEvent,
} from "@/studio/jobs";

export const PreviewInput = z
  .object({
    idempotencyKey: Uuid,
    source: z
      .object({
        label: plainText(500),
      })
      .strict(),
    audience: z
      .object({
        label: plainText(120),
        ageBand: AgeBand,
      })
      .strict(),
  })
  .strict();

const JobRequest = z
  .object({
    jobId: Uuid,
  })
  .strict();

const ScoreRequest = z
  .object({
    jobId: Uuid,
    sceneId: z.string().trim().min(1).max(80),
    optionId: z.string().trim().min(1).max(80),
  })
  .strict();

export type PlaybackOption = { id: string; label: string };
export type PlaybackScene = {
  id: string;
  title: string;
  narration: string;
  options: PlaybackOption[];
};

export type PlaybackBody = {
  jobId: string;
  version: number;
  scene: PlaybackScene;
  publication: { allowed: false; reasons: string[] };
  cost: { vendor: "synthetic"; currency: "USD"; minor: 0; status: "unbilled" };
  events: StudioEvent[];
};

function playback(jobId: string, job: NonNullable<ReturnType<typeof getJob>>): PlaybackBody {
  const scene = job.player.scenes[0];
  if (!scene || scene.interaction.type !== "choice") {
    throw new Error("Synthetic preview must contain one choice scene");
  }
  const access = decideAccess({
    actor: { kind: "guest", id: job.guestId },
    action: "publish",
    resource: { type: "experience", id: job.player.experienceId },
  });
  const publication = publicationDecision({
    access,
    risk: job.risk,
    approval: job.approval,
    eduFails: job.eduFails,
  });
  if (publication.allowed) {
    throw new Error("Guest preview produced a publishable experience");
  }
  return {
    jobId,
    version: job.player.version,
    scene: {
      id: scene.id,
      title: scene.title,
      narration: scene.narration,
      options: scene.interaction.options.map((option) => ({
        id: option.id,
        label: option.label,
      })),
    },
    publication: { allowed: false as const, reasons: publication.reasons },
    cost: { vendor: "synthetic", currency: "USD", minor: 0, status: "unbilled" },
    events: job.events,
  };
}

export type ApiResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; body: { error: string; issues?: string[] } };

export function previewJob(raw: unknown): ApiResult {
  const parsed = PreviewInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid-input",
        issues: parsed.error.issues.map((issue) => issue.message),
      },
    };
  }
  const created = createJob({
    idempotencyKey: parsed.data.idempotencyKey,
    sourceLabel: parsed.data.source.label,
    audienceLabel: parsed.data.audience.label,
    ageBand: parsed.data.audience.ageBand,
  });
  if ("conflict" in created) {
    return { ok: false, status: 409, body: { error: "idempotency-conflict" } };
  }
  return {
    ok: true,
    status: created.replayed ? 200 : 201,
    body: playback(created.job.cost.jobId, created.job),
  };
}

export function scoreJob(raw: unknown): ApiResult {
  const parsed = ScoreRequest.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 400, body: { error: "invalid-input" } };
  }
  const job = getJob(parsed.data.jobId);
  if (!job) return { ok: false, status: 404, body: { error: "unknown-job" } };
  const result = scoreChoice(job.player, parsed.data.sceneId, parsed.data.optionId);
  if (result.status !== "scored") {
    return { ok: false, status: 400, body: { error: result.status } };
  }
  return {
    ok: true,
    status: 200,
    body: { correct: result.correct, points: result.points },
  };
}

export function shareJob(raw: unknown): ApiResult {
  const parsed = JobRequest.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 400, body: { error: "invalid-input" } };
  }
  const job = getJob(parsed.data.jobId);
  if (!job) return { ok: false, status: 404, body: { error: "unknown-job" } };
  const access = decideAccess({
    actor: { kind: "guest", id: job.guestId },
    action: "publish",
    resource: { type: "experience", id: job.player.experienceId },
  });
  const decision = publicationDecision({
    access,
    risk: job.risk,
    approval: job.approval,
    eduFails: job.eduFails,
  });
  const reasons = decision.reasons;
  job.events.push({
    name: "studio.share_blocked",
    jobId: parsed.data.jobId,
    reasons,
  });
  return {
    ok: false,
    status: 403,
    body: {
      error: "publication-blocked",
      issues: reasons,
    },
  };
}
