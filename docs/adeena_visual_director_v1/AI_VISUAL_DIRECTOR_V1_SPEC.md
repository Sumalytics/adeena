# ADEENA — AI Visual Director v1
**Status:** Proposed engineering milestone; founder-approved direction in conversation, not an implementation claim.  
**Repo reviewed:** `Sumalytics/adeena`, `cd19a1555882a57df1b97f4e56d69e1e934470db` (2026-10-23).  
**Owner:** Founder/product; implementation via Cursor/Codex; Learning Science, Creative/Game, AI/ML, CTO, Trust/Legal, QA to review.

## 1. Outcome / user story
A creator uploads ordinary permitted learning material, chooses the learner audience, and selects Generate. Adeena **decides** how to explain the source, creates a narrated and visually animated teaching sequence, then generates interactive practice that checks application of the specific concept. Creator reviews a playable draft, optionally improves it, and shares it with a guest link. No prompt engineering, animation timeline, or extra post-generation rights/content attestation for ordinary authorized MVP material.

**MVP acceptance fixtures:** (a) respiratory system, with visual airflow and gas exchange, followed by label/pathway exercise; (b) two-set mathematics, with stepwise Venn diagram, then placement and arithmetic practice. One engine; different visual grammar.

## 2. Confirmed repository facts (not hypotheses)
- `src/experience/plan.ts` defines a branching-dialogue `EXPERIENCE-PLAN-v1` and `visualTreatment: 'existing-fallback-scene'`.
- `src/experience/compile.ts` maps scenes to the same `synthetic:source-note` asset; the deterministic fixture is a source-note practice.
- `src/app/creator/preview/experience-preview.tsx` and `src/app/play/r/[releaseId]/release-player.tsx` both use `cssRenderer`.
- `src/player/renderer.tsx` now has a generic illustrated CSS scene; it is not topic-grounded instructional animation.
- The specialized Phaser resource room hardcodes particular scene IDs, props and reactions; do not use it as the universal visualization strategy.
- `src/db/migrations/0014_simplified_share.up.sql` adds an upload/reuse permission declaration and an MVP share path; `0015_generation_excerpts.up.sql` adds longer bounded source context. Do not redo these migrations without evidence.
- Current runtime manifest schema is strict; introducing an optional visual extension requires schema, compiler, validation and public-release projection compatibility tests.

## 3. Decisions and trade-offs
**Recommended**: AI plans within a small, approved instructional-animation vocabulary. A deterministic, versioned runtime animates the resulting data. Audio is synthesized **after** source/plan validation, cached by content hash. Visual teaching scenes and practice scenes share a compiled playback sequence. An exportable narrated MP4 is a later renderer/export milestone, not a substitute for the web game.

**Rejected for v1**: freeform AI-authored JavaScript; a generic dancing character as the lesson; mandatory video generation for every scene; a separate engine per subject; replacing the secure player-core with LLM calls during play; promising all uploaded content will produce safe/accurate animation regardless of support.

**UNIVERSAL DESIGN RULE (founder clarification):** Respiratory systems and two-set mathematics are **acceptance examples only**, never product-domain constraints. Build a domain-agnostic visual grammar: typed drawable elements (text/label, image/illustration, shape, icon, node, edge/arrow, grouping/region, chart/quantity, character), actions (reveal, hide, highlight, move, connect, disconnect, transform, compare, emphasize), scene timelines and semantic roles. Implement a registry of approved scene archetypes that composes these primitives; initial fully rendered demonstrations may focus on `process-pathway` and `venn-two-set`, but **nothing in the generic contract, planner, job model, API, audio or player should hardcode biology/math topic terms**. Test a third unrelated topic (e.g. history or business process) as a contract/extension smoke test. Unsupported renderers should fail clearly, not silently pretend to support arbitrary topics.

**General practice framework:** register schema-validated mechanics (`label-visual`, `sequence-steps`, `classify`, `sort`, `match`, `calculate`, `scenario-decision`) with typed answer specifications and deterministic validators. Implement only the mechanics needed by the two initial demonstrations in v1, but do not bake biology/maths terms into the mechanic interfaces. Correctness is evaluated by deterministic validators; never mark mastery based on clicks.

## 4. AI Visual Director pipeline
1. **Understand**: extract canonical source text and bounded evidence spans; identify topic, concepts, age band and uncertainties. Fail usefully for unreadable or insufficient material.
2. **Pedagogical blueprint**: objective(s), prerequisites, misconceptions, teach/show/try/feedback/recap sequence; mark source assertions and pedagogical decisions distinctly.
3. **Visual direction**: choose from registered scene archetypes based on *what needs to be learned*; fill typed visual objects, timelines, visual state transitions and cues. Selection must be AI-generated in live mode and labeled fixture/manual when testing.
4. **Narration direction**: write age-appropriate, source-grounded segments, explicit locale and subtitles; align segments with visual cues. Avoid inferred dialect/voice characteristics.
5. **Practice design**: choose corresponding meaningful mechanic and source-grounded feedback; mathematically verify numerical items.
6. **Validation**: strict schema/bounds, source references, semantic consistency, visual/narration agreement, topic risk, mathematics domain checks, every valid route, prohibited URLs/scripts/assets. Do not synthesize audio on invalid plans.
7. **Compile and render**: write immutable versioned visual plan and safe media assets; private and public players render the *same* material; no LLM calls during playback.
8. **Audio / export**: generate and cache TTS with timed segments; support mute, captions and pause/replay. MP4 export from deterministic animated timeline is a subsequent milestone. Meter its costs separately.

## 5. Visual blueprint v1 (contract sketch; formal Zod implementation in Task 01)
Two-level data model: retain source-grounded `ExperiencePlanV1`, add `VisualLearningBlueprintV1` as a **versioned, schema-validated presentation contract**, attached by the compiler to immutable experience versions. No JS, CSS, HTML, remote code, or arbitrary URLs in generated output.

Suggested fields:

```
VisualLearningBlueprintV1 {
  contract: 'ADEENA-VISUAL-LEARNING-v1';
  locale: string;              // validated BCP-47 subset, e.g. en-GH
  ageBand: AgeBand;
  styleId: 'friendly-illustrated-2d-v1';
  scenes: Array<{
    id: string;                 // match a known compiled/player scene identifier
    phase: 'teach' | 'demonstrate' | 'practice' | 'feedback' | 'recap';
    archetype: string;           // validated against versioned runtime registry; only implemented archetypes accepted
    visualObjects: Array<{ id: string; kind: enum; label: string; role: enum; }>;  // bounded
    cues: Array<{
      id: string;
      trigger: 'on-enter' | 'narration-segment' | 'choice-applied';
      targetId: string;
      action: 'reveal' | 'hide' | 'highlight' | 'move' | 'connect' | 'disconnect' | 'change-state';
      from?: string; to?: string; durationMs: number;
      segmentId?: string; choiceId?: string;
    }>;
    narration: Array<{ id: string; text: string; subtitle: string; voiceStyle?: 'calm' | 'warm' | 'energetic'; }>; // no raw audio URL
    // In a later compiled media layer: voiceProfileId, audioAssetId, durationMs,
    // provider timing marks, captions, checksum. These are server-owned, never LLM-supplied URLs.
    sourceSpanIds: string[];    // private provenance; never exposed directly in guest payload
    interaction?: { kind: enum; prompt: string; answerSpec: typed-data; feedback: typed-data; };
  }>;
}
```

Task 01 must choose exact discriminated unions, caps, and permitted geometry; **never use unbounded string-to-command targets**. `targetId` must be declared in `visualObjects`; cue `choiceId` must correspond to an authorized choice; every narration-segment trigger must resolve. For Venn math, solver data must be numeric and deterministic, not text-only answers. Sequence and diagram mechanisms need keyboard/touch equivalents.

Compatibility: existing manifests must still validate and play with neutral fallback. Plan implementation carefully against the current strict schema, `publicReleaseManifest`, `parseManifest`, and editing/versioning. Do not force an undocumented migration in Task 01.

## 6. Narration and synchronization
- Scene-based **short** narration segments, each associated with a clear visual cue. Provide always-on optional subtitles/captions; captions must remain available when audio disabled/unavailable.
- TTS selected by locale/creator preference, not inferred identity. If provider does not support the language or pronunciation adequately, show an explicit fallback.
- Audio asset identity = hash(normalized narration text + locale + voice + provider/model + settings). Reuse unchanged segments on edits.
- Source scripts, sensitive prompts and private source locators must never be included in public media metadata. Public audio/media must use authorized release-safe projection and allowed asset origin; revocation prevents new access but cannot recall already downloaded bytes.
- Never claim precise word-level synchronization unless the provider returns reliable timing; start with segment-level cues.

## 7. Child-first guardrails, controls and privacy
- Use the creator-selected age profile for pacing, reading load and interaction, not an AI-inferred age.
- A parent/school can set: mute/autoplay policy, external-link restrictions, session duration option, and identity mode. **No need to identify guest children.** These are account/workspace options to scope, not automatic collection of identifiable child activity.
- Show corrections without shame; avoid manipulative streaks, dark patterns and public rankings for children.
- Topic sensitivity must be contextual: curriculum discussion of lungs is not individualized medical advice; still flag medical treatment instructions, sensitive safeguarding or personally identifiable input for heightened checks.
- Source permission is declared at upload/reuse; **no second mandatory confirmation** for ordinary eligible MVP publishing, but no rights-verification claim is invented. High-risk and explicitly blocked material remain controlled.

## 8. Cost/performance
Track separately: LLM planning/review tokens and retries; illustration generation (if explicitly enabled); TTS chars/seconds; asset storage; optional video export compute; average playback bytes. Generate/cache audio **after** plan approval, and don't regenerate unchanged scenes. Provider rates and margins must be verified in finance before tiers are locked. Measure on actual low-cost Android and throttled networks; do not call targets proven results.

## 9. Sequential handoffs / release gates
**Task 01 — Domain-agnostic schema and deterministic validators only.** Respiration and Venn demos are test fixtures, NOT embedded subject-specific product logic. Add `src/experience/visual-director/schema.ts`, test file, demo fixtures, and export surface. No provider calls, UI changes, DB changes or claim of working narration. Include strict schema, bound tests, cross-reference checks, math correctness fixtures, stage contract for future renderer.

**Task 02 — Two authored, rendered teaching scenes.** Render respiratory pathway and two-set Venn using existing React/TS player; meaningful cue animations, diagram labels, reduced motion, mobile accessibility; wire both private and guest *without a live model yet*. Rendered output must change in response to state, not just loop.

**Task 03 — Two practice mechanics.** Use deterministic answer checking: pathway ordering/labeling and Venn placement/two-set arithmetic; feedback tied to evidence, replay, no fake mastery score.

**Task 04 — Narration pipeline.** TTS worker/provider adapter with opt-in bounded spend and audio cache; segmented subtitles and reliable timing. Clear no-audio fallback. Record cost. No autoplay-on-mobile reliance.

**Task 05 — AI Visual Director selection and generation.** Model produces strict blueprint for either topic with source span support and age adaptation; independent factual/visual reviewer plus validators; clean failure/retry/no paid fallback disguised as AI.

**Task 06 — One-click Creator preview/share and export.** Confirm the already-updated simplified Creator flow; render all visual extensions privately and as guest; only then build narrated MP4 export. Export must say when only the linear path is included; games remain accessible through web link.

**Task 07 — Founder acceptance.** Two uploaded sources -> two distinct generated experiences, recorded narration and subtitles -> game -> guest link, tested on Android with source-accuracy review and per-experience cost ledger. Do not claim production-ready until demonstrated.

## 10. Acceptance criteria (release gate)
- AI chooses `process-pathway` for appropriate respiratory source and `venn-two-set` for appropriate maths source; creator is not asked to pick the template (manual override optional).
- Teach scenes visibly explain the concept. A viewer can identify what changed without reading every paragraph.
- At least two meaningful application challenges per demo; outcome and feedback reflect actual actions and correct deterministic logic.
- Spoken narration is aligned at least by segment, captions display verbatim/correctly, mute/reduced motion work.
- Private/public scene semantic parity, no ongoing model inference on play; sandboxed schema validation and tenant authorization remain intact.
- Measuring performance and cost is mandatory; thresholds are proposed separately after baseline measurement.
- UI remains progressive and mobile touch-first; failures offer actionable paths, not fake review buttons.
- Before declaring completion: tests + lint + typecheck + build + human review of both desktop and 360px/mobile playthroughs.

## 11. Handoff dependencies / owner questions
- **CEO / Founder**: lock the revised learning-animation thesis and MVP sequencing in DECISIONS.md; v1 not universal flawless output for arbitrary files.
- **Learning Science**: rubric for teaching accuracy, learner application and age adaptation, no unvalidated mastery.
- **Creative/Game Design**: archetype assets, narrative timing, animation direction, visual QA.
- **AI/ML**: strict generation and review schemas, retries, model cost ledger.
- **CTO/Security**: schema/public projection/tenant isolation/asset allowlists and migrations only by approval.
- **Trust/Legal**: source rights, child safeguards, appropriate video/speech publication.
- **QA**: mobile, weak network, accessibility, regression and factual visual checks.

**Scope discipline:** do not prematurely build 3 renderers, full video generation, LMS packaging, or creator timeline editing. Ship the first two correct, beautiful, narrated explainer + practice demonstrations.

## 12. Founder clarification: narration, voice and sound architecture

A video-like lesson needs a **separate narrative director and production pipeline**; simply adding TTS to the existing scene text is not acceptable. The AI outputs a source-grounded teaching script broken into short segments, each connected to a visual action and learner goal. On-screen copy can be shorter than the spoken script but must not contradict it. The content is reviewed/validated BEFORE any paid audio generation.

**Generation-time pipeline**: (a) grounded lesson/storyboard + locale/age profile -> (b) narration script with segment IDs and captions -> (c) source and age audit -> (d) TTS adapter worker synthesizes audio per segment -> (e) audio metadata extracted, timing cues mapped or corrected -> (f) audio stored under tenant-scoped object keys, costs and hashes recorded -> (g) approved public-release projection and safe media access. This happens once per version; playback never invokes LLM or TTS.

**Playback-time pipeline**: scene enters -> learner starts playback with a user gesture -> audio clock (`HTMLAudioElement.currentTime`) drives the scene cue timeline -> captions appear -> completed narration waits for the next teaching step or practice. Pausing, seeking or replaying must also pause/seek/replay animation. Interactive choices pause narration; no narration overlaps game feedback. Audio must be optional; subtitles and visual cues always work without it.

**TTS interface** (future Task 04; provider-agnostic): `synthesize({text, locale, voiceProfileId, style?, rate?, idempotencyKey}) -> {bytes, mimeType, durationMs, timepoints?, providerUsage, checksums}`. Never take freeform voice IDs, markup, SSML or asset URLs directly from untrusted model output. Choose approved voices and approved style settings on the server. Provider timing marks can support segment-level synchronization, but do not claim lip sync/word-level matching without accurate provider timing. Narration segments should be cached on content hash including voice+model+settings.

**Audio tracks**: narration is required for a voiced experience; optional restrained sound effects (correct/incorrect cue, object action) may be mapped to whitelisted bundled assets; background music is optional/off by default for learning clarity. User controls: voice on/off, captions, replay, speed and volume as accessible controls. Avoid automatic audio on page open; support reduced-motion and weak network.

**Voice quality**: age adaptation changes vocabulary, pace and script structure, not child identity or inferred dialect. Ghana-first locale options require actual voice and pronunciation QA; unsupported local languages should be explained, not faked. Do not request or clone child voices.

**No hidden cost promises**: separately ledger TTS characters/audio duration, storage/transfer, generation retries, media export render time, and cache hit rate.
