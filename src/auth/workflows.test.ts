import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { POST as GENERATE } from "@/app/api/creator/workflows/[workflowId]/generate/route";
import { PATCH } from "@/app/api/creator/workflows/[workflowId]/route";
import { POST } from "@/app/api/creator/workflows/route";
import { requestOriginAllowed } from "./password-post";
import { sessionFromAuthUser } from "./subject";
import { creatorWorkflowCreateResponse, creatorWorkflowGenerateResponse, creatorWorkflowReadResponse, creatorWorkflowUpdateResponse } from "./workflows";

const workflowId = "11111111-1111-4111-8111-111111111111";

function mutation(url: string, origin: string, site = "cross-site") {
  return new Request(url, {
    method: "POST",
    headers: { origin, "sec-fetch-site": site, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: workflowId }),
  });
}

describe("creator workflow requests", () => {
  it("rejects an anonymous workflow before using the database", async () => {
    const sql = {} as Sql;
    expect(await creatorWorkflowCreateResponse({ session: null, sql, body: { idempotencyKey: workflowId } })).toEqual({
      status: 401,
      body: { error: "unauthenticated" },
    });
    expect(await creatorWorkflowReadResponse({ session: null, sql, workflowId })).toEqual({
      status: 401,
      body: { error: "unauthenticated" },
    });
    expect(await creatorWorkflowUpdateResponse({
      session: null,
      sql,
      workflowId,
      body: { expectedVersion: 1, resolveRecommendedTopic: true },
    })).toEqual({ status: 401, body: { error: "unauthenticated" } });
    expect(await creatorWorkflowGenerateResponse({
      session: null,
      sql,
      workflowId,
      body: { expectedVersion: 1, authorizeGeneration: true },
    })).toEqual({ status: 401, body: { error: "unauthenticated" } });
  });

  it("rejects an invalid workflow request before using the database", async () => {
    const session = sessionFromAuthUser({ id: "22222222-2222-4222-8222-222222222222" });
    let used = false;
    const sql = { begin() { used = true; throw new Error("database used"); } } as unknown as Sql;
    expect(await creatorWorkflowCreateResponse({ session, sql, body: {} })).toEqual({
      status: 400,
      body: { error: "invalid-workflow" },
    });
    expect(await creatorWorkflowReadResponse({ session, sql, workflowId: "not-a-workflow" })).toEqual({
      status: 400,
      body: { error: "invalid-workflow" },
    });
    expect(await creatorWorkflowUpdateResponse({
      session,
      sql,
      workflowId,
      body: { expectedVersion: 1, documentVersionId: workflowId, topicCandidateId: workflowId },
    })).toEqual({ status: 400, body: { error: "invalid-workflow" } });
    expect(await creatorWorkflowGenerateResponse({ session, sql, workflowId, body: {} })).toEqual({
      status: 400,
      body: { error: "invalid-workflow" },
    });
    expect(await creatorWorkflowGenerateResponse({
      session,
      sql,
      workflowId,
      body: { expectedVersion: 1, authorizeGeneration: true },
      env: {},
    })).toEqual({ status: 503, body: { error: "generation-unavailable" } });
    expect(used).toBe(false);
  });

  it("rejects a cross-origin workflow mutation before authentication", async () => {
    const created = await POST(mutation("http://adeena.test/api/creator/workflows", "https://evil.test"));
    expect(created.status).toBe(403);
    expect(await created.json()).toEqual({ error: "rejected" });
    const saved = await PATCH(mutation("http://adeena.test/api/creator/workflows/" + workflowId, "https://evil.test"), {
      params: Promise.resolve({ workflowId }),
    });
    expect(saved.status).toBe(403);
    expect(await saved.json()).toEqual({ error: "rejected" });
    const generated = await GENERATE(mutation("http://adeena.test/api/creator/workflows/" + workflowId + "/generate", "https://evil.test"), {
      params: Promise.resolve({ workflowId }),
    });
    expect(generated.status).toBe(403);
    expect(await generated.json()).toEqual({ error: "rejected" });
    expect(requestOriginAllowed(mutation("http://adeena.test/api/creator/workflows", "http://adeena.test", "same-origin"))).toBe(true);
  });
});
