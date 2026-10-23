# ENG-012A — source-to-game generation

Status: implementation and automated checks complete; live playable acceptance **not achieved**. No commit, push or deployment.

## Implementation

The existing Creator Generate action now selects the configured model when authorized. The server sends the selected excerpts, topic, audience and age band. It requests structured authored fields, binds identity and source references on the server, validates and compiles the plan, simulates every route, and requests a separate semantic review. A failed call, malformed plan, unsupported quotation, broken graph or failed review creates no playable version. There is no fixture fallback. The fixture remains an explicitly selected test/development provider.

`ExperiencePlanV1` already supports authored scenes and branching choices. Its only contract change is accepting the versioned prompt marker `source-plan@1` alongside `fixture-plan@1`. Compiler version and gameplay mechanics remain unchanged. Existing manifest validation, simulation, private preview, player and generation jobs are reused. Playback makes no model calls.

Generation reserves both calls before contacting the provider. It reuses existing free-development gates, paid authorization, price schedules and shared budget/quota tables. Paid execution still requires explicit development spending authorization; the existing per-operation `ADEENA_AI_MAX_EDIT_COST_USD` ceiling applies to the complete generation. Planning is bounded to 8,000 input / 3,500 output tokens; review to 16,000 / 1,000. Paid requests additionally use a conservative UTF-8 byte bound including schema and framing. There are no automatic generation retries. An expired lease with a durable call reservation fails closed rather than repeating model calls. Normal completion releases undispatched review reservations; uncertain failures retain reservations.

Migration 0013 extends the existing generation usage record with execution mode, cached/reasoning tokens, commercial comparison cost and per-stage audit data. Proposed plans and semantic reviews remain private under workspace RLS. No release backend or new provider infrastructure was added.

## Verification — 2026-10-22

- Fresh disposable PostgreSQL database: `adeena_share_demo_1792692586402`, migrations 0001–0013 applied from scratch. Tests also create their own disposable databases.
- Full suite: **41 files, 249 tests passed**. Includes model transport/validation, durable accounting, no-call idempotent replay, semantic rejection, quota exhaustion and release of unused reservations.
- Lint, typecheck and production build: **passed**. Build generated all 35 pages.
- Real Supabase Creator login, upload, source selection, audience/age selection, topic recommendation and explicit Generate action demonstrated.
- Desktop 1280px and mobile 360px failure-state screenshots: no horizontal overflow. This is not a successful gameplay demonstration.
- Read-only fingerprints: all 26 persistent developer tables unchanged; `docs/media/` unchanged.

Local evidence is in `.local/eng012/`: `checks.json`, command logs, `generation-audit.json`, `usage.json`, `screens.json`, source documents and screenshots. Credentials/session state are ignored local files and are not included in this report.

## Actual live results and weaknesses

Five configured Groq Free requests were made using `openai/gpt-oss-120b`: three planning calls and two review calls. Actual Free-plan charge: **$0**. Reported usage: **6,818 input / 4,986 output tokens**. Commercial-rate comparison: **$0.004014**, not an actual charge.

1. Rain garden, first attempt: compiler rejected a missing fictional-setting label and source quotations absent from scene text. One call; no review call. Its unused review reservation was reconciled in the disposable database with an audit file after the accounting fix.
2. Rain garden, clarified prompt: structure compiled, but independent review rejected it. The plan invented slippery paths, erosion and damage. The review incorrectly marked grounding as passed and instead miscounted decisions. This demonstrates both model factual drift and reviewer unreliability.
3. Stage signals: structure compiled, but independent review rejected it. The plan rewarded reversed signal order and claimed simultaneous curtain/music effects unsupported by the supplied excerpt. Two endings had essentially the same educational result. Choices remained obvious binary actions, with little dramatic tension.

No live attempt produced an accepted private preview. No rejected plan was promoted, manually patched into acceptance or replaced with the fixture. The existing five-request authorization is exhausted. A further live attempt requires renewed authorization.

The three source-specific authored transport specimens in `src/experience/model-plan.examples.ts` cover rain-garden routing, archive location/subject labels and rehearsal signals. Each compiles and simulates four distinct endings in tests. **These are test specimens, not three live model successes.** Rain-garden choices change runoff/overflow routes; archive choices change whether a visitor can identify shelf and subject; signal choices change which rehearsal cues are sent.

## Outstanding acceptance blockers

The ingestion worker stores only the first **280 characters per source-span excerpt**. This pathway deliberately uses those selected excerpts, not private full documents. Later rules in the uploaded examples were therefore absent from the model context. The model must stay within that evidence, but currently extrapolates beyond it. Expanding evidence selection would require a bounded read of immutable canonical source spans, with integrity and sensitivity checks; it has not been silently substituted here.

Semantic review is probabilistic and is not proof of factual accuracy. It caught enough to block these attempts, but sometimes gave incorrect reasons and missed actual faults. Human publication review remains required. A successful configured-model generation and playback in the existing preview are still outstanding, as is evidence that three generated plans meaningfully differ beyond the authored test specimens. ENG-012A is not ready to claim MVP acceptance or move on to ENG-013A.
