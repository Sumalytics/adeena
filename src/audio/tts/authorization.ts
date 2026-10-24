import { TtsError } from "./errors";

export const AZURE_TTS_PROVIDER = "azure-speech" as const;
export const FAKE_TTS_PROVIDER = "fake" as const;
export const AZURE_MP3_FORMAT = "audio-24khz-48kbitrate-mono-mp3" as const;
export type TtsEnvironment = Record<string, string | undefined>;

export type TtsAuthorization = {
  providerId: typeof AZURE_TTS_PROVIDER | typeof FAKE_TTS_PROVIDER;
  modelId: string;
  pricingVersion: string;
  microsPerMillionCharacters: number;
  requestCeilingMicros: number;
  developmentCeilingMicros: number;
  outputFormat: typeof AZURE_MP3_FORMAT | "fixture-wav";
  credentials?: { key: string; region: string };
};

const NAME = /^[a-z0-9@.-]{1,80}$/;
const REGION = /^[a-z0-9-]{2,40}$/;
const positiveWhole = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export function authorizeTts(env: TtsEnvironment = process.env): TtsAuthorization {
  if (env.ADEENA_TTS_PROVIDER === FAKE_TTS_PROVIDER) {
    if (env.NODE_ENV === "production") throw new TtsError("provider-unavailable");
    return { providerId: FAKE_TTS_PROVIDER, modelId: "deterministic-fixture", pricingVersion: "fixture-0", microsPerMillionCharacters: 0, requestCeilingMicros: 0, developmentCeilingMicros: 0, outputFormat: "fixture-wav" };
  }
  if (env.ADEENA_TTS_PROVIDER !== AZURE_TTS_PROVIDER) throw new TtsError("provider-unavailable");
  const key = env.AZURE_SPEECH_KEY?.trim() ?? "";
  const region = env.AZURE_SPEECH_REGION?.trim().toLowerCase() ?? "";
  const pricingVersion = env.ADEENA_TTS_PRICING_VERSION?.trim() ?? "";
  const rate = positiveWhole(env.ADEENA_TTS_PRICE_MICROS_PER_MILLION_CHARACTERS);
  const requestCeilingMicros = positiveWhole(env.ADEENA_TTS_MAX_REQUEST_MICROS);
  const developmentCeilingMicros = positiveWhole(env.ADEENA_TTS_DEVELOPMENT_CAP_MICROS);
  if (env.ADEENA_TTS_SPENDING_AUTHORIZED !== "development" || !key || !REGION.test(region) || !NAME.test(pricingVersion)
    || pricingVersion === "fixture-0" || rate === null || requestCeilingMicros === null || developmentCeilingMicros === null
    || requestCeilingMicros > developmentCeilingMicros) throw new TtsError("authorization-required");
  return {
    providerId: AZURE_TTS_PROVIDER, modelId: "azure-neural-tts", pricingVersion, microsPerMillionCharacters: rate,
    requestCeilingMicros, developmentCeilingMicros, outputFormat: AZURE_MP3_FORMAT, credentials: { key, region },
  };
}

/** Azure bills Unicode code points, with CJK unified ideographs counted twice. */
export function billableCharacters(text: string) {
  let total = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    total += point >= 0x3400 && point <= 0x9fff ? 2 : 1;
  }
  return total;
}

export function conservativeCostMicros(auth: TtsAuthorization, characters: number) {
  if (!Number.isSafeInteger(characters) || characters < 0) throw new TtsError("invalid-input");
  return Math.ceil(characters * auth.microsPerMillionCharacters / 1_000_000);
}

/** Azure bills SSML markup as well as text. This exceeds Adeena's fixed wrapper. */
export function conservativelyMeteredCharacters(auth: TtsAuthorization, text: string) {
  return billableCharacters(text) + (auth.providerId === AZURE_TTS_PROVIDER ? 512 : 0);
}
