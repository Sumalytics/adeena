# ADEENA — Codex Task 04: Narrated instructional animations (future task; do not execute before Tasks 01–03)

## Outcome
A general-purpose learning scene speaks accurate, age-appropriate narration synchronized with meaningful visual cues, while captions and game interactions work without sound. No browser-time AI/TTS calls. No biology/maths-specific voice logic.

## Dependencies
Task 01 blueprint validators, Task 02 shared scene renderer, Task 03 practice mechanics must be verified. Inspect current HEAD, source/tenant storage, queue worker, media safety, release manifest, provider and cost ledger before coding.

## Interfaces and behavior
- NarrationDirector produces source-grounded short script segments `{id, text, caption, locale, cueIds}` tied to semantic steps. Each segment has bounded size; validate against source evidence and selected age profile.
- TTS provider interface accepts server-approved voiceProfileId, locale, rate, style and sanitized text; returns bytes, MIME, duration and optionally timing marks. Reject external URLs or SSML supplied by model. Do not hardcode a vendor; implement and test one provider adapter behind this interface, with a fake adapter for tests.
- Produce audio during generation, after successful content validation, in an idempotent queue job. Write object-storage assets under tenant/version; record hash, source version, provider model, settings, length, duration, character usage, actual/estimated cost and retries. Reuse cache on identical text+voice+model+settings; edits to one segment only regenerate its audio.
- Authoritative playback clock is the media element; drive scene cues/captions from currentTime/timepoints and the current scene state, not approximate independent timeouts. Pause/seek/replay/restart all synchronize visuals. Hold sound when choices appear; avoid overlapping feedback and narration.
- User controls: play/pause, mute, volume, speed, replay narration, captions. Start sound only after user gesture. Reduced-motion and no-audio fallback remain educationally complete.
- Add optional short sound effects via allowlisted bundled assets; narration prioritized in audio mix. No arbitrary external audio, no uploading/voice cloning of minors.
- Preview and public guest release share the same behavior; public media projection strips private provenance and uses only allowlisted assets. Recheck authorization when accessing nonpublic assets. Public release revocation prevents future access but cannot recall previously downloaded media.
- Test unsupported locales, TTS outage (captions-only fallback clearly stated), incorrect timing, seek/replay, stale cache, cost caps, concurrent jobs, audience/locale switching, mobile first-play, captions, a11y, privacy and tenant isolation.

## MVP acceptance
1. A newly generated, source-grounded scene narrates at least 3 bounded explanation segments with captions; visual changes match spoken information.
2. Narration pauses during a learner challenge; incorrect/correct feedback uses the appropriate script and visual consequence.
3. No network TTS/LLM calls while a learner plays. Guest player and private preview behave equivalently.
4. Repeated generation of an unchanged segment is a cache hit; per-experience audio cost ledger is verified.
5. Tests/lint/typecheck/build and browser QA on 360px Android viewport pass.

## Safety boundary
No migrations to persistent developer DB, commits, pushes or deployments without founder approval. Use isolated tests. Never claim arbitrary-content/any-language support without audited coverage.
