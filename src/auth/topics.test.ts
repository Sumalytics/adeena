import { readFileSync } from "node:fs";
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

  it("does not accept a database identity from request headers", () => {
    const files = [
      "src/app/api/creator/topics/route.ts",
      "src/app/api/creator/topics/correct/route.ts",
      "src/app/api/creator/sources/route.ts",
      "src/app/api/creator/sources/continue/route.ts",
      "src/app/api/creator/experiences/route.ts",
      "src/app/api/creator/experiences/continue/route.ts",
      "src/app/api/creator/experiences/edits/route.ts",
      "src/app/api/creator/experiences/edits/accept/route.ts",
      "src/app/api/creator/experiences/edits/reject/route.ts",
      "src/app/api/creator/experiences/edits/continue/route.ts",
      "src/app/api/creator/workflows/route.ts",
      "src/app/api/creator/workflows/[workflowId]/route.ts",
      "src/app/api/creator/workflows/[workflowId]/generate/route.ts",
      "src/auth/topics.ts",
      "src/auth/workflows.ts",
      "src/auth/uploads.ts",
      "src/auth/experiences.ts",
      "src/auth/edits.ts",
      "src/proxy.ts",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/adeena\.user_id|x-user-id|x-workspace-id/i);
    }
    const identityRoutes = files.filter((file) => file !== "src/auth/uploads.ts");
    for (const file of identityRoutes) {
      expect(readFileSync(file, "utf8").includes("headers.get")).toBe(false);
    }
  });
});
