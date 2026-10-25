import type { Sql } from "postgres";
import { Uuid } from "@/contracts/common";
import { SourceError } from "@/source/errors";

const claimBrand = Symbol("adeena.visual-worker-claim");

export type VisualWorkerClaim = {
  readonly [claimBrand]: true;
  readonly jobId: string;
  readonly workspaceId: string;
  readonly experienceVersionId: string;
  readonly idempotencyKey: string;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly createdBy: string;
  readonly status: "queued" | "planning" | "reviewing";
  readonly attemptCount: number;
  readonly createdAt: Date;
};

function workerName(value: string) {
  if (!/^[a-z0-9-]{1,80}$/.test(value)) throw new SourceError("invalid-generation");
  return value;
}

export async function claimVisualGenerationJob(input: { sql: Sql; leaseOwner: string; leaseMs?: number; jobId?: string }): Promise<VisualWorkerClaim | null> {
  const owner = workerName(input.leaseOwner);
  const leaseMs = input.leaseMs ?? 120_000;
  if (!Number.isInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 300_000) throw new SourceError("invalid-generation");
  const jobId = input.jobId === undefined ? null : Uuid.parse(input.jobId);
  const rows = await input.sql<{
    job_id: string; workspace_id: string; experience_version_id: string; idempotency_key: string;
    lease_token: string; created_by: string; status: VisualWorkerClaim["status"]; attempt_count: number; created_at: Date;
  }[]>`select * from adeena.claim_visual_generation_job(${owner}::text,${Math.ceil(leaseMs / 1_000)}::integer,${jobId}::uuid)`;
  const row = rows[0];
  if (!row) return null;
  return {
    [claimBrand]: true,
    jobId: Uuid.parse(row.job_id), workspaceId: Uuid.parse(row.workspace_id), experienceVersionId: Uuid.parse(row.experience_version_id),
    idempotencyKey: Uuid.parse(row.idempotency_key), leaseOwner: owner, leaseToken: Uuid.parse(row.lease_token),
    createdBy: Uuid.parse(row.created_by), status: row.status, attemptCount: Number(row.attempt_count),
    createdAt: new Date(row.created_at),
  };
}

export async function withVisualWorkerClaim<T>(sql: Sql, claim: VisualWorkerClaim, run: (scope: { tx: Sql; workspaceId: string; userId: string }) => Promise<T>) {
  if (!claim || claim[claimBrand] !== true) throw new SourceError("unauthenticated");
  return sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    const activated = await tx<{ workspace_id: string }[]>`select adeena.activate_visual_generation_claim(${claim.jobId}::uuid,${claim.leaseOwner},${claim.leaseToken}::uuid)::text as workspace_id`;
    if (activated[0]?.workspace_id !== claim.workspaceId) throw new SourceError("unauthenticated");
    return run({ tx, workspaceId: claim.workspaceId, userId: claim.createdBy });
  });
}
