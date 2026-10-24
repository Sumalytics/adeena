import type { VisualBlueprintContext, VisualLearningBlueprint } from "./schema";

const respirationSpan = "11111111-1111-4111-8111-111111111111";
const setsSpan = "22222222-2222-4222-8222-222222222222";
const historySpan = "33333333-3333-4333-8333-333333333333";
const geometry = (x: number, y: number, width = 140, height = 100) => ({ x, y, width, height });
const feedback = { correct: "That matches the supported sequence.", incorrect: "Try again using the order shown in the explanation." };

/** Authored acceptance fixture based on DEMO_SOURCE_RESPIRATION.md; not model output. */
export const authoredProcessFixture: VisualLearningBlueprint = {
  contract: "ADEENA-VISUAL-LEARNING-v1", locale: "en-GH", ageBand: "11-13", styleId: "friendly-illustrated-2d-v1",
  voice: { locale: "en-GH", voiceProfileId: "educator-warm-1", style: "warm", rate: 0.95 },
  scenes: [{
    id: "air-path", phase: "demonstrate", archetype: "process-pathway@1", durationMs: 18_000, sourceSpanIds: [respirationSpan],
    visualObjects: [
      { id: "entry", kind: "node", nodeType: "location", label: "Nose or mouth", role: "path", geometry: geometry(80, 220) },
      { id: "tube", kind: "node", nodeType: "step", label: "Trachea", role: "path", geometry: geometry(300, 220) },
      { id: "branch", kind: "node", nodeType: "step", label: "Bronchi", role: "path", geometry: geometry(520, 220) },
      { id: "air-sacs", kind: "node", nodeType: "location", label: "Alveoli", role: "answer-target", geometry: geometry(750, 220) },
      { id: "path-one", kind: "edge", fromId: "entry", toId: "tube", directed: true, label: "First path", role: "path", geometry: geometry(210, 250, 100, 20) },
      { id: "path-two", kind: "edge", fromId: "tube", toId: "branch", directed: true, label: "Second path", role: "path", geometry: geometry(430, 250, 100, 20) },
      { id: "path-three", kind: "edge", fromId: "branch", toId: "air-sacs", directed: true, label: "Third path", role: "path", geometry: geometry(660, 250, 100, 20) },
    ],
    cues: [
      { id: "show-entry", targetId: "entry", trigger: { kind: "narration-segment", segmentId: "air-start", offsetMs: 0 }, action: { kind: "reveal" }, durationMs: 400 },
      { id: "trace-airway", targetId: "path-two", trigger: { kind: "narration-segment", segmentId: "air-route", offsetMs: 200 }, action: { kind: "highlight" }, durationMs: 900 },
      { id: "show-exchange", targetId: "air-sacs", trigger: { kind: "narration-segment", segmentId: "gas-exchange", offsetMs: 100 }, action: { kind: "emphasize" }, durationMs: 800 },
      { id: "confirm-order", targetId: "path-three", trigger: { kind: "choice-applied", choiceId: "airway-order-correct" }, action: { kind: "change-state", state: "correct" }, durationMs: 300 },
    ],
    narration: [
      { id: "air-start", text: "Breathing moves air into and out of the lungs.", caption: "Breathing moves air into and out of the lungs.", startMs: 0, durationMs: 4_000, cueIds: ["show-entry"], sourceSpanIds: [respirationSpan] },
      { id: "air-route", text: "Air travels through the trachea, bronchi and smaller bronchioles.", caption: "Air travels through the trachea, bronchi and smaller bronchioles.", onScreenText: "Air follows the branching airways.", startMs: 4_000, durationMs: 6_000, cueIds: ["trace-airway"], sourceSpanIds: [respirationSpan] },
      { id: "gas-exchange", text: "Near the alveoli, oxygen enters nearby blood and carbon dioxide moves into the alveoli to be exhaled.", caption: "Near the alveoli, oxygen enters nearby blood and carbon dioxide moves into the alveoli to be exhaled.", onScreenText: "Gas exchange happens beside the alveoli.", startMs: 10_000, durationMs: 8_000, cueIds: ["show-exchange"], sourceSpanIds: [respirationSpan] },
    ],
    interaction: { id: "order-airway", kind: "sequence-steps", prompt: "Put the airway locations in order.", itemIds: ["entry", "tube", "branch", "air-sacs"], correctOrder: ["entry", "tube", "branch", "air-sacs"], feedback, sourceSpanIds: [respirationSpan] },
  }],
};

/** Authored acceptance fixture based on DEMO_SOURCE_TWO_SETS.md; not model output. */
export const authoredTwoSetFixture: VisualLearningBlueprint = {
  contract: "ADEENA-VISUAL-LEARNING-v1", locale: "en", ageBand: "11-13", styleId: "friendly-illustrated-2d-v1",
  voice: { locale: "en", voiceProfileId: "educator-neutral-1", style: "calm", rate: 1 },
  scenes: [{
    id: "set-counts", phase: "practice", archetype: "venn-two-set@1", durationMs: 15_000, sourceSpanIds: [setsSpan],
    visualObjects: [
      { id: "a-only", kind: "region", regionType: "inside", label: "First set only", role: "answer-target", geometry: geometry(140, 250, 280, 360) },
      { id: "both", kind: "region", regionType: "overlap", label: "Both sets", role: "answer-target", geometry: geometry(390, 250, 220, 360) },
      { id: "b-only", kind: "region", regionType: "inside", label: "Second set only", role: "answer-target", geometry: geometry(580, 250, 280, 360) },
      { id: "outside", kind: "region", regionType: "outside", label: "Neither set", role: "answer-target", geometry: geometry(40, 700, 920, 180) },
      { id: "overlap-count", kind: "quantity", value: 6, unit: "learners", label: "Intersection count", role: "example", geometry: geometry(430, 390) },
    ],
    cues: [
      { id: "reveal-regions", targetId: "both", trigger: { kind: "narration-segment", segmentId: "define-overlap", offsetMs: 0 }, action: { kind: "reveal" }, durationMs: 500 },
      { id: "place-overlap", targetId: "overlap-count", trigger: { kind: "narration-segment", segmentId: "count-union", offsetMs: 0 }, action: { kind: "move", to: { x: 500, y: 440 } }, durationMs: 700 },
    ],
    narration: [
      { id: "define-overlap", text: "The overlap contains elements that belong to both sets.", caption: "The overlap contains elements that belong to both sets.", onScreenText: "The intersection belongs to both sets.", startMs: 0, durationMs: 6_000, cueIds: ["reveal-regions"], sourceSpanIds: [setsSpan] },
      { id: "count-union", text: "Add both set counts, then subtract the intersection once to avoid double-counting it.", caption: "Add both set counts, then subtract the intersection once to avoid double-counting it.", onScreenText: "Union equals A plus B minus the intersection.", startMs: 6_000, durationMs: 9_000, cueIds: ["place-overlap"], sourceSpanIds: [setsSpan] },
    ],
    interaction: { id: "calculate-union", kind: "calculate", prompt: "Calculate the union and the number in neither set.", answerSpec: { operation: "two-set-cardinality", setACount: 18, setBCount: 14, intersectionCount: 6, unionCount: 26, totalCount: 30, neitherCount: 4 }, feedback, sourceSpanIds: [setsSpan] },
  }],
};

/** Authored unrelated-domain smoke fixture; verifies the grammar is not subject-bound. */
export const authoredHistoryFixture: VisualLearningBlueprint = {
  contract: "ADEENA-VISUAL-LEARNING-v1", locale: "en", ageBand: "14-18", styleId: "friendly-illustrated-2d-v1",
  voice: { locale: "en", voiceProfileId: "educator-neutral-1", style: "calm", rate: 1 },
  scenes: [{
    id: "event-order", phase: "teach", archetype: "timeline-sequence@1", durationMs: 12_000, sourceSpanIds: [historySpan],
    visualObjects: [
      { id: "event-one", kind: "node", nodeType: "step", label: "Proposal", role: "subject", geometry: geometry(100, 400) },
      { id: "event-two", kind: "node", nodeType: "step", label: "Debate", role: "subject", geometry: geometry(430, 400) },
      { id: "event-three", kind: "node", nodeType: "step", label: "Decision", role: "subject", geometry: geometry(760, 400) },
    ],
    cues: [
      { id: "show-proposal", targetId: "event-one", trigger: { kind: "narration-segment", segmentId: "history-sequence", offsetMs: 0 }, action: { kind: "reveal" }, durationMs: 300 },
    ],
    narration: [{ id: "history-sequence", text: "The source places the proposal before the debate and the final decision.", caption: "The source places the proposal before the debate and the final decision.", onScreenText: "Proposal, debate, then decision.", startMs: 0, durationMs: 7_000, cueIds: ["show-proposal"], sourceSpanIds: [historySpan] }],
    interaction: { id: "order-events", kind: "sequence-steps", prompt: "Place the events in source order.", itemIds: ["event-one", "event-two", "event-three"], correctOrder: ["event-one", "event-two", "event-three"], feedback, sourceSpanIds: [historySpan] },
  }],
};

export const authoredFixtureContexts: Record<"process" | "sets" | "history", VisualBlueprintContext> = {
  process: { sceneIds: ["air-path"], choiceIdsByScene: { "air-path": ["airway-order-correct"] }, sourceSpanIds: [respirationSpan], ageBand: "11-13", locale: "en-GH" },
  sets: { sceneIds: ["set-counts"], choiceIdsByScene: { "set-counts": [] }, sourceSpanIds: [setsSpan], ageBand: "11-13", locale: "en" },
  history: { sceneIds: ["event-order"], choiceIdsByScene: { "event-order": [] }, sourceSpanIds: [historySpan], ageBand: "14-18", locale: "en" },
};
