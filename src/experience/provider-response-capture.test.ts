import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureProviderResponse } from "./provider-response-capture";
import { GROQ_COMMERCIAL_PRICE, GROQ_GPT_OSS_120B_MODEL, GROQ_RESPONSES_URL, requestPaidEdit } from "./provider";

describe("private local provider response capture", () => {
  const enabled = { ADEENA_CAPTURE_PROVIDER_RESPONSES: "local-mvp", ADEENA_RUNTIME: "local-development", NODE_ENV: "test" };

  it("is opt-in, local-only, and bounded", () => {
    expect(captureProviderResponse({}, "plan", "{}" )).toBeNull();
    expect(captureProviderResponse({ ...enabled, ADEENA_RUNTIME: "production" }, "plan", "{}" )).toBeNull();
    expect(captureProviderResponse({ ...enabled, NODE_ENV: "production" }, "plan", "{}" )).toBeNull();
    expect(captureProviderResponse(enabled, "plan", "x".repeat(128_001))).toBeNull();
  });

  it("preserves the exact response envelope privately for replay", () => {
    const raw = '{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{}"}]}]}';
    const name = captureProviderResponse(enabled, "plan", raw);
    expect(name).toMatch(/^[0-9a-f-]{36}\.json$/);
    if (!name) return;
    const file = path.join(process.cwd(), ".local", "provider-response-captures", name);
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { stage: string; body: string };
      expect(saved.stage).toBe("plan");
      expect(saved.body).toBe(raw);
    } finally {
      unlinkSync(file);
    }
  });

  it("captures the original mocked provider response before transport rejection", async () => {
    const directory = path.join(process.cwd(), ".local", "provider-response-captures");
    const before = new Set(readdirSync(directory));
    const raw = '{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{}"}]}],"usage":{"input_tokens":10,"output_tokens":10}}';
    let calls = 0;
    const result = await requestPaidEdit({
      env: { ...enabled, ADEENA_EXPERIENCE_PROVIDER: "configured-provider", ADEENA_AI_EXECUTION_MODE: "paid-development",
        ADEENA_AI_API_KEY: "mock-key", ADEENA_AI_MODEL: GROQ_GPT_OSS_120B_MODEL, ADEENA_AI_API_URL: GROQ_RESPONSES_URL,
        ADEENA_AI_PRICE_VERSION: GROQ_COMMERCIAL_PRICE, ADEENA_AI_SPEND_CAP_USD: "1", ADEENA_AI_MAX_EDIT_COST_USD: "0.02",
        ADEENA_AI_SPEND_AUTHORIZED: "development" },
      systemText: "safe", userText: "safe", structuredGeneration: { kind: "plan", schema: { type: "object", additionalProperties: false,
        required: ["label"], properties: { label: { type: "string" } } } },
      fetchImpl: (async () => { calls++; return new Response(raw, { status: 200 }); }) as typeof fetch,
    });
    const added = readdirSync(directory).filter((file) => !before.has(file));
    try {
      expect(result).toMatchObject({ ok: false, diagnostic: "schema.normalization: transport.missing-field at #/label", callCount: 1, retryCount: 0 });
      expect(calls).toBe(1);
      expect(added).toHaveLength(1);
      const saved = JSON.parse(readFileSync(path.join(directory, added[0]), "utf8")) as { body: string };
      expect(saved.body).toBe(raw);
    } finally {
      for (const file of added) unlinkSync(path.join(directory, file));
    }
  });
});
