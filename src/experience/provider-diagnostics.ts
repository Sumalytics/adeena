import { createHash } from "node:crypto";

/** Only fixed, bounded values from a provider response may enter durable diagnostics. */
export type ProviderFailureCategory =
  | "completed" | "transport-failure" | "provider-auth-failure" | "provider-rate-limited"
  | "provider-schema-rejected" | "provider-request-invalid" | "provider-payload-too-large"
  | "provider-unprocessable" | "provider-server-failure" | "provider-response-invalid"
  | "provider-usage-unknown";
export type BillingCertainty = "confirmed-usage" | "confirmed-nonbillable" | "unknown-external-charge";
export type UsageReporting = "reported" | "missing" | "invalid";

export type ProviderAttemptDiagnostic = {
  jobId: string | null;
  stage: "plan" | "review" | "visualPlan" | "visualReview" | "edit";
  provider: "groq" | "openai" | "configured-provider";
  model: string;
  timestamp: string;
  dispatched: true;
  responseReceived: boolean;
  httpStatus: number | null;
  providerErrorCode: string | null;
  category: ProviderFailureCategory;
  requestId: string | null;
  durationMs: number;
  retryAfterSeconds: number | null;
  remainingRequests: number | null;
  remainingTokens: number | null;
  limitRequests: number | null;
  limitTokens: number | null;
  usageReporting: UsageReporting;
  billingCertainty: BillingCertainty;
};

const ERROR_CODES = new Set([
  "invalid_api_key", "invalid_authentication", "insufficient_quota", "credit_balance_exhausted",
  "billing_hard_limit_reached", "invalid_json_schema", "unsupported_schema",
  "unsupported_response_format", "rate_limit_exceeded", "context_length_exceeded",
]);
const SCHEMA_CODES = new Set(["invalid_json_schema", "unsupported_schema", "unsupported_response_format"]);
const NONBILLABLE_CODES = new Set(["invalid_api_key", "invalid_authentication", "insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached"]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_MODEL = /^[a-z0-9@.:/-]{1,80}$/;
const SAFE_JOB_ID = /^[a-f0-9-]{36}$/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedInteger(value: string | null, maximum: number): number | null {
  if (!value || !/^[0-9]+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= maximum ? number : null;
}

export function safeProviderErrorCode(parsed: unknown): string | null {
  const code = record(record(parsed).error).code;
  return typeof code === "string" && ERROR_CODES.has(code) ? code : null;
}

export function safeProviderRequestId(value: unknown): string | null {
  if (typeof value !== "string" || !SAFE_ID.test(value)) return null;
  // Keep a correlatable digest, never provider-controlled text that might echo a source fragment.
  return `sha256_${createHash("sha256").update(value).digest("hex")}`;
}

export function providerFailureCategory(status: number | null, code: string | null): ProviderFailureCategory {
  if (status === null) return "transport-failure";
  if (status === 401 || status === 403) return "provider-auth-failure";
  if (status === 429) return "provider-rate-limited";
  if (status === 400) return code !== null && SCHEMA_CODES.has(code) ? "provider-schema-rejected" : "provider-request-invalid";
  if (status === 413) return "provider-payload-too-large";
  if (status === 422) return "provider-unprocessable";
  if (status >= 500 && status <= 599) return "provider-server-failure";
  return "provider-response-invalid";
}

export function providerAttempt(input: {
  jobId?: string;
  stage: ProviderAttemptDiagnostic["stage"];
  provider: ProviderAttemptDiagnostic["provider"];
  model: string;
  startedAt: number;
  response?: Response;
  parsed?: unknown;
  usageReporting: UsageReporting;
  successfulEnvelope?: boolean;
}): ProviderAttemptDiagnostic {
  const response = input.response;
  const errorCode = safeProviderErrorCode(input.parsed);
  const headerId = response?.headers.get("x-request-id") ?? response?.headers.get("request-id") ?? null;
  const bodyId = record(input.parsed).id;
  const possibleId = headerId ?? bodyId;
  const requestId = safeProviderRequestId(possibleId);
  const status = response?.status ?? null;
  const category = !response ? "transport-failure"
    : !response.ok ? providerFailureCategory(status, errorCode)
      : input.usageReporting !== "reported" ? "provider-usage-unknown"
        : input.successfulEnvelope === false ? "provider-response-invalid" : "completed";
  const billingCertainty: BillingCertainty = input.usageReporting === "reported" ? "confirmed-usage"
    : response && (status === 401 || status === 403 || status === 429) && errorCode !== null && NONBILLABLE_CODES.has(errorCode)
      ? "confirmed-nonbillable" : "unknown-external-charge";
  return {
    jobId: input.jobId && SAFE_JOB_ID.test(input.jobId) ? input.jobId : null,
    stage: input.stage,
    provider: input.provider,
    model: SAFE_MODEL.test(input.model) ? input.model : "unknown",
    timestamp: new Date(input.startedAt).toISOString(),
    dispatched: true,
    responseReceived: Boolean(response),
    httpStatus: status,
    providerErrorCode: errorCode,
    category,
    requestId,
    durationMs: Math.max(0, Date.now() - input.startedAt),
    retryAfterSeconds: response ? boundedInteger(response.headers.get("retry-after"), 86_400) : null,
    remainingRequests: response ? boundedInteger(response.headers.get("x-ratelimit-remaining-requests"), 1_000_000_000) : null,
    remainingTokens: response ? boundedInteger(response.headers.get("x-ratelimit-remaining-tokens"), 1_000_000_000) : null,
    limitRequests: response ? boundedInteger(response.headers.get("x-ratelimit-limit-requests"), 1_000_000_000) : null,
    limitTokens: response ? boundedInteger(response.headers.get("x-ratelimit-limit-tokens"), 1_000_000_000) : null,
    usageReporting: input.usageReporting,
    billingCertainty,
  };
}
