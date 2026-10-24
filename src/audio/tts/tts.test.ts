import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { authorizeTts, billableCharacters, conservativeCostMicros } from "./authorization";
import { narrationCacheKey, normalizeNarrationText } from "./cache-key";
import { TtsError } from "./errors";
import { mp3DurationMs, validateSynthesizedAudio } from "./media";
import { AzureSpeechNarrationProvider, FakeNarrationProvider, configuredVoiceProfiles } from "./providers";

const request = { text: "Water & air move.", locale: "en-US", voiceProfileId: "educator-warm-1" as const, style: "warm" as const, rate: 1, idempotencyKey: randomUUID() };
function mp3(frames = 10) { const bytes = new Uint8Array(frames * 144); for (let i=0;i<frames;i+=1) bytes.set([0xff,0xf3,0x64,0],i*144); return bytes; }
const azureEnv = {
  ADEENA_TTS_PROVIDER: "azure-speech", AZURE_SPEECH_KEY: "secret", AZURE_SPEECH_REGION: "eastus",
  ADEENA_TTS_SPENDING_AUTHORIZED: "development", ADEENA_TTS_PRICING_VERSION: "azure-neural-2026-10",
  ADEENA_TTS_PRICE_MICROS_PER_MILLION_CHARACTERS: "16000000", ADEENA_TTS_MAX_REQUEST_MICROS: "10000",
  ADEENA_TTS_DEVELOPMENT_CAP_MICROS: "100000", ADEENA_TTS_AZURE_VOICE_PROFILES: JSON.stringify({ "educator-warm-1": { voiceName: "en-US-AvaNeural", locale: "en-US", styleMap: { calm: "calm", warm: "friendly", energetic: "cheerful" } } }),
};

describe("TTS authorization and caching", () => {
  it("fails closed without provider, credentials, authorization, pricing, or ceilings", () => {
    for (const key of ["ADEENA_TTS_PROVIDER","AZURE_SPEECH_KEY","ADEENA_TTS_SPENDING_AUTHORIZED","ADEENA_TTS_PRICING_VERSION","ADEENA_TTS_MAX_REQUEST_MICROS","ADEENA_TTS_DEVELOPMENT_CAP_MICROS"] as const) {
      const env = { ...azureEnv, [key]: undefined };
      expect(() => authorizeTts(env)).toThrow(TtsError);
    }
  });
  it("uses the configured character schedule and a deterministic normalized key", () => {
    const auth = authorizeTts(azureEnv);
    expect(billableCharacters("A 漢")).toBe(4);
    expect(conservativeCostMicros(auth, 10)).toBe(160);
    expect(normalizeNarrationText("  Water\n  moves  ")).toBe("Water moves");
    const base = { text: "Water  moves", locale: "en-US", voiceProfileId: "educator-warm-1", style: "warm", rate: 1, providerId: auth.providerId, modelId: auth.modelId, outputFormat: auth.outputFormat };
    expect(narrationCacheKey(base)).toBe(narrationCacheKey({ ...base, text: " Water\n moves " }));
    expect(narrationCacheKey(base)).not.toBe(narrationCacheKey({ ...base, rate: 1.1 }));
  });
});

describe("TTS providers and media validation", () => {
  it("creates deterministic valid zero-cost fixture audio", async () => {
    const provider = new FakeNarrationProvider();
    const one = await provider.synthesize(request);
    const two = await provider.synthesize(request);
    expect(one.mimeType).toBe("audio/wav");
    expect(one.checksum).toBe(two.checksum);
    expect(provider.calls).toBe(2);
    expect(validateSynthesizedAudio(one).durationMs).toBe(one.durationMs);
  });
  it("validates MP3 signatures and measured frame duration", () => {
    expect(mp3DurationMs(mp3())).toBe(240);
    expect(() => mp3DurationMs(new Uint8Array([1,2,3]))).toThrowError("invalid-audio");
    expect(() => validateSynthesizedAudio({ bytes: new Uint8Array(8 * 1024 * 1024 + 1), mimeType: "audio/mpeg" })).toThrowError("oversized-audio");
    const fixture = new Uint8Array(44 + 8_000 * 2);
    const view = new DataView(fixture.buffer); fixture.set(Buffer.from("RIFF"),0); view.setUint32(4,fixture.length-8,true); fixture.set(Buffer.from("WAVEfmt "),8);
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,8_000,true); view.setUint32(28,16_000,true); view.setUint16(32,2,true); view.setUint16(34,16,true); fixture.set(Buffer.from("data"),36); view.setUint32(40,16_000,true);
    expect(() => validateSynthesizedAudio({ bytes: fixture, mimeType: "audio/wav", declaredDurationMs: 3_000 })).toThrowError("invalid-audio");
  });
  it("retrieves the endpoint voice catalog, escapes text, and returns verified MP3", async () => {
    const bytes = mp3();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ ShortName: "en-US-AvaNeural", Locale: "en-US", Status: "GA", StyleList: ["calm","friendly","cheerful"] }]), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { "content-type": "audio/mpeg" } }));
    const auth = authorizeTts(azureEnv);
    const provider = new AzureSpeechNarrationProvider(auth, configuredVoiceProfiles(azureEnv), fetchImpl);
    const result = await provider.synthesize(request);
    expect(result.durationMs).toBe(240);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const synthesis = fetchImpl.mock.calls[1];
    expect(String(synthesis[0])).toContain("eastus.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(String((synthesis[1] as RequestInit).body)).toContain("Water &amp; air move.");
    expect(String((synthesis[1] as RequestInit).body)).not.toContain("<script");
  });
  it("rejects unsupported voices before synthesis and invalid returned audio", async () => {
    const auth = authorizeTts(azureEnv);
    const unsupportedFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    await expect(new AzureSpeechNarrationProvider(auth, configuredVoiceProfiles(azureEnv), unsupportedFetch).synthesize(request)).rejects.toMatchObject({ code: "unsupported-voice" });
    expect(unsupportedFetch).toHaveBeenCalledTimes(1);
    const badFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ ShortName: "en-US-AvaNeural", Locale: "en-US", StyleList: ["friendly"] }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1,2,3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    await expect(new AzureSpeechNarrationProvider(auth, configuredVoiceProfiles(azureEnv), badFetch).synthesize(request)).rejects.toMatchObject({ code: "invalid-audio", knownCharge: true });
  });
  it("distinguishes preflight network failure from an uncertain synthesis timeout", async () => {
    const auth = authorizeTts(azureEnv);
    const preflight = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(new AzureSpeechNarrationProvider(auth, configuredVoiceProfiles(azureEnv), preflight).synthesize(request)).rejects.toMatchObject({ code: "provider-network", uncertainCharge: false });
    const timedOut = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ ShortName: "en-US-AvaNeural", Locale: "en-US", StyleList: ["friendly"] }]), { status: 200 }))
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    await expect(new AzureSpeechNarrationProvider(auth, configuredVoiceProfiles(azureEnv), timedOut).synthesize(request)).rejects.toMatchObject({ code: "provider-timeout", uncertainCharge: true });
  });
});
