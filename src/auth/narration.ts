import type { Sql } from "postgres";
import { creatorAudioObjectStore } from "./storage";
import type { CreatorSession } from "./subject";
import { TtsError } from "@/audio/tts/errors";
import { enqueueNarrationGeneration, runNarrationGeneration } from "@/db/narration-repository";

export async function creatorNarrationResponse(input: { session: CreatorSession | null; sql: Sql; body: unknown }) {
  if (!input.session) return { status: 401 as const, body: { error: "unauthenticated" } };
  const body = input.body;
  if (!body || typeof body !== "object" || !("workspaceId" in body) || typeof body.workspaceId !== "string" || !("request" in body)) return { status: 400 as const, body: { error: "invalid-input" } };
  try {
    const queued = await enqueueNarrationGeneration({ sql: input.sql, identity: input.session.identity, workspaceId: body.workspaceId, request: body.request as never });
    const result = await runNarrationGeneration({ sql: input.sql, identity: input.session.identity, workspaceId: body.workspaceId, jobId: queued.jobId,
      leaseOwner: `dev-${queued.jobId.slice(0, 8)}`, store: creatorAudioObjectStore() });
    return { status: result.kind === "pending" ? 202 as const : 200 as const, body: { jobId: queued.jobId, result } };
  } catch (error) {
    const code = error instanceof TtsError ? error.code : "invalid-input";
    const status = code === "authorization-required" || code === "budget-exhausted" || code === "provider-unavailable" ? 403 as const : code === "provider-timeout" || code === "provider-network" ? 502 as const : 400 as const;
    return { status, body: { error: code } };
  }
}
