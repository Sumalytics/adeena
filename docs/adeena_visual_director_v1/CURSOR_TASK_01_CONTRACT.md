# Cursor / Codex Task 01 — Visual Director v1 contract and validators

**Working tree:** `C:\dev\adeena`  
**Expected upstream review SHA:** `cd19a1555882a57df1b97f4e56d69e1e934470db`; first compare with CURRENT LOCAL HEAD and do not overwrite uncommitted changes.  
**Outcome:** Define a **subject-agnostic** safe data contract that an AI will eventually populate for narrated, topic-specific visual teaching and practice. Respiration and Venn diagrams are ONLY reference fixtures; never hardcode these subjects into the platform. **No AI integration or UI work in this task.**

## User story
As the experience generator, I need a bounded typed structure describing instructional scenes and games so that the renderer can show lungs and Venn diagrams correctly without accepting executable code or relying on an LLM during play.

## Read first
- `AI_VISUAL_DIRECTOR_V1_SPEC.md` (same bundle)
- `src/experience/plan.ts`, `compile.ts`, `model-plan.ts`
- `packages/experience-schema/src/manifest.ts`, `index.ts`, `validate.ts`, `limits.ts`
- `src/player/types.ts`, `present.ts`, `renderer.tsx`
- `src/releases/manifest.ts`
- Existing Vitest test conventions and package scripts.

## Small implementation scope
1. Add `src/experience/visual-director/schema.ts` with a **general-purpose** typed scene/visual-object/cue/narration/practice contract, static caps, validated actions, and a versioned archetype registry. Render support may initially be implemented for `process-pathway` and `venn-two-set`, but the generic contract and interfaces MUST NOT mention or assume biology/maths subject names. Represent unsupported archetypes as *not implemented*, not silently accepted.
2. Implement pure `validateVisualBlueprint(input, context)` checks: distinct ids, bounded labels/narration/timelines, duration limits, valid object targets, existing scene/choice ids, narration triggers, source span grounding, no URL/executable text, no out-of-bounds coordinates. Ensure Venn cardinalities obey `|A∪B|=|A|+|B|-|A∩B|` and `0 ≤ intersection ≤ min(|A|,|B|)` where numerical data is present.
3. Keep source-document/workspace provenance private and **not** part of guest-facing metadata. Do not change current persisted manifest or data model yet; produce a validated adapter/interface seam for Task 02.
4. Add two plainly labelled authored JSON/TS fixtures using the provided `DEMO_SOURCE_RESPIRATION.md` and `DEMO_SOURCE_TWO_SETS.md` as trusted test inputs. Do not mislabel authored fixtures as AI-generated.
5. Add thorough unit tests: valid respiratory plan, valid two-set plan, a third unrelated-topic contract extension smoke test, unknown cue, missing referenced object/choice/segment, duplicate IDs, excessive lengths/durations, invalid Venn calculation, malicious script/locator, no source provenance, and age-band/locale constraints.
6. Define future AUDIO/NARRATION data seams (segment ID, source-grounded script, locale, voice-style enum, cue linkage, server-owned audio metadata), **without** calling a TTS provider or accepting model-generated audio URLs. Run formatting/lint/typecheck/Vitest. Explain any case where current repo types make the proposed seam incompatible, with the smallest recommended next change.

## Target files (adjust if repository conventions demand)
- `src/experience/visual-director/schema.ts` (new)
- `src/experience/visual-director/schema.test.ts` (new)
- `src/experience/visual-director/fixtures.ts` (new)
- Optional re-export from `src/experience/public.ts` if consistent; do not create an API route.

## Security / privacy
No arbitrary HTML, CSS, JS, network asset locators or URLs. Enforce bounded input before rendering, not just TypeScript compile-time types. No child identity or personal data, and no direct public source references. No changes to tenant authorization and parental-control settings in this task.

## Cost / telemetry
No model, image or TTS calls. Cost delta for this task is zero inference cost. No telemetry schema changes. Document future cost meter fields but do not invent provider rates.

## Failure cases
An unsupported animation command, unknown object, invalid game answer, unsafe text or missing source grounding must fail explicitly with a structured diagnostic and leave the current experience untouched. Never silently render an unrelated generic character and call the scene supported.

## Acceptance / definition of done
- Strict Zod contract, pure validator and two authored fixtures shipped.
- One valid source-grounded process scene and one valid source-grounded Venn scene parse successfully.
- Invalid/malicious plans are reliably rejected with tests.
- Existing experience manifest and saved drafts continue to work unchanged.
- Tests, lint and typecheck pass; report build status and any errors.
- Changed files reviewed; no migration, no provider calls, no commits, pushes or deploys.

**Stop after Task 01. Return files changed, test counts, limitations and a proposed minimal Task 02 handoff.**
