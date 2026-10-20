import { createHash, randomUUID } from "node:crypto";
import { buildApproval } from "@/contracts/approval";
import type { EduFailV1 } from "@/contracts/edu-fail";
import { EduFailV1 as EduFailSchema } from "@/contracts/edu-fail";
import { syntheticCost } from "@/contracts/gen-cost";
import { LdbV1 } from "@/contracts/ldb";
import { PlayerV1 } from "@/contracts/player";
import { assessRisk } from "@/contracts/risk";
import { SYNTHETIC_WORKSPACE_ID } from "@/contracts/common";
import type { AccessV1 } from "@/contracts/access";
import type { ApprovalV1 } from "@/contracts/approval";
import type { GenCostV1 } from "@/contracts/gen-cost";
import type { LdbV1 as LdbRecord } from "@/contracts/ldb";
import type { PlayerV1 as PlayerRecord } from "@/contracts/player";
import type { RiskV1 } from "@/contracts/risk";

export type StudioEvent =
  | { name: "studio.preview_ready"; jobId: string }
  | { name: "studio.share_blocked"; jobId: string; reasons: string[] }
  | {
      name: "cost.recorded";
      jobId: string;
      currency: "USD";
      minor: number;
      status: "unbilled";
    };

export type StoredJob = {
  inputHash: string;
  guestId: string;
  brief: LdbRecord;
  player: PlayerRecord;
  risk: RiskV1;
  approval: ApprovalV1;
  eduFails: EduFailV1[];
  cost: GenCostV1;
  events: StudioEvent[];
};

const jobsByKey = new Map<string, StoredJob>();
const jobsById = new Map<string, StoredJob>();

export function clearJobsForTests() {
  jobsByKey.clear();
  jobsById.clear();
}

export function hashInput(input: {
  sourceLabel: string;
  audienceLabel: string;
  ageBand: string;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceLabel: input.sourceLabel,
        audienceLabel: input.audienceLabel,
        ageBand: input.ageBand,
      }),
    )
    .digest("hex");
}

function locatorFor(label: string) {
  const digest = createHash("sha256").update(label).digest("hex").slice(0, 24);
  return `synthetic:${digest}`;
}

function buildEduFails(input: {
  experienceVersionId: string;
  sourceId: string;
  sourceLabel: string;
  ageBand: string;
  now: string;
}): EduFailV1[] {
  const fails: EduFailV1[] = [];
  if (input.sourceLabel.trim().length < 12) {
    fails.push(
      EduFailSchema.parse({
        contract: "EDU-FAIL-v1",
        id: randomUUID(),
        experienceVersionId: input.experienceVersionId,
        code: "source-gap",
        severity: "block",
        message: "The source is too thin to trace a learning claim.",
        sourceRef: input.sourceId,
        recordedAt: input.now,
      }),
    );
  }
  if (input.ageBand === "unspecified") {
    fails.push(
      EduFailSchema.parse({
        contract: "EDU-FAIL-v1",
        id: randomUUID(),
        experienceVersionId: input.experienceVersionId,
        code: "age-mismatch",
        severity: "warn",
        message: "The audience age band is still unspecified.",
        sourceRef: input.sourceId,
        recordedAt: input.now,
      }),
    );
  }
  return fails;
}

export function createJob(input: {
  idempotencyKey: string;
  sourceLabel: string;
  audienceLabel: string;
  ageBand: LdbRecord["audience"]["ageBand"];
  now?: Date;
}): { job: StoredJob; replayed: boolean } | { conflict: true } {
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const inputHash = hashInput(input);
  const existing = jobsByKey.get(input.idempotencyKey);
  if (existing) {
    if (existing.inputHash !== inputHash) return { conflict: true };
    return { job: existing, replayed: true };
  }

  const jobId = randomUUID();
  const briefId = randomUUID();
  const experienceId = randomUUID();
  const manifestId = randomUUID();
  const guestId = randomUUID();
  const sourceLabel = input.sourceLabel.trim();
  const locator = locatorFor(sourceLabel);
  const excerpt = sourceLabel.slice(0, 140);
  const narrationSource = excerpt.replace(/[.\s]+$/, "");

  const brief = LdbV1.parse({
    contract: "LDB-v1",
    id: briefId,
    version: 1,
    workspaceId: SYNTHETIC_WORKSPACE_ID,
    createdAt,
    source: {
      kind: "reference",
      label: sourceLabel,
      locator,
      contentHash: null,
      rightsStatus: "unverified",
    },
    audience: {
      label: input.audienceLabel.trim(),
      ageBand: input.ageBand,
    },
    status: "draft",
  });

  const narration = `Synthetic preview. Audience: ${brief.audience.label}. Source reference: ${narrationSource}. No model wrote this scene.`;
  const sceneBody = {
    id: "scene-1",
    title: "What can be shared from this source?",
    narration,
    interaction: {
      type: "choice" as const,
      options: [
        {
          id: "opt-source",
          label: `Stay with the source: "${excerpt}"`,
          correct: true,
        },
        {
          id: "opt-extra",
          label: "Add a new scientific claim that the source does not make.",
          correct: false,
        },
      ],
    },
  };
  const contentHash = createHash("sha256")
    .update(JSON.stringify(sceneBody))
    .digest("hex");

  const player = PlayerV1.parse({
    contract: "PLAYER-v1",
    id: manifestId,
    experienceId,
    version: 1,
    contentHash,
    objectives: ["Keep the preview inside the supplied source."],
    scenes: [sceneBody],
    rules: {
      engine: "adeena.rules.v1",
      scoring: "deterministic-choice",
    },
    runtime: {
      requiresLlm: false,
      executableScripts: false,
      animation: "css",
    },
    sources: [{ sourceId: brief.id, locator }],
  });

  const eduFails = buildEduFails({
    experienceVersionId: player.id,
    sourceId: brief.id,
    sourceLabel,
    ageBand: brief.audience.ageBand,
    now: createdAt,
  });
  const risk = assessRisk({
    experienceVersionId: player.id,
    rights: "unverified",
    privacy: "no-identifiable-learner",
  });
  const approval = buildApproval({
    experienceVersionId: player.id,
    risk,
    eduFails,
    now,
  });
  const cost = syntheticCost({
    jobId,
    experienceVersionId: player.id,
    idempotencyKey: input.idempotencyKey,
  });
  const events: StudioEvent[] = [
    { name: "studio.preview_ready", jobId },
    {
      name: "cost.recorded",
      jobId,
      currency: "USD",
      minor: 0,
      status: "unbilled",
    },
  ];

  const job: StoredJob = {
    inputHash,
    guestId,
    brief,
    player,
    risk,
    approval,
    eduFails,
    cost,
    events,
  };
  jobsByKey.set(input.idempotencyKey, job);
  jobsById.set(jobId, job);
  return { job, replayed: false };
}

export function getJob(jobId: string) {
  return jobsById.get(jobId) ?? null;
}

export function publicationDecision(input: {
  access: AccessV1;
  risk: RiskV1;
  approval: ApprovalV1;
  eduFails: EduFailV1[];
}) {
  const reasons: string[] = [];
  if (!input.access.allowed) {
    reasons.push("This guest identity cannot publish.");
  }
  if (!input.risk.publicationAllowed) {
    reasons.push("Source rights are not cleared.");
  }
  for (const fail of input.eduFails) {
    if (fail.severity === "block") reasons.push(fail.message);
  }
  if (input.approval.decision !== "approved") {
    reasons.push("Publication approval is not granted.");
  }
  return { allowed: reasons.length === 0, reasons };
}
