import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as preview } from "@/app/api/studio/preview/route";
import { POST as score } from "@/app/api/studio/score/route";
import { POST as share } from "@/app/api/studio/share/route";
import { proxy } from "@/proxy";
import { previewJob } from "@/studio/http";
import { clearJobsForTests } from "@/studio/jobs";
import { studioFixturesAllowed } from "./availability";

const previousRuntime = process.env.ADEENA_RUNTIME;
const previousNodeEnv = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined) {
  const env = process.env as { NODE_ENV?: string };
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}

function restoreEnv() {
  if (previousRuntime === undefined) delete process.env.ADEENA_RUNTIME;
  else process.env.ADEENA_RUNTIME = previousRuntime;
  setNodeEnv(previousNodeEnv);
}

const previewBody = () =>
  JSON.stringify({
    idempotencyKey: randomUUID(),
    source: { label: "Water moves from clouds to rivers and back again." },
    audience: { label: "Primary learners", ageBand: "8-10" },
  });

describe("synthetic studio access", () => {
  afterEach(() => {
    restoreEnv();
    clearJobsForTests();
  });

  it("stays closed unless the server runtime explicitly allows development fixtures", () => {
    delete process.env.ADEENA_RUNTIME;
    setNodeEnv("development");
    expect(studioFixturesAllowed()).toBe(false);
    setNodeEnv("test");
    expect(studioFixturesAllowed()).toBe(false);
    process.env.ADEENA_RUNTIME = "local-development";
    setNodeEnv("development");
    expect(studioFixturesAllowed()).toBe(true);
    process.env.ADEENA_RUNTIME = "nonproduction-test";
    expect(studioFixturesAllowed()).toBe(true);
  });

  it("stays closed in production even when a development runtime is present", () => {
    process.env.ADEENA_RUNTIME = "local-development";
    setNodeEnv("production");
    expect(studioFixturesAllowed()).toBe(false);
    setNodeEnv("development");
    process.env.ADEENA_RUNTIME = "production";
    expect(studioFixturesAllowed()).toBe(false);
  });

  it("denies studio routes before a request header or query can enable them", async () => {
    delete process.env.ADEENA_RUNTIME;
    setNodeEnv("development");
    const headerRequest = new NextRequest("http://localhost/studio?fixtures=authorized", {
      headers: { "x-adeena-runtime": "local-development", cookie: "ADEENA_RUNTIME=local-development" },
    });
    const page = await proxy(headerRequest);
    expect(page.status).toBe(404);
    const api = await proxy(
      new NextRequest("http://localhost/api/studio/preview", {
        method: "POST",
        headers: { "x-adeena-studio": "authorized", "content-type": "application/json" },
        body: previewBody(),
      }),
    );
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "not-found" });
  });

  it("denies every studio API before creating a synthetic job", async () => {
    delete process.env.ADEENA_RUNTIME;
    setNodeEnv("production");
    const body = previewBody();
    const deniedPreview = await preview(new Request("http://localhost/api/studio/preview", { method: "POST", body }));
    expect(deniedPreview.status).toBe(404);
    expect(deniedPreview.headers.get("x-adeena-runtime")).toBeNull();
    expect(await deniedPreview.json()).toEqual({ error: "not-found" });
    const deniedScore = await score(new Request("http://localhost/api/studio/score", { method: "POST", body: "{}" }));
    const deniedShare = await share(new Request("http://localhost/api/studio/share", { method: "POST", body: "{}" }));
    expect(deniedScore.status).toBe(404);
    expect(deniedShare.status).toBe(404);
    expect(previewJob(JSON.parse(body)).status).toBe(201);
  });

  it("allows the synthetic preview only in an authorized development runtime", async () => {
    process.env.ADEENA_RUNTIME = "local-development";
    setNodeEnv("development");
    const response = await preview(
      new Request("http://localhost/api/studio/preview", { method: "POST", body: previewBody() }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("x-adeena-runtime")).toBe("synthetic-demo");
  });
});
