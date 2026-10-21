import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { creatorTopicCorrectionResponse, creatorTopicResponse } from "./topics";

describe("creator topic requests", () => {
  it("rejects an anonymous recommendation before using the database", async () => {
    const result = await creatorTopicResponse({
      session: null,
      sql: {} as Sql,
      method: "POST",
      search: new URLSearchParams(),
      body: { documentVersionId: "22222222-2222-4222-8222-222222222222" },
    });
    expect(result).toEqual({ status: 401, body: { error: "unauthenticated" } });
  });

  it("rejects an anonymous heading correction before using the database", async () => {
    const result = await creatorTopicCorrectionResponse({
      session: null,
      sql: {} as Sql,
      body: { documentVersionId: "22222222-2222-4222-8222-222222222222", nodeId: "33333333-3333-4333-8333-333333333333", correctedTitle: "Rivers" },
    });
    expect(result).toEqual({ status: 401, body: { error: "unauthenticated" } });
  });
});
