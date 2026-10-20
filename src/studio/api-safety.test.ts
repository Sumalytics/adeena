import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as preview } from "@/app/api/studio/preview/route";
import { POST as score } from "@/app/api/studio/score/route";
import { POST as share } from "@/app/api/studio/share/route";
import { MAX_REQUEST_BYTES } from "@/studio/demo";
import { clearJobsForTests } from "@/studio/jobs";

const source = "Water moves from clouds to rivers and back again.";

function call(route: (request: Request) => Response | Promise<Response>, path: string, body: string, headers?: HeadersInit) {
  return route(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

describe("studio API safety", () => {
  beforeEach(() => {
    clearJobsForTests();
  });

  it("rejects malformed, unexpected, and oversized preview bodies", async () => {
    const malformed = await call(preview, "/api/studio/preview", "{");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "invalid-json", demo: { mode: "synthetic-demo", authorization: "not-production" } });

    const unexpected = await call(preview, "/api/studio/preview", JSON.stringify({ source: { label: source, secret: true } }));
    expect(unexpected.status).toBe(400);

    const executable = await call(
      preview,
      "/api/studio/preview",
      JSON.stringify({
        idempotencyKey: randomUUID(),
        source: { label: "<script>alert(1)</script>" },
        audience: { label: "A class", ageBand: "8-10" },
      }),
    );
    expect(executable.status).toBe(400);

    const oversized = await call(preview, "/api/studio/preview", "x".repeat(MAX_REQUEST_BYTES + 1));
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("x-adeena-runtime")).toBe("synthetic-demo");
  });

  it("hides answer keys and refuses another caller's unknown job id", async () => {
    const created = await call(
      preview,
      "/api/studio/preview",
      JSON.stringify({
        idempotencyKey: randomUUID(),
        source: { label: source },
        audience: { label: "A general science class", ageBand: "8-10" },
      }),
    );
    expect(created.status).toBe(201);
    const previewBody = await created.json();
    expect(JSON.stringify(previewBody)).not.toContain('"correct"');
    expect(previewBody.demo.persistence).toBe("process-local");

    const missing = randomUUID();
    const scored = await call(score, "/api/studio/score", JSON.stringify({ jobId: missing, sceneId: "scene-1", optionId: "opt-source" }));
    expect(scored.status).toBe(404);
    const scoredBody = await scored.json();
    expect(scoredBody.error).toBe("unknown-job");
    expect(JSON.stringify(scoredBody)).not.toContain(source);

    const shared = await call(share, "/api/studio/share", JSON.stringify({ jobId: missing, allowed: true, actor: { kind: "member" } }));
    expect(shared.status).toBe(400);
  });

  it("keeps sharing closed for a real demo job", async () => {
    const created = await call(
      preview,
      "/api/studio/preview",
      JSON.stringify({
        idempotencyKey: randomUUID(),
        source: { label: source },
        audience: { label: "A general science class", ageBand: "11-13" },
      }),
    );
    const { jobId } = await created.json();
    const shared = await call(share, "/api/studio/share", JSON.stringify({ jobId }));
    expect(shared.status).toBe(403);
    const body = await shared.json();
    expect(body.error).toBe("publication-blocked");
    expect(body.issues).toContain("This guest identity cannot publish.");
    expect(body.issues).toContain("Source rights are not cleared.");
    expect(body.demo.authorization).toBe("not-production");

    clearJobsForTests();
    const forgotten = await call(share, "/api/studio/share", JSON.stringify({ jobId }));
    expect(forgotten.status).toBe(404);
  });
});
