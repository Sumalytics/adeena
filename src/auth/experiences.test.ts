import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { creatorExperienceContinueResponse, creatorExperienceResponse } from "./experiences";
import { sessionFromAuthUser } from "./subject";

const sql = new Proxy({}, { get() { throw new Error("database used"); } }) as Sql;

describe("creator experience requests", () => {
  it("rejects an anonymous generation before using the database", async () => {
    const result = await creatorExperienceResponse({ session: null, sql, body: {} });
    expect(result).toEqual({ status: 401, body: { error: "unauthenticated" } });
  });

  it("rejects a client workspace and stays closed when no model budget is configured", async () => {
    const session = sessionFromAuthUser({ id: "58ac8d72-2067-42a8-808b-207b3251508f" });
    const rejected = await creatorExperienceResponse({
      session,
      sql,
      body: {
        documentVersionId: randomUUID(),
        topicCandidateId: randomUUID(),
        audienceLabel: "Primary learners",
        ageBand: "8-10",
        idempotencyKey: randomUUID(),
        authorizeGeneration: true,
        compilerVersion: "1",
        workspaceId: randomUUID(),
        userId: randomUUID(),
      },
    });
    expect(rejected).toEqual({ status: 400, body: { error: "invalid-generation" } });
    const closed = await creatorExperienceResponse({
      session,
      sql,
      body: {
        documentVersionId: randomUUID(),
        topicCandidateId: randomUUID(),
        audienceLabel: "Primary learners",
        ageBand: "8-10",
        idempotencyKey: randomUUID(),
        authorizeGeneration: true,
        compilerVersion: "1",
      },
    });
    expect(closed.status === 503 || closed.status === 403).toBe(true);
    if (closed.status !== 401) expect(closed.body).toEqual({ error: expect.stringMatching(/generation-unavailable|budget-unavailable/) });
    const continued = await creatorExperienceContinueResponse({ session: null, sql, body: { jobId: randomUUID() } });
    expect(continued).toEqual({ status: 401, body: { error: "unauthenticated" } });
  });
});
