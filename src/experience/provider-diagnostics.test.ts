import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestPaidEdit, GROQ_RESPONSES_URL } from "./provider";

const jobId = "11111111-1111-4111-8111-111111111111";
const env = {
  ADEENA_EXPERIENCE_PROVIDER: "configured-provider",
  ADEENA_AI_EXECUTION_MODE: "paid-development",
  ADEENA_AI_API_KEY: "secret-api-key",
  ADEENA_AI_MODEL: "test-model",
  ADEENA_AI_PRICE_VERSION: "test-diagnostic-1",
  ADEENA_AI_SPEND_CAP_USD: "1",
  ADEENA_AI_MAX_EDIT_COST_USD: "0.05",
  ADEENA_AI_SPEND_AUTHORIZED: "development",
  ADEENA_AI_API_URL: GROQ_RESPONSES_URL,
};
const schedules = { "test-diagnostic-1": { inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000 } };
const sourceFragment = "private-bean-source-fragment";

async function mocked(response: Response | (() => never), confirmRetry?: () => Promise<boolean>) {
  let calls = 0;
  const result = await requestPaidEdit({ env, schedules, jobId, stage: "plan", systemText: "System instruction", userText: sourceFragment,
    confirmRetry,
    fetchImpl: (async () => { calls += 1; return typeof response === "function" ? response() : response; }) as typeof fetch,
  });
  expect(calls).toBe(1);
  expect(result.callCount).toBe(1);
  expect(result.retryCount).toBe(0);
  expect(result.attempts).toHaveLength(1);
  const diagnostic = result.attempts![0];
  expect(diagnostic).toMatchObject({ jobId, stage: "plan", provider: "groq", model: "test-model", dispatched: true });
  expect(JSON.stringify(diagnostic)).not.toContain(sourceFragment);
  expect(JSON.stringify(diagnostic)).not.toContain(env.ADEENA_AI_API_KEY);
  return { result, diagnostic };
}

describe("safe provider attempt diagnostics", () => {
  let directory: string | null = null;
  afterEach(() => {
    delete process.env.ADEENA_AI_FAULT_LOG;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it.each([
    [400, "invalid_request_error", "provider-request-invalid", "unknown-external-charge"],
    [400, "invalid_json_schema", "provider-schema-rejected", "unknown-external-charge"],
    [401, "invalid_api_key", "provider-auth-failure", "confirmed-nonbillable"],
    [403, "invalid_authentication", "provider-auth-failure", "confirmed-nonbillable"],
    [413, "context_length_exceeded", "provider-payload-too-large", "unknown-external-charge"],
    [422, "invalid_request_error", "provider-unprocessable", "unknown-external-charge"],
    [429, "rate_limit_exceeded", "provider-rate-limited", "unknown-external-charge"],
    [503, "server_error", "provider-server-failure", "unknown-external-charge"],
  ] as const)("classifies HTTP %i with %s", async (status, code, category, certainty) => {
    const { result, diagnostic } = await mocked(Response.json({ error: { code, message: `echo ${sourceFragment} secret-api-key` } }, { status }), async () => true);
    expect(diagnostic).toMatchObject({ responseReceived: true, httpStatus: status, category, billingCertainty: certainty, usageReporting: "missing" });
    expect(diagnostic.providerErrorCode).toBe(code === "invalid_request_error" || code === "server_error" ? null : code);
    expect(result.usageKind).toBe(certainty === "confirmed-nonbillable" ? "none" : "estimate");
    expect(result.releaseReservation).toBe(certainty === "confirmed-nonbillable");
  });

  it("preserves 429 numeric limits and blocks another call despite a retry callback", async () => {
    let authorizedRetry = false;
    const { diagnostic } = await mocked(Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429, headers: {
      "retry-after": "9", "x-ratelimit-remaining-requests": "0", "x-ratelimit-remaining-tokens": "125",
      "x-ratelimit-limit-requests": "1000", "x-ratelimit-limit-tokens": "250000",
    } }), async () => { authorizedRetry = true; return true; });
    expect(authorizedRetry).toBe(false);
    expect(diagnostic).toMatchObject({ retryAfterSeconds: 9, remainingRequests: 0, remainingTokens: 125, limitRequests: 1000, limitTokens: 250000 });
  });

  it("distinguishes transport failure and a successful response without usage", async () => {
    const transport = await mocked(() => { throw new Error(sourceFragment); });
    expect(transport.diagnostic).toMatchObject({ responseReceived: false, httpStatus: null, category: "transport-failure", billingCertainty: "unknown-external-charge" });
    const missing = await mocked(Response.json({ id: sourceFragment, status: "completed", output: [] }));
    expect(missing.diagnostic).toMatchObject({ responseReceived: true, httpStatus: 200, category: "provider-usage-unknown", billingCertainty: "unknown-external-charge" });
    expect(missing.result.responseId).toMatch(/^sha256_[a-f0-9]{64}$/);
  });

  it("distinguishes an invalid successful envelope from a metered successful call", async () => {
    const invalid = await mocked(Response.json({ status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5 } }));
    expect(invalid.diagnostic).toMatchObject({ category: "provider-response-invalid", billingCertainty: "confirmed-usage" });
    const good = await mocked(Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }], usage: { input_tokens: 10, output_tokens: 5 } }));
    expect(good.diagnostic).toMatchObject({ category: "completed", usageReporting: "reported", billingCertainty: "confirmed-usage" });
    expect(good.result).toMatchObject({ ok: true, actualCostMicros: 15 });
  });

  it("writes only bounded structured fields when provider errors echo source and secrets", async () => {
    directory = mkdtempSync(join(tmpdir(), "adeena-provider-diagnostic-"));
    const file = join(directory, "fault.log");
    process.env.ADEENA_AI_FAULT_LOG = file;
    await mocked(Response.json({ id: sourceFragment, error: { code: "invalid_json_schema", message: `secret-api-key ${sourceFragment}` } }, {
      status: 400, headers: { "x-request-id": sourceFragment },
    }));
    const logged = readFileSync(file, "utf8");
    expect(logged).not.toContain(sourceFragment);
    expect(logged).not.toContain("secret-api-key");
    expect(JSON.parse(logged)).toMatchObject({ httpStatus: 400, category: "provider-schema-rejected", providerErrorCode: "invalid_json_schema" });
  });
});
