import { randomUUID } from "node:crypto";
import { SourceError } from "./errors";
import { acceptDocumentBytes, ingestDocument } from "./ingest";
import type { SourceLimits } from "./limits";
import { assertMembership, type VerifiedMembership } from "./membership";
import type { SourceStore } from "./store";

export type SourceJobState = "queued" | "processing" | "complete" | "partial" | "failed";

export type SourceJob = {
  id: string;
  workspaceId: string;
  actorId: string;
  contentHash: string;
  filename: string;
  byteCount: number;
  state: SourceJobState;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  permanent: boolean;
};

function jobRecord(value: unknown): SourceJob | null {
  if (!value || typeof value !== "object") return null;
  const job = value as SourceJob;
  if (typeof job.id !== "string" || typeof job.contentHash !== "string") return null;
  return job;
}

export async function enqueueSourceJob(input: {
  membership: VerifiedMembership;
  filename: string;
  bytes: Uint8Array;
  store: SourceStore;
  limits?: Partial<SourceLimits>;
  maxAttempts?: number;
}) {
  const membership = assertMembership(input.membership);
  const accepted = await acceptDocumentBytes(input);
  const job: SourceJob = {
    id: randomUUID(),
    workspaceId: membership.workspaceId,
    actorId: membership.actorId,
    contentHash: accepted.contentHash,
    filename: accepted.filename,
    byteCount: accepted.byteCount,
    state: "queued",
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 2,
    errorCode: null,
    permanent: false,
  };
  await input.store.writeJob(membership.workspaceId, job.id, job);
  return job;
}

async function save(store: SourceStore, job: SourceJob) {
  await store.writeJob(job.workspaceId, job.id, job);
}

export async function recoverSourceJobs(store: SourceStore, membership: VerifiedMembership) {
  const actor = assertMembership(membership);
  const jobs = (await store.listJobs(actor.workspaceId)).flatMap((value) => {
    const job = jobRecord(value);
    return job && job.workspaceId === actor.workspaceId ? [job] : [];
  });
  for (const job of jobs) {
    if (job.state !== "processing") continue;
    if (!job.permanent && job.attempts < job.maxAttempts) job.state = "queued";
    else {
      job.state = "failed";
      job.permanent = true;
      job.errorCode = job.errorCode ?? "transient";
    }
    await save(store, job);
  }
  return jobs;
}

export async function processSourceJobs(
  store: SourceStore,
  membership: VerifiedMembership,
  options?: {
    crashAfterMark?: boolean;
    transientFailures?: number;
    limits?: Partial<SourceLimits>;
  },
) {
  const actor = assertMembership(membership);
  await recoverSourceJobs(store, actor);
  let transientFailures = options?.transientFailures ?? 0;
  const jobs = (await store.listJobs(actor.workspaceId)).flatMap((value) => {
    const job = jobRecord(value);
    return job && job.workspaceId === actor.workspaceId ? [job] : [];
  });
  for (let pass = 0; pass < 4; pass += 1) {
    if (!jobs.some((job) => job.state === "queued")) break;
    for (const job of jobs) {
      if (job.state !== "queued") continue;
      job.state = "processing";
      job.attempts += 1;
      await save(store, job);
      if (options?.crashAfterMark) return jobs;
      try {
        if (transientFailures > 0) {
          transientFailures -= 1;
          throw new SourceError("transient");
        }
        const bytes = await store.readBytes(actor.workspaceId, job.contentHash);
        if (!bytes) throw new SourceError("integrity-mismatch");
        const ingested = await ingestDocument({
          membership: actor,
          filename: job.filename,
          bytes,
          store,
          limits: options?.limits,
        });
        job.state = ingested.extraction.status === "partial" ? "partial" : "complete";
        job.errorCode = null;
        job.permanent = false;
      } catch (error) {
        const failure = error instanceof SourceError ? error : new SourceError("transient");
        const retry = failure.code === "transient" && job.attempts < job.maxAttempts;
        job.errorCode = failure.code;
        job.permanent = !retry;
        job.state = retry ? "queued" : "failed";
      }
      await save(store, job);
    }
  }
  return jobs;
}
