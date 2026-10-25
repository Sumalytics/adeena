import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { SourceErrorCode } from "@/source/errors";
import type { DialogueTarget } from "./edit";
import { groqTransportSchema, mapGroqGraphTransport, mapGroqTransport, readGroqAssistantPayload } from "./groq-edit";
import { groqStrictTransportSchema, normalizeGroqStrictOutput } from "./strict-transport";

export const FIXTURE_PROVIDER = "deterministic-fixture" as const;
export const CONFIGURED_PROVIDER = "configured-provider" as const;
export const FIXTURE_PRICE_VERSION = "fixture-0" as const;
export const PROMPT_VERSION = "fixture-plan@1" as const;
export const LIVE_PLAN_PROMPT_VERSION = "source-plan@1" as const;
export const GENERATION_LIMITS = {
  plan: { input: 8000, output: 3500 },
  review: { input: 16000, output: 1000 },
  visualPlan: { input: 16000, output: 8000 },
  visualReview: { input: 20000, output: 1500 },
} as const;
export type StructuredGeneration = { kind: keyof typeof GENERATION_LIMITS; schema: object };
export const COMPILER_VERSION = "1" as const;
const MODEL_NAME = /^[a-z0-9@.:/-]{1,80}$/;
const PRICE_NAME = /^[a-z0-9@.-]{1,40}$/;
const RESPONSE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_INPUT_TOKENS = 4_000;
const MAX_OUTPUT_TOKENS = 800;
const FREE_SESSION_CAP = 5;
const FREE_DAY_CAP = 10;
const FREE_RETRY_SECONDS = 5;
export const OPENAI_GPT_54_MINI_PRICE = "openai-gpt-5.4-mini-standard-2026-10";
const OPENAI_GPT_54_MINI_MODEL = "gpt-5.4-mini";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const GROQ_GPT_OSS_120B_MODEL = "openai/gpt-oss-120b";
export const GROQ_RESPONSES_URL = "https://api.groq.com/openai/v1/responses";
export const GROQ_COMMERCIAL_PRICE = "groq-gpt-oss-120b-ondemand-2026-10";
const GROQ_CONTEXT_TOKENS = 131_072;

/**
 * Versioned prices in USD micros per 1,000,000 tokens.
 * Retrieved 2026-10-21 from the OpenAI model page and the standard pricing page:
 * https://developers.openai.com/api/docs/models/gpt-5.4-mini
 * https://developers.openai.com/api/docs/pricing
 * gpt-5.4-mini standard rates below 272K context: input $0.75, cached input $0.075, output $4.50.
 * Output tokens include reasoning tokens. This model page does not publish a cache-write rate.
 * Batch and regional-processing prices are not included.
 * Groq on-demand prices below are a commercial comparison only. They do not authorize a call
 * and they are not a Free-plan charge. Retrieved 2026-10-21 from
 * https://console.groq.com/docs/model/openai/gpt-oss-120b
 * openai/gpt-oss-120b: input $0.15, cached input $0.075, output $0.60 per million tokens.
 * Groq's published rate-limit table is the Developer plan, not the Free plan.
 * The Responses guide checked on 2026-10-21 does not publish a retention period.
 * Groq processes the development fixture to answer the request. The Responses API is in beta.
 * Requests omit tools, web search, code execution, and streaming. The key stays on the server.
 */
export const PRICE_SCHEDULES = {
  "fixture-0": { currency: "USD" as const, inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
  [OPENAI_GPT_54_MINI_PRICE]: {
    currency: "USD" as const,
    inputMicrosPerMillion: 750_000,
    cachedInputMicrosPerMillion: 75_000,
    outputMicrosPerMillion: 4_500_000,
  },
} as const;

export const GROQ_COMMERCIAL_SCHEDULE: RateSchedule = {
  inputMicrosPerMillion: 150_000,
  cachedInputMicrosPerMillion: 75_000,
  outputMicrosPerMillion: 600_000,
};

export type PriceVersion = keyof typeof PRICE_SCHEDULES;
export type RateSchedule = {
  readonly inputMicrosPerMillion: number;
  readonly cachedInputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
};
export type ProviderEnv = Record<string, string | undefined>;

/** Deliberately conservative byte heuristic, not a model-tokenizer count. */
export function serializedRequestBudget(body: object, maxOutputTokens: number) {
  const serializedBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  const schema = (body as { text?: { format?: { schema?: unknown } } }).text?.format?.schema;
  const schemaBytes = schema ? Buffer.byteLength(JSON.stringify(schema), "utf8") : 0;
  const estimatedInputTokens = Math.ceil(serializedBytes / 3);
  const admissionInputTokens = Math.ceil(serializedBytes / 2) + 256;
  return { serializedBytes, schemaBytes, estimatedInputTokens, admissionInputTokens, maxOutputTokens, totalAdmissionTokens: admissionInputTokens + maxOutputTokens };
}

function verifiedGroqQuota(env: ProviderEnv, inputTokens: number, outputTokens: number) {
  const verifiedAt = Date.parse(env.ADEENA_GROQ_ACCOUNT_LIMITS_VERIFIED_AT ?? "");
  const number = (key: string) => {
    const value = env[key];
    return value && /^[0-9]+$/.test(value) ? Number(value) : NaN;
  };
  const rpm = number("ADEENA_GROQ_VERIFIED_RPM");
  const tpm = number("ADEENA_GROQ_VERIFIED_TPM");
  const remainingRequests = number("ADEENA_GROQ_VERIFIED_REMAINING_REQUESTS");
  const remainingTokens = number("ADEENA_GROQ_VERIFIED_REMAINING_TOKENS");
  const totalTokens = inputTokens + outputTokens;
  const shape = env.ADEENA_GROQ_VERIFIED_RATE_SHAPE;
  const split = shape === "split";
  const splitFits = !split || [
    number("ADEENA_GROQ_VERIFIED_ITPM") >= inputTokens,
    number("ADEENA_GROQ_VERIFIED_OTPM") >= outputTokens,
    number("ADEENA_GROQ_VERIFIED_REMAINING_INPUT_TOKENS") >= inputTokens,
    number("ADEENA_GROQ_VERIFIED_REMAINING_OUTPUT_TOKENS") >= outputTokens,
  ].every(Boolean);
  return env.ADEENA_GROQ_VERIFIED_PLAN === "free"
    && env.ADEENA_GROQ_VERIFIED_MODEL_AVAILABLE === "yes"
    && env.ADEENA_GROQ_VERIFIED_BILLING_ESCALATION === "none"
    && (shape === "combined" || split)
    && splitFits && Number.isFinite(verifiedAt) && Math.abs(Date.now() - verifiedAt) <= 300_000
    && [rpm, tpm, remainingRequests, remainingTokens].every(Number.isSafeInteger)
    && rpm >= 1 && remainingRequests >= 1 && tpm >= totalTokens && remainingTokens >= totalTokens;
}

export type EditSpend = {
  model: string;
  priceVersion: string;
  spendCapMicros: number;
  maxEditMicros: number;
  inputMicrosPerMillion: number;
  cachedInputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  apiUrl: string;
};

export function priceSchedule(version: string) {
  if (!Object.prototype.hasOwnProperty.call(PRICE_SCHEDULES, version)) return null;
  return PRICE_SCHEDULES[version as PriceVersion];
}

export function costMicros(version: string, inputTokens: number, outputTokens: number) {
  const schedule = priceSchedule(version);
  if (!schedule) return null;
  return Math.round((inputTokens * schedule.inputMicrosPerMillion + outputTokens * schedule.outputMicrosPerMillion) / 1_000_000);
}

export function paidCallAuthorization(env: ProviderEnv) {
  const key = env.ADEENA_AI_API_KEY?.trim() ?? "";
  const model = env.ADEENA_AI_MODEL?.trim() ?? "";
  const priceVersion = env.ADEENA_AI_PRICE_VERSION?.trim() ?? "";
  const spendCapUsd = Number(env.ADEENA_AI_SPEND_CAP_USD);
  const schedule = priceVersion ? priceSchedule(priceVersion) : null;
  if (!key || !model || !schedule || !Number.isFinite(spendCapUsd) || spendCapUsd <= 0) {
    return { ok: false as const, code: "budget-unavailable" as const };
  }
  return { ok: true as const, model, priceVersion, spendCapUsd };
}

export function selectGenerationProvider(env: ProviderEnv) {
  if (env.ADEENA_EXPERIENCE_PROVIDER === FIXTURE_PROVIDER) return FIXTURE_PROVIDER;
  if (env.ADEENA_EXPERIENCE_PROVIDER === CONFIGURED_PROVIDER) return CONFIGURED_PROVIDER;
  return "closed" as const;
}

export function paidEditAuthorization(env: ProviderEnv, schedules: Record<string, RateSchedule> = PRICE_SCHEDULES) {
  if (env.ADEENA_EXPERIENCE_PROVIDER !== CONFIGURED_PROVIDER) return { ok: false as const, code: "generation-unavailable" as const };
  const key = env.ADEENA_AI_API_KEY?.trim() ?? "";
  if (!key) return { ok: false as const, code: "generation-unavailable" as const };
  const model = env.ADEENA_AI_MODEL?.trim() ?? "";
  const priceVersion = env.ADEENA_AI_PRICE_VERSION?.trim() ?? "";
  const schedule = priceVersion && Object.prototype.hasOwnProperty.call(schedules, priceVersion) ? schedules[priceVersion] : null;
  const spendCapUsd = Number(env.ADEENA_AI_SPEND_CAP_USD);
  const maxEditUsd = Number(env.ADEENA_AI_MAX_EDIT_COST_USD);
  const apiUrl = httpsEndpoint(env.ADEENA_AI_API_URL);
  const ratesArePaid = Boolean(schedule
    && Number.isInteger(schedule.inputMicrosPerMillion)
    && Number.isInteger(schedule.cachedInputMicrosPerMillion)
    && Number.isInteger(schedule.outputMicrosPerMillion)
    && schedule.inputMicrosPerMillion >= 0
    && schedule.cachedInputMicrosPerMillion >= 0
    && schedule.cachedInputMicrosPerMillion <= schedule.inputMicrosPerMillion
    && schedule.outputMicrosPerMillion >= 0
    && (schedule.inputMicrosPerMillion > 0 || schedule.outputMicrosPerMillion > 0));
  const officialBinding = priceVersion === OPENAI_GPT_54_MINI_PRICE && (model !== OPENAI_GPT_54_MINI_MODEL || apiUrl !== OPENAI_RESPONSES_URL);
  if (!MODEL_NAME.test(model) || !PRICE_NAME.test(priceVersion) || priceVersion === FIXTURE_PRICE_VERSION || !ratesArePaid || !schedule || officialBinding || env.ADEENA_AI_SPEND_AUTHORIZED !== "development" || !Number.isFinite(spendCapUsd) || spendCapUsd <= 0 || !Number.isFinite(maxEditUsd) || maxEditUsd <= 0 || maxEditUsd > spendCapUsd || !apiUrl) {
    return { ok: false as const, code: "budget-unavailable" as const };
  }
  const spendCapMicros = Math.round(spendCapUsd * 1_000_000);
  const maxEditMicros = Math.round(maxEditUsd * 1_000_000);
  if (spendCapMicros <= 0 || maxEditMicros <= 0 || spendCapMicros > 2_000_000_000 || maxEditMicros > 2_000_000_000) {
    return { ok: false as const, code: "budget-unavailable" as const };
  }
  return {
    ok: true as const,
    spend: {
      model,
      priceVersion,
      spendCapMicros,
      maxEditMicros,
      inputMicrosPerMillion: schedule.inputMicrosPerMillion,
      cachedInputMicrosPerMillion: schedule.cachedInputMicrosPerMillion,
      outputMicrosPerMillion: schedule.outputMicrosPerMillion,
      apiUrl,
    },
  };
}

export function freeEditAuthorization(env: ProviderEnv) {
  if (env.ADEENA_AI_EXECUTION_MODE?.trim() !== "free-development") return { ok: false as const, code: "budget-unavailable" as const };
  const runtime = env.NODE_ENV?.trim() || process.env.NODE_ENV;
  const place = env.ADEENA_RUNTIME?.trim() ?? "";
  const sessionLimit = boundedLimit(env.ADEENA_FREE_SESSION_LIMIT, FREE_SESSION_CAP, FREE_SESSION_CAP);
  const dayLimit = boundedLimit(env.ADEENA_FREE_DAY_LIMIT, FREE_DAY_CAP, FREE_DAY_CAP);
  const key = env.ADEENA_GROQ_API_KEY?.trim() ?? "";
  const model = env.ADEENA_AI_MODEL?.trim() ?? "";
  const apiUrl = httpsEndpoint(env.ADEENA_AI_API_URL);
  const spendAuthorized = (env.ADEENA_AI_SPEND_AUTHORIZED?.trim() ?? "") !== "";
  if (runtime === "production" || (place !== "local-development" && place !== "nonproduction-test") || env.ADEENA_GROQ_PLAN?.trim() !== "free" || spendAuthorized || model !== GROQ_GPT_OSS_120B_MODEL || apiUrl !== GROQ_RESPONSES_URL || sessionLimit === null || dayLimit === null || sessionLimit > dayLimit) {
    return { ok: false as const, code: "budget-unavailable" as const };
  }
  if (env.ADEENA_EXPERIENCE_PROVIDER !== CONFIGURED_PROVIDER || !key) return { ok: false as const, code: "generation-unavailable" as const };
  return {
    ok: true as const,
    mode: "free-development" as const,
    model,
    priceVersion: GROQ_COMMERCIAL_PRICE,
    apiUrl,
    sessionLimit,
    dayLimit,
  };
}

export function configuredEditAuthorization(env: ProviderEnv, schedules: Record<string, RateSchedule> = PRICE_SCHEDULES) {
  const mode = env.ADEENA_AI_EXECUTION_MODE?.trim() ?? "";
  if (mode === "free-development") return freeEditAuthorization(env);
  if (mode === "" || mode === "paid-development") return paidEditAuthorization(env, schedules);
  return { ok: false as const, code: "budget-unavailable" as const };
}

function boundedLimit(value: string | undefined, fallback: number, cap: number) {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^[0-9]+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > cap) return null;
  return parsed;
}

export function editCallEstimate(spend: EditSpend) {
  return tokenCost(spend, MAX_INPUT_TOKENS, 0, MAX_OUTPUT_TOKENS);
}

export function billedMicros(schedule: RateSchedule, inputTokens: number, cachedInputTokens: number, outputTokens: number) {
  return tokenCost({
    model: "none",
    priceVersion: "unconfigured",
    spendCapMicros: 0,
    maxEditMicros: 0,
    apiUrl: OPENAI_RESPONSES_URL,
    ...schedule,
  }, inputTokens, cachedInputTokens, outputTokens);
}

export function closedProviderError(env: ProviderEnv): SourceErrorCode {
  const key = env.ADEENA_AI_API_KEY?.trim() ?? "";
  if (!key) return "generation-unavailable";
  const paid = paidCallAuthorization(env);
  return paid.ok ? "generation-unavailable" : paid.code;
}

export type PaidEditResult = {
  ok: boolean;
  code?: "budget-unavailable" | "generation-unavailable" | "provider-unavailable" | "invalid-experience" | "unsupported-edit";
  content?: unknown;
  model: string;
  priceVersion: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  responseId: string | null;
  callCount: number;
  retryCount: number;
  estimatedCostMicros: number;
  actualCostMicros: number;
  commercialEstimateMicros: number | null;
  usageKind: "none" | "estimate" | "actual";
  releaseReservation: boolean;
  executionMode: "paid-development" | "free-development";
  latencyMs: number | null;
  remainingRequests: number | null;
  remainingTokens: number | null;
  diagnostic?: string;
};

const EDIT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "scope", "gameplayChange", "factualChange", "objectiveChange", "uncertainty", "reviewRequirements", "operations"],
  properties: {
    intent: { type: "string" },
    scope: { type: "string", enum: ["scene", "experience"] },
    gameplayChange: { type: "boolean" },
    factualChange: { type: "boolean" },
    objectiveChange: { type: "boolean" },
    uncertainty: { type: ["string", "null"] },
    reviewRequirements: { type: "array", items: { type: "string" } },
    operations: {
      type: "array",
      items: {
        anyOf: [
          { type: "object", additionalProperties: false, required: ["op", "sceneId", "text"], properties: { op: { type: "string", enum: ["rewrite-text"] }, sceneId: { type: "string" }, text: { type: "string" } } },
          { type: "object", additionalProperties: false, required: ["op", "sceneId", "choiceId", "text"], properties: { op: { type: "string", enum: ["revise-choice"] }, sceneId: { type: "string" }, choiceId: { type: "string" }, text: { type: "string" } } },
          { type: "object", additionalProperties: false, required: ["op", "sceneId", "choiceId", "nextSceneId"], properties: { op: { type: "string", enum: ["retarget-choice"] }, sceneId: { type: "string" }, choiceId: { type: "string" }, nextSceneId: { type: "string" } } },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "sceneId", "title", "text", "choices"],
            properties: {
              op: { type: "string", enum: ["insert-decision"] },
              sceneId: { type: "string" },
              title: { type: "string" },
              text: { type: "string" },
              choices: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "text", "nextSceneId", "understanding"],
                  properties: { id: { type: "string" }, text: { type: "string" }, nextSceneId: { type: "string" }, understanding: { type: "integer" } },
                },
              },
            },
          },
          { type: "object", additionalProperties: false, required: ["op", "sceneId", "title"], properties: { op: { type: "string", enum: ["set-presentation"] }, sceneId: { type: "string" }, title: { type: "string" } } },
        ],
      },
    },
  },
} as const;

export async function requestPaidEdit(input: {
  env: ProviderEnv;
  systemText: string;
  userText: string;
  fetchImpl?: typeof fetch;
  schedules?: Record<string, RateSchedule>;
  timeoutMs?: number;
  retryDelayMs?: number;
  remainingAfterReserveMicros?: number;
  confirmRetry?: () => Promise<boolean>;
  outputSchema?: object;
  editMode?: "dialogue" | "graph";
  dialogueTarget?: DialogueTarget;
  structuredGeneration?: StructuredGeneration;
}): Promise<PaidEditResult> {
  const mode = input.env.ADEENA_AI_EXECUTION_MODE?.trim() ?? "";
  if (mode === "free-development") return requestFreeEdit(input);
  if (mode !== "" && mode !== "paid-development") return unused("budget-unavailable", "none", "unconfigured", 0);
  const auth = paidEditAuthorization(input.env, input.schedules ?? PRICE_SCHEDULES);
  if (!auth.ok) return unused(auth.code, "none", "unconfigured", 0);
  const spend = auth.spend;
  const tokenLimits = input.structuredGeneration ? GENERATION_LIMITS[input.structuredGeneration.kind] : { input: MAX_INPUT_TOKENS, output: MAX_OUTPUT_TOKENS };
  const estimated = tokenCost(spend, tokenLimits.input, 0, tokenLimits.output);
  const transport = input.structuredGeneration ? groqStrictTransportSchema(input.structuredGeneration.schema) : null;
  if (transport && !transport.ok) return { ...unused("invalid-experience", spend.model, spend.priceVersion, estimated ?? 0), diagnostic: `schema.compatibility: ${transport.issues[0].code} at ${transport.issues[0].path}` };
  const requestBody = {
    model: spend.model, store: false, max_output_tokens: tokenLimits.output, reasoning: { effort: "none" },
    input: [{ role: "system", content: input.systemText }, { role: "user", content: input.userText }],
    text: { format: { type: "json_schema", name: input.structuredGeneration ? `experience_${input.structuredGeneration.kind}` : "experience_edit", strict: true, schema: transport?.ok ? transport.schema : EDIT_OUTPUT_SCHEMA } },
  };
  const budget = serializedRequestBudget(requestBody, tokenLimits.output);
  if (input.structuredGeneration && (budget.admissionInputTokens > tokenLimits.input || (spend.apiUrl === GROQ_RESPONSES_URL && budget.totalAdmissionTokens > GROQ_CONTEXT_TOKENS))) return { ...unused("budget-unavailable", spend.model, spend.priceVersion, estimated ?? 0), diagnostic: "request.input-budget" };
  if (estimated === null || estimated > spend.maxEditMicros || estimated > spend.spendCapMicros || input.userText.length > (input.structuredGeneration ? 18000 : 12000) || input.systemText.length > (input.structuredGeneration ? 4000 : 2000)) {
    return unused("budget-unavailable", spend.model, spend.priceVersion, estimated ?? 0);
  }
  const key = input.env.ADEENA_AI_API_KEY?.trim() ?? "";
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 45_000;
  const retryDelayMs = input.retryDelayMs ?? 200;
  const room = input.remainingAfterReserveMicros ?? spend.spendCapMicros - estimated;
  let callCount = 0;
  let retryCount = 0;
  let response: Response | null = null;
  let held: { parsed: unknown | null } | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    callCount += 1;
    try {
      response = await fetchImpl(spend.apiUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(requestBody),
      });
    } catch {
      return charged("provider-unavailable", spend, estimated, callCount, retryCount, blankUsage(), "estimate", 0, false);
    }
    if (response.status === 429 && attempt === 0) {
      held = await readResponseBody(response);
      if (billingRefusal(held.parsed)) break;
      const usage = readTokenUsage(held.parsed);
      if (usage.reported) break;
      held = null;
      const allowed = room >= estimated && (input.confirmRetry ? await input.confirmRetry() : true);
      if (!allowed) return charged("provider-unavailable", spend, estimated, callCount, retryCount, blankUsage(), "none", 0, true);
      retryCount += 1;
      await delay(retryDelayMs);
      continue;
    }
    held = null;
    break;
  }
  if (!response) return charged("provider-unavailable", spend, estimated, callCount, retryCount, blankUsage(), "estimate", 0, false);
  const body = held ?? await readResponseBody(response);
  const usage = readTokenUsage(body.parsed);
  const responseId = readResponseId(body.parsed);
  if (!response.ok) {
    noteProviderFault(response.status, body.parsed, key, input.userText);
    if (usage.reported) return finish(spend, estimated, callCount, retryCount, usage, responseId, "provider-unavailable", null);
    const authRejected = response.status === 401 || response.status === 403;
    const billingRejected = response.status === 429 && billingRefusal(body.parsed);
    const unbilled = authRejected || billingRejected || response.status === 400 || response.status === 429;
    const code = authRejected ? "generation-unavailable" : billingRejected ? "budget-unavailable" : "provider-unavailable";
    return charged(code, spend, estimated, callCount, retryCount, blankUsage(), unbilled ? "none" : "estimate", 0, unbilled, responseId);
  }
  if (!body.parsed) return charged("invalid-experience", spend, estimated, callCount, retryCount, blankUsage(), "estimate", 0, false, responseId);
  if (input.structuredGeneration && (usage.inputTokens > tokenLimits.input || usage.outputTokens > tokenLimits.output)) return finish(spend, estimated, callCount, retryCount, usage, responseId, "budget-unavailable", null);
  const content = readModelContent(body.parsed);
  if (input.structuredGeneration) {
    const normalized = normalizeGroqStrictOutput(content, input.structuredGeneration.schema);
    if (!normalized.ok) return { ...finish(spend, estimated, callCount, retryCount, usage, responseId, "invalid-experience", null), diagnostic: `schema.normalization: ${normalized.diagnostic}` };
    return finish(spend, estimated, callCount, retryCount, usage, responseId, null, normalized.value);
  }
  return finish(spend, estimated, callCount, retryCount, usage, responseId, null, content);
}

async function requestFreeEdit(input: {
  env: ProviderEnv;
  systemText: string;
  userText: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  confirmRetry?: () => Promise<boolean>;
  outputSchema?: object;
  editMode?: "dialogue" | "graph";
  dialogueTarget?: DialogueTarget;
  structuredGeneration?: StructuredGeneration;
}): Promise<PaidEditResult> {
  const auth = freeEditAuthorization(input.env);
  if (!auth.ok) return { ...unused(auth.code, GROQ_GPT_OSS_120B_MODEL, GROQ_COMMERCIAL_PRICE, 0), executionMode: "free-development" };
  const tokenLimits = input.structuredGeneration ? GENERATION_LIMITS[input.structuredGeneration.kind] : { input: MAX_INPUT_TOKENS, output: MAX_OUTPUT_TOKENS };
  const ceiling = billedMicros(GROQ_COMMERCIAL_SCHEDULE, tokenLimits.input, 0, tokenLimits.output) ?? 0;
  const transport = input.structuredGeneration ? groqStrictTransportSchema(input.structuredGeneration.schema) : null;
  if (transport && !transport.ok) return { ...unused("invalid-experience", auth.model, auth.priceVersion, 0), executionMode: "free-development", diagnostic: `schema.compatibility: ${transport.issues[0].code} at ${transport.issues[0].path}` };
  const requestBody = {
    model: auth.model, instructions: input.systemText, input: input.userText,
    max_output_tokens: tokenLimits.output, reasoning: { effort: "low" }, tool_choice: "none",
    text: { format: { type: "json_schema", name: input.structuredGeneration ? `experience_${input.structuredGeneration.kind}` : "experience_edit", strict: true, schema: transport?.ok ? transport.schema : input.outputSchema ?? groqTransportSchema() } },
  };
  const budget = serializedRequestBudget(requestBody, tokenLimits.output);
  if (input.userText.length > (input.structuredGeneration ? 18000 : 12000) || input.systemText.length > (input.structuredGeneration ? 4000 : 2000)
    || (input.structuredGeneration && (budget.admissionInputTokens > tokenLimits.input || budget.totalAdmissionTokens > GROQ_CONTEXT_TOKENS))) {
    return { ...unused("budget-unavailable", auth.model, auth.priceVersion, 0), executionMode: "free-development" };
  }
  if (input.structuredGeneration && !verifiedGroqQuota(input.env, budget.admissionInputTokens, budget.maxOutputTokens)) return { ...unused("budget-unavailable", auth.model, auth.priceVersion, 0), executionMode: "free-development", diagnostic: "account.verified-quota-unavailable" };
  const key = input.env.ADEENA_GROQ_API_KEY?.trim() ?? "";
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 45_000;
  const spend = commercialSpend(auth.model, auth.priceVersion, auth.apiUrl);
  const started = Date.now();
  let callCount = 0;
  let retryCount = 0;
  let response: Response | null = null;
  let held: { parsed: unknown | null } | null = null;
  let limits = { remainingRequests: null as number | null, remainingTokens: null as number | null };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    callCount += 1;
    try {
      response = await fetchImpl(auth.apiUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(requestBody),
      });
    } catch {
      return asFree(charged("provider-unavailable", spend, ceiling, callCount, retryCount, blankUsage(), "none", 0, false), limits, started, ceiling);
    }
    limits = rateLimitSnapshot(response);
    if (response.status === 429 && attempt === 0) {
      held = await readResponseBody(response);
      const retryAfterSeconds = retryAfterSecondsOf(response);
      const transient = retryAfterSeconds !== null && retryAfterSeconds <= FREE_RETRY_SECONDS && limits.remainingRequests !== null && limits.remainingRequests > 0;
      if (!transient || billingRefusal(held.parsed) || readTokenUsage(held.parsed).reported) break;
      const allowed = input.confirmRetry ? await input.confirmRetry() : false;
      if (!allowed) break;
      retryCount += 1;
      held = null;
      await delay(input.retryDelayMs ?? retryAfterSeconds * 1_000);
      continue;
    }
    held = null;
    break;
  }
  if (!response) return asFree(charged("provider-unavailable", spend, ceiling, callCount, retryCount, blankUsage(), "none", 0, false), limits, started, ceiling);
  const body = held ?? await readResponseBody(response);
  if (response.ok) noteProviderResult(response.status, readResponseId(body.parsed));
  const usage = readTokenUsage(body.parsed);
  const responseId = readResponseId(body.parsed);
  if (!response.ok) {
    noteProviderFault(response.status, body.parsed, key, input.userText);
    if (usage.reported) {
      return asFree(finish(spend, ceiling, callCount, retryCount, usage, responseId, "provider-unavailable", null), limits, started, ceiling);
    }
    const authRejected = response.status === 401 || response.status === 403;
    const dailyExhausted = response.status === 429 && (limits.remainingRequests === 0 || billingRefusal(body.parsed));
    const code = authRejected ? "generation-unavailable" : dailyExhausted ? "budget-unavailable" : "provider-unavailable";
    return asFree(charged(code, spend, ceiling, callCount, retryCount, blankUsage(), "none", 0, false, responseId), limits, started, ceiling);
  }
  if (!body.parsed || !usage.reported || usage.inconsistent) {
    const unfinished = body.parsed
      ? finish(spend, ceiling, callCount, retryCount, usage, responseId, null, null)
      : charged("invalid-experience", spend, ceiling, callCount, retryCount, blankUsage(), "estimate", 0, false, responseId);
    return asFree(unfinished, limits, started, ceiling);
  }
  const extracted = readGroqAssistantPayload(body.parsed);
  if (!extracted.ok) {
    const status = extracted.status === "refusal" || extracted.status === "incomplete" || extracted.status === "failed" ? extracted.status : "invalid";
    return { ...asFree(finish(spend, ceiling, callCount, retryCount, usage, responseId, null, { status }), limits, started, ceiling), diagnostic: extracted.diagnostic };
  }
  if (input.structuredGeneration) {
    const normalized = normalizeGroqStrictOutput(extracted.payload, input.structuredGeneration.schema);
    const result = asFree(finish(spend, ceiling, callCount, retryCount, usage, responseId, normalized.ok ? null : "invalid-experience", normalized.ok ? normalized.value : null), limits, started, ceiling);
    if (!normalized.ok) return { ...result, diagnostic: `schema.normalization: ${normalized.diagnostic}` };
    if (result.inputTokens > tokenLimits.input || result.outputTokens > tokenLimits.output) return { ...result, ok: false, code: "budget-unavailable", content: undefined };
    return result;
  }
  const mapped = input.editMode === "graph" ? mapGroqGraphTransport(extracted.payload) : mapGroqTransport(extracted.payload, input.dialogueTarget);
  if (!mapped.ok) {
    const rejected = asFree(finish(spend, ceiling, callCount, retryCount, usage, responseId, null, { status: "invalid" }), limits, started, ceiling);
    return { ...rejected, ok: false, code: mapped.code, content: undefined, diagnostic: mapped.diagnostic };
  }
  const finished = finish(spend, ceiling, callCount, retryCount, usage, responseId, null, mapped.edit);
  const free = asFree(finished, limits, started, ceiling);
  if (free.ok && (free.inputTokens > MAX_INPUT_TOKENS || free.outputTokens > MAX_OUTPUT_TOKENS)) {
    return { ...free, ok: false, code: "budget-unavailable", content: undefined };
  }
  return free;
}

function commercialSpend(model: string, priceVersion: string, apiUrl: string): EditSpend {
  return {
    model,
    priceVersion,
    spendCapMicros: 2_000_000_000,
    maxEditMicros: 2_000_000_000,
    apiUrl,
    ...GROQ_COMMERCIAL_SCHEDULE,
  };
}

function asFree(result: PaidEditResult, limits: { remainingRequests: number | null; remainingTokens: number | null }, started: number, ceiling: number): PaidEditResult {
  const commercialEstimateMicros = result.usageKind === "actual"
    ? result.actualCostMicros
    : result.usageKind === "estimate" ? ceiling : null;
  return {
    ...result,
    estimatedCostMicros: 0,
    actualCostMicros: 0,
    commercialEstimateMicros,
    releaseReservation: false,
    executionMode: "free-development",
    latencyMs: Math.max(0, Date.now() - started),
    remainingRequests: limits.remainingRequests,
    remainingTokens: limits.remainingTokens,
  };
}

function rateLimitSnapshot(response: Response) {
  return {
    remainingRequests: headerInt(response, "x-ratelimit-remaining-requests"),
    remainingTokens: headerInt(response, "x-ratelimit-remaining-tokens"),
  };
}

function retryAfterSecondsOf(response: Response) {
  const raw = response.headers.get("retry-after")?.trim() ?? "";
  if (!/^[0-9]+$/.test(raw)) return null;
  const seconds = Number(raw);
  return seconds <= 86_400 ? seconds : null;
}

function headerInt(response: Response, name: string) {
  const raw = response.headers.get(name)?.trim() ?? "";
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return value <= 2_000_000_000 ? value : null;
}

function httpsEndpoint(value: string | undefined) {
  try {
    const url = new URL((value ?? "").trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

type TokenUsage = {
  reported: boolean;
  inconsistent: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

function tokenCost(spend: EditSpend, inputTokens: number, cachedInputTokens: number, outputTokens: number) {
  if (!Number.isInteger(inputTokens) || !Number.isInteger(cachedInputTokens) || !Number.isInteger(outputTokens)) return null;
  if (inputTokens < 0 || cachedInputTokens < 0 || outputTokens < 0 || cachedInputTokens > inputTokens) return null;
  if (inputTokens > 1_000_000 || outputTokens > 1_000_000) return null;
  const uncached = inputTokens - cachedInputTokens;
  const micros = Math.round((uncached * spend.inputMicrosPerMillion + cachedInputTokens * spend.cachedInputMicrosPerMillion + outputTokens * spend.outputMicrosPerMillion) / 1_000_000);
  if (!Number.isFinite(micros) || micros < 0 || micros > 2_000_000_000) return null;
  return micros;
}

function blankUsage(): TokenUsage {
  return { reported: false, inconsistent: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

function unused(code: NonNullable<PaidEditResult["code"]>, model: string, priceVersion: string, estimatedCostMicros: number): PaidEditResult {
  return {
    ok: false, code, model, priceVersion, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    responseId: null, callCount: 0, retryCount: 0, estimatedCostMicros, actualCostMicros: 0, commercialEstimateMicros: null,
    usageKind: "none", releaseReservation: false, executionMode: "paid-development", latencyMs: null, remainingRequests: null, remainingTokens: null,
  };
}

function charged(
  code: NonNullable<PaidEditResult["code"]>,
  spend: EditSpend,
  estimatedCostMicros: number,
  callCount: number,
  retryCount: number,
  usage: TokenUsage,
  usageKind: PaidEditResult["usageKind"],
  actualCostMicros = 0,
  releaseReservation = false,
  responseId: string | null = null,
): PaidEditResult {
  return {
    ok: false, code, model: spend.model, priceVersion: spend.priceVersion,
    inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens,
    responseId, callCount, retryCount, estimatedCostMicros, actualCostMicros, commercialEstimateMicros: null,
    usageKind, releaseReservation, executionMode: "paid-development", latencyMs: null, remainingRequests: null, remainingTokens: null,
  };
}

function finish(
  spend: EditSpend,
  estimated: number,
  callCount: number,
  retryCount: number,
  usage: TokenUsage,
  responseId: string | null,
  forced: PaidEditResult["code"] | null,
  content: unknown | null,
): PaidEditResult {
  if (!usage.reported || usage.inconsistent) {
    return charged(forced ?? "invalid-experience", spend, estimated, callCount, retryCount, usage.reported ? usage : blankUsage(), "estimate", 0, false, responseId);
  }
  const actual = tokenCost(spend, usage.inputTokens, usage.cachedInputTokens, usage.outputTokens);
  if (actual === null || actual > spend.maxEditMicros || actual > spend.spendCapMicros) {
    return charged("budget-unavailable", spend, estimated, callCount, retryCount, usage, "actual", actual ?? 0, false, responseId);
  }
  const outcome = readOutcome(content);
  if (forced || outcome === "refusal" || outcome === "incomplete" || outcome === "failed" || outcome === "invalid") {
    const code = forced ?? (outcome === "refusal" ? "unsupported-edit" : outcome === "invalid" ? "invalid-experience" : "provider-unavailable");
    return charged(code, spend, estimated, callCount, retryCount, usage, "actual", actual, false, responseId);
  }
  return {
    ok: true, content, model: spend.model, priceVersion: spend.priceVersion,
    inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens,
    responseId, callCount, retryCount, estimatedCostMicros: estimated, actualCostMicros: actual, commercialEstimateMicros: null,
    usageKind: "actual", releaseReservation: false, executionMode: "paid-development", latencyMs: null, remainingRequests: null, remainingTokens: null,
  };
}

function readTokenUsage(value: unknown): TokenUsage {
  const usage = value && typeof value === "object" && "usage" in value ? value.usage : null;
  if (!usage || typeof usage !== "object") return blankUsage();
  const inputTokens = whole("input_tokens" in usage ? usage.input_tokens : null);
  const outputTokens = whole("output_tokens" in usage ? usage.output_tokens : null);
  if (inputTokens === null || outputTokens === null) return blankUsage();
  const inputDetails = "input_tokens_details" in usage && usage.input_tokens_details && typeof usage.input_tokens_details === "object" ? usage.input_tokens_details : null;
  const outputDetails = "output_tokens_details" in usage && usage.output_tokens_details && typeof usage.output_tokens_details === "object" ? usage.output_tokens_details : null;
  const cachedInputTokens = inputDetails && "cached_tokens" in inputDetails ? whole(inputDetails.cached_tokens) ?? -1 : 0;
  const reasoningTokens = outputDetails && "reasoning_tokens" in outputDetails ? whole(outputDetails.reasoning_tokens) ?? -1 : 0;
  const inconsistent = cachedInputTokens < 0 || reasoningTokens < 0 || cachedInputTokens > inputTokens || reasoningTokens > outputTokens;
  return { reported: !inconsistent, inconsistent, inputTokens, cachedInputTokens: Math.max(0, cachedInputTokens), outputTokens, reasoningTokens: Math.max(0, reasoningTokens) };
}

function whole(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
}

function readResponseId(value: unknown) {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !RESPONSE_ID.test(value.id)) return null;
  return value.id;
}

function readModelContent(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const status = "status" in value ? value.status : null;
  if (status !== "completed") return { status };
  if (!("output" in value) || !Array.isArray(value.output)) return { status: "invalid" };
  const messages = value.output.filter((item) => item && typeof item === "object" && "type" in item && item.type === "message");
  if (messages.length !== 1) return { status: "invalid" };
  const message = messages[0];
  if (!message || typeof message !== "object" || !("content" in message) || !Array.isArray(message.content)) return { status: "invalid" };
  const texts: string[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object" || !("type" in part)) continue;
    if (part.type === "refusal") return { status: "refusal" };
    if (part.type === "output_text" && "text" in part && typeof part.text === "string") texts.push(part.text);
  }
  if (texts.length !== 1) return { status: "invalid" };
  try {
    const parsed = JSON.parse(texts[0]?.trim() ?? "") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "invalid" };
    return parsed;
  } catch {
    return { status: "invalid" };
  }
}

function readOutcome(content: unknown) {
  if (!content || typeof content !== "object" || Array.isArray(content) || !("status" in content)) return "edit";
  if (content.status === "refusal" || content.status === "incomplete" || content.status === "failed" || content.status === "invalid") return content.status;
  return "invalid";
}

function billingRefusal(parsed: unknown) {
  const error = parsed && typeof parsed === "object" && "error" in parsed && parsed.error && typeof parsed.error === "object" ? parsed.error : null;
  const code = error && "code" in error && typeof error.code === "string" ? error.code : "";
  return code === "credit_balance_exhausted" || code === "insufficient_quota" || code === "billing_hard_limit_reached";
}

export function logEditDiagnostic(code: string) {
  const file = process.env.ADEENA_AI_FAULT_LOG;
  if (!file || !file.startsWith(tmpdir()) || !/^[a-z0-9._:()|-]{1,120}$/i.test(code)) return;
  appendFileSync(file, `validation ${code}\n`);
}

function noteProviderResult(status: number, responseId: string | null) {
  const file = process.env.ADEENA_AI_FAULT_LOG;
  if (!file || !file.startsWith(tmpdir())) return;
  appendFileSync(file, `${status} completed ${responseId ?? "none"}\n`);
}

function noteProviderFault(status: number, parsed: unknown, secret: string, userText: string) {
  const file = process.env.ADEENA_AI_FAULT_LOG;
  if (!file || !file.startsWith(tmpdir())) return;
  const error = parsed && typeof parsed === "object" && "error" in parsed && parsed.error && typeof parsed.error === "object" ? parsed.error : null;
  const code = error && "code" in error && typeof error.code === "string" ? error.code : "";
  const text = error && "message" in error && typeof error.message === "string" ? error.message : "";
  let message = `${code} ${text}`.replace(/\s+/g, " ").slice(0, 240);
  if (secret && message.includes(secret)) return;
  if (userText) message = message.split(userText).join("[redacted]");
  appendFileSync(file, `${status} ${message}\n`);
}

async function readResponseBody(response: Response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return { parsed: null };
  }
  if (!text || text.length > 20_000) return { parsed: null };
  try {
    return { parsed: JSON.parse(text) as unknown };
  } catch {
    return { parsed: null };
  }
}

function delay(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
