# Task 04B-2 narration generation

The server now turns an explicitly approved narration segment into a private Creator audio asset. `fake` is a deterministic tone adapter for tests and is never presented as synthesized speech. `azure-speech` uses Azure's regional REST voice-list and synthesis endpoints with `audio-24khz-48kbitrate-mono-mp3`.

Azure configuration is fail closed. All of these values are required:

```text
ADEENA_TTS_PROVIDER=azure-speech
AZURE_SPEECH_KEY=<server secret>
AZURE_SPEECH_REGION=<resource region>
ADEENA_TTS_SPENDING_AUTHORIZED=development
ADEENA_TTS_PRICING_VERSION=<verified schedule identifier>
ADEENA_TTS_PRICE_MICROS_PER_MILLION_CHARACTERS=<integer>
ADEENA_TTS_MAX_REQUEST_MICROS=<integer>
ADEENA_TTS_DEVELOPMENT_CAP_MICROS=<integer>
ADEENA_TTS_AZURE_VOICE_PROFILES={"educator-warm-1":{"voiceName":"<ShortName>","locale":"en-US","styleMap":{"calm":"<Azure style>","warm":"<Azure style>","energetic":"<Azure style>"}}}
```

The configured voice, locale, and mapped style must appear in the live voice catalog returned by the configured region. Adeena constructs and XML-escapes its own bounded SSML; callers cannot submit SSML or provider URLs. The reserved character count includes a conservative allowance for Adeena's fixed SSML wrapper because Azure documents SSML markup as billable. Azure REST does not return invoice usage, so the ledger keeps the verified schedule estimate and leaves actual cost null; fake operations reconcile to zero.

In development, an authenticated same-origin `POST /api/dev/narration` accepts:

```json
{
  "workspaceId": "uuid",
  "request": {
    "experienceVersionId": "uuid",
    "narrationSegmentId": "segment-id",
    "text": "Approved spoken text.",
    "caption": "Approved spoken text.",
    "cueIds": ["visual-cue-id"],
    "locale": "en-US",
    "voiceProfileId": "educator-warm-1",
    "style": "warm",
    "rate": 1,
    "idempotencyKey": "uuid",
    "approved": true
  }
}
```

The endpoint returns only an opaque Creator asset URL and playback metadata. It is absent in production. Generated audio remains private, and learner playback never invokes the provider.

Cache keys include normalized approved text, normalization version, locale, provider, model, voice profile, rate, style, and output format. Keys are scoped by workspace in PostgreSQL. A durable claim prevents concurrent identical jobs from issuing duplicate provider calls. An expired lease after provider submission becomes an uncertain-charge failure and is not automatically retried. Cache hits create the requested version-and-segment asset record from verified private bytes and record zero synthesis cost.

Azure REST does not provide word timing in this integration. The measured MP3 duration drives the existing audio clock and the approved caption covers the complete segment. No word-level timing is claimed.

References checked for this implementation:

- [Azure Text to speech REST API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech)
- [Azure text to speech billing units](https://learn.microsoft.com/en-us/azure/ai-services/Speech-Service/text-to-speech)
