import { createHash } from "node:crypto";
import { VoiceSynthesisRequestV1, VoiceSynthesisResultMetadataV1, type NarrationProvider, type VoiceSynthesisRequest, type VoiceSynthesisResult } from "@/experience/visual-director/schema";
import { AUDIO_ASSET_LIMITS } from "@/audio/contract";
import { AZURE_MP3_FORMAT, AZURE_TTS_PROVIDER, FAKE_TTS_PROVIDER, type TtsAuthorization, type TtsEnvironment } from "./authorization";
import { TtsError } from "./errors";
import { validateSynthesizedAudio } from "./media";

type VoiceProfile = { voiceName: string; locale: string; styleMap: Record<VoiceSynthesisRequest["style"], string> };
type AzureVoice = { ShortName?: unknown; Locale?: unknown; SecondaryLocaleList?: unknown; StyleList?: unknown; Status?: unknown };

const PROFILE = /^[a-z][a-z0-9-]{0,119}$/;
const VOICE_NAME = /^[A-Za-z0-9():.-]{1,120}$/;
const AZURE_STYLE = /^[a-z][a-z0-9-]{0,60}$/;
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

function fixtureWav(text: string) {
  const sampleRate = 8_000;
  const samples = Math.max(2_000, Math.min(24_000, text.length * 160));
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); ascii(8, "WAVE"); ascii(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, samples * 2, true);
  const seed = createHash("sha256").update(text).digest().readUInt16BE(0);
  for (let index = 0; index < samples; index += 1) view.setInt16(44 + index * 2, Math.round(Math.sin(index * (180 + seed % 240) * Math.PI * 2 / sampleRate) * 900), true);
  return bytes;
}

/** Deterministic, zero-cost test adapter. Its tone output must never be described as speech. */
export class FakeNarrationProvider implements NarrationProvider {
  calls = 0;
  async synthesize(raw: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    const input = VoiceSynthesisRequestV1.parse(raw);
    this.calls += 1;
    const bytes = fixtureWav(input.text);
    const checked = validateSynthesizedAudio({ bytes, mimeType: "audio/wav" });
    return { ...VoiceSynthesisResultMetadataV1.parse({ mimeType: "audio/wav", durationMs: checked.durationMs, timepoints: [], providerUsage: { characterCount: [...input.text].length, audioDurationMs: checked.durationMs }, checksum: checked.checksum }), bytes };
  }
}

export function configuredVoiceProfiles(env: TtsEnvironment): Record<string, VoiceProfile> {
  let parsed: unknown;
  try { parsed = JSON.parse(env.ADEENA_TTS_AZURE_VOICE_PROFILES ?? "{}"); } catch { throw new TtsError("authorization-required"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TtsError("authorization-required");
  const profiles: Record<string, VoiceProfile> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!PROFILE.test(id) || !value || typeof value !== "object" || !("voiceName" in value) || !("locale" in value) || !("styleMap" in value)
      || typeof value.voiceName !== "string" || !VOICE_NAME.test(value.voiceName) || typeof value.locale !== "string" || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(value.locale)
      || !value.styleMap || typeof value.styleMap !== "object" || Array.isArray(value.styleMap)) throw new TtsError("authorization-required");
    const styles = value.styleMap as Record<string, unknown>;
    if (!["calm","warm","energetic"].every((style) => typeof styles[style] === "string" && AZURE_STYLE.test(styles[style]))) throw new TtsError("authorization-required");
    profiles[id] = { voiceName: value.voiceName, locale: value.locale, styleMap: styles as VoiceProfile["styleMap"] };
  }
  if (Object.keys(profiles).length === 0) throw new TtsError("authorization-required");
  return profiles;
}

export class AzureSpeechNarrationProvider implements NarrationProvider {
  private voices: Promise<AzureVoice[]> | null = null;
  constructor(private readonly auth: TtsAuthorization, private readonly profiles: Record<string, VoiceProfile>, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 20_000) {
    if (auth.providerId !== AZURE_TTS_PROVIDER || !auth.credentials) throw new TtsError("authorization-required");
  }
  private endpoint(path: string) { return `https://${this.auth.credentials?.region}.tts.speech.microsoft.com/${path}`; }
  private async supportedVoices() {
    this.voices ??= this.fetchImpl(this.endpoint("cognitiveservices/voices/list"), { headers: { "Ocp-Apim-Subscription-Key": this.auth.credentials!.key }, signal: AbortSignal.timeout(this.timeoutMs) })
      .then(async (response) => {
        if (!response.ok) throw new TtsError("provider-network");
        const value: unknown = await response.json();
        if (!Array.isArray(value)) throw new TtsError("provider-network");
        return value as AzureVoice[];
      }).catch((error) => { throw error instanceof TtsError ? error : new TtsError(error instanceof DOMException && error.name === "TimeoutError" ? "provider-timeout" : "provider-network"); });
    return this.voices;
  }
  async synthesize(raw: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    const input = VoiceSynthesisRequestV1.parse(raw);
    const profile = this.profiles[input.voiceProfileId];
    if (!profile || profile.locale !== input.locale) throw new TtsError("unsupported-voice");
    const providerStyle = profile.styleMap[input.style];
    const supported = (await this.supportedVoices()).some((voice) => voice.ShortName === profile.voiceName
      && (voice.Locale === input.locale || Array.isArray(voice.SecondaryLocaleList) && voice.SecondaryLocaleList.includes(input.locale))
      && Array.isArray(voice.StyleList) && voice.StyleList.includes(providerStyle));
    if (!supported) throw new TtsError("unsupported-voice");
    const rateValue = Math.round((input.rate - 1) * 100);
    const rate = `${rateValue >= 0 ? "+" : ""}${rateValue}%`;
    const ssml = `<speak version="1.0" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${escapeXml(input.locale)}"><voice name="${escapeXml(profile.voiceName)}"><mstts:express-as style="${providerStyle}"><prosody rate="${rate}">${escapeXml(input.text)}</prosody></mstts:express-as></voice></speak>`;
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint("cognitiveservices/v1"), { method: "POST", headers: {
        "Ocp-Apim-Subscription-Key": this.auth.credentials!.key, "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": AZURE_MP3_FORMAT, "User-Agent": "AdeenaNarration/1",
      }, body: ssml, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new TtsError(error instanceof DOMException && error.name === "TimeoutError" ? "provider-timeout" : "provider-network", true);
    }
    if (!response.ok) throw new TtsError("provider-network", response.status >= 500 || response.status === 429);
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("audio/mpeg")) throw new TtsError("invalid-audio", false, true);
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > AUDIO_ASSET_LIMITS.maxBytes) throw new TtsError("oversized-audio", false, true);
    let checked: ReturnType<typeof validateSynthesizedAudio>;
    try { checked = validateSynthesizedAudio({ bytes: body, mimeType: "audio/mpeg" }); }
    catch { throw new TtsError("invalid-audio", false, true); }
    return { ...VoiceSynthesisResultMetadataV1.parse({ mimeType: "audio/mpeg", durationMs: checked.durationMs, timepoints: [], providerUsage: { characterCount: [...input.text].length, audioDurationMs: checked.durationMs }, checksum: checked.checksum }), bytes: body };
  }
}

export function createNarrationProvider(auth: TtsAuthorization, env: TtsEnvironment = process.env, fetchImpl: typeof fetch = fetch) {
  return auth.providerId === FAKE_TTS_PROVIDER ? new FakeNarrationProvider() : new AzureSpeechNarrationProvider(auth, configuredVoiceProfiles(env), fetchImpl);
}
