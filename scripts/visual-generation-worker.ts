import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/db/client";
import { visualWorkerDatabaseUrl } from "../src/db/env";
import { runVisualGenerationWorkerOnce } from "../src/db/visual-generation-worker";

const once = process.argv.includes("--once");
const pollMs = boundedNumber(process.env.ADEENA_VISUAL_WORKER_POLL_MS, 1_000, 100, 30_000);
const leaseMs = boundedNumber(process.env.ADEENA_VISUAL_WORKER_LEASE_MS, 120_000, 60_000, 300_000);
const workerId = `visual-${process.pid}-${randomUUID().slice(0, 8)}`;
const sql = openDatabase(visualWorkerDatabaseUrl());
let stopping = false;

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

process.stdout.write(JSON.stringify({ event: "visual-worker-started", workerId, pollMs, leaseMs, startupMs: Math.round(performance.now()) }) + "\n");
try {
  do {
    const started = Date.now();
    const timing: { claim: { jobId: string; attemptCount: number; queueDelayMs: number } | null } = { claim: null };
    const result = await runVisualGenerationWorkerOnce({ sql, leaseOwner: workerId, leaseMs, onClaim: (claim) => { timing.claim = claim; } });
    if (result) process.stdout.write(JSON.stringify({ event: "visual-job-finished", workerId, jobId: result.jobId, status: result.status, failureCode: result.reason, attemptCount: timing.claim?.attemptCount, queueDelayMs: timing.claim?.queueDelayMs, completionMs: Date.now() - started }) + "\n");
    if (once || stopping) break;
    if (!result) await delay(pollMs);
  } while (!stopping);
} finally {
  await sql.end({ timeout: 5 });
  process.stdout.write(JSON.stringify({ event: "visual-worker-stopped", workerId }) + "\n");
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error("Invalid visual worker timing configuration");
  return parsed;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
