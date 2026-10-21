import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { creatorEditAcceptResponse, creatorEditContinueResponse, creatorEditRejectResponse, creatorEditResponse } from "./edits";
import { sessionFromAuthUser } from "./subject";

const sql = new Proxy({}, { get() { throw new Error("database used"); } }) as Sql;

function body(instruction = "Simplify the dialogue.") {
  return {
    baseVersionId: randomUUID(),
    expectedBaseVersionId: randomUUID(),
    instruction,
    idempotencyKey: randomUUID(),
    editPolicyVersion: "1" as const,
    authorizeEdit: true as const,
  };
}

describe("creator edit requests", () => {
  it("rejects an anonymous edit before using the database", async () => {
    const result = await creatorEditResponse({ session: null, sql, body: body() });
    expect(result).toEqual({ status: 401, body: { error: "unauthenticated" } });
    const accepted = await creatorEditAcceptResponse({ session: null, sql, body: { editJobId: randomUUID(), expectedBaseVersionId: randomUUID() } });
    expect(accepted.status).toBe(401);
    const rejected = await creatorEditRejectResponse({ session: null, sql, body: { editJobId: randomUUID() } });
    expect(rejected.status).toBe(401);
    const continued = await creatorEditContinueResponse({ session: null, sql, body: { editJobId: randomUUID() } });
    expect(continued.status).toBe(401);
  });

  it("rejects a client workspace, an empty instruction, and a closed provider before the database", async () => {
    const session = sessionFromAuthUser({ id: "58ac8d72-2067-42a8-808b-207b3251508f" });
    const workspace = await creatorEditResponse({
      session,
      sql,
      body: { ...body(), workspaceId: randomUUID(), userId: randomUUID() },
    });
    expect(workspace).toEqual({ status: 400, body: { error: "invalid-edit" } });
    const empty = await creatorEditResponse({ session, sql, body: { ...body("   ") } });
    expect(empty).toEqual({ status: 400, body: { error: "invalid-edit" } });
    const oversized = await creatorEditResponse({ session, sql, body: { ...body("a".repeat(501)) } });
    expect(oversized).toEqual({ status: 400, body: { error: "invalid-edit" } });
    const closed = await creatorEditResponse({ session, sql, body: body() });
    expect(closed.status === 503 || closed.status === 403).toBe(true);
    if (closed.status !== 401) expect(closed.body).toEqual({ error: expect.stringMatching(/generation-unavailable|budget-unavailable/) });
  });

  it("refuses a configured edit before the database when no verified price exists", async () => {
    const session = sessionFromAuthUser({ id: "58ac8d72-2067-42a8-808b-207b3251508f" });
    const result = await creatorEditResponse({
      session,
      sql,
      body: body("Recast the opening lines in plain words a new reader can follow."),
      env: {
        ADEENA_EXPERIENCE_PROVIDER: "configured-provider",
        ADEENA_AI_API_KEY: "test-key",
        ADEENA_AI_MODEL: "test-model",
        ADEENA_AI_PRICE_VERSION: "vendor-2026",
        ADEENA_AI_SPEND_CAP_USD: "1",
        ADEENA_AI_MAX_EDIT_COST_USD: "0.05",
        ADEENA_AI_SPEND_AUTHORIZED: "development",
        ADEENA_AI_API_URL: "https://models.example.test/v1/chat",
      },
    });
    expect(result).toEqual({ status: 403, body: { error: "budget-unavailable" } });
  });

  it("refuses free-development before the database when the Free plan is not confirmed", async () => {
    const session = sessionFromAuthUser({ id: "58ac8d72-2067-42a8-808b-207b3251508f" });
    const result = await creatorEditResponse({
      session,
      sql,
      body: body("Recast the opening lines in plain words a new reader can follow."),
      env: {
        ADEENA_EXPERIENCE_PROVIDER: "configured-provider",
        ADEENA_AI_EXECUTION_MODE: "free-development",
        ADEENA_RUNTIME: "local-development",
        ADEENA_GROQ_API_KEY: "gsk-test",
        ADEENA_AI_MODEL: "openai/gpt-oss-120b",
        ADEENA_AI_API_URL: "https://api.groq.com/openai/v1/responses",
        NODE_ENV: "test",
      },
    });
    expect(result).toEqual({ status: 403, body: { error: "budget-unavailable" } });
  });
});
