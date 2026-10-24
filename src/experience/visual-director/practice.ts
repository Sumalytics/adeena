import type { VisualScene } from "./schema";

export type PracticeFeedback = { correct: string; incorrect: string };
export type PracticeItem = { id: string; label: string };
export type PracticeRegion = { id: string; label: string };
export type SequenceChallenge = {
  contract: "ADEENA-PRACTICE-v1";
  version: "1";
  kind: "sequence-ordering";
  id: string;
  prompt: string;
  items: readonly PracticeItem[];
  correctOrder: readonly string[];
  feedback: PracticeFeedback;
};
export type RegionChallenge = {
  contract: "ADEENA-PRACTICE-v1";
  version: "1";
  kind: "region-classification";
  id: string;
  prompt: string;
  items: readonly PracticeItem[];
  regions: readonly PracticeRegion[];
  expectedRegionByItemId: Readonly<Record<string, string>>;
  feedback: PracticeFeedback;
};
export type PracticeChallenge = SequenceChallenge | RegionChallenge;
export type PracticeSubmission = {
  contract: "ADEENA-PRACTICE-EVENT-v1";
  challengeId: string;
  challengeVersion: "1";
  answer: readonly string[] | Readonly<Record<string, string>>;
  correct: boolean;
  attempt: number;
  feedbackId: "correct" | "incorrect";
};
export type PracticeState = {
  challenge: PracticeChallenge;
  phase: "answering" | "feedback" | "complete";
  attempt: number;
  order: readonly string[];
  placements: Readonly<Record<string, string>>;
  selectedItemId: string | null;
  latestSubmission: PracticeSubmission | null;
  submissions: readonly PracticeSubmission[];
};
export type PracticeAction =
  | { type: "move-sequence"; itemId: string; direction: -1 | 1 }
  | { type: "select-item"; itemId: string }
  | { type: "place-item"; regionId: string }
  | { type: "submit" }
  | { type: "retry" }
  | { type: "continue" }
  | { type: "reset" };

export function buildPracticeChallenge(scene: VisualScene): PracticeChallenge | null {
  const interaction = scene.interaction;
  if (!interaction) return null;
  const objects = new Map(scene.visualObjects.map((object) => [object.id, object]));
  if (interaction.kind === "sequence-steps") {
    return {
      contract: "ADEENA-PRACTICE-v1",
      version: "1",
      kind: "sequence-ordering",
      id: interaction.id,
      prompt: interaction.prompt,
      items: interaction.itemIds.map((id) => ({ id, label: objects.get(id)?.label ?? id })),
      correctOrder: interaction.correctOrder,
      feedback: interaction.feedback,
    };
  }
  if (interaction.kind === "classify") {
    return {
      contract: "ADEENA-PRACTICE-v1",
      version: "1",
      kind: "region-classification",
      id: interaction.id,
      prompt: interaction.prompt,
      items: interaction.itemIds.map((id) => ({ id, label: objects.get(id)?.label ?? id })),
      regions: interaction.regionIds.map((id) => ({ id, label: objects.get(id)?.label ?? id })),
      expectedRegionByItemId: Object.fromEntries(interaction.placements.map((placement) => [placement.itemId, placement.regionId])),
      feedback: interaction.feedback,
    };
  }
  if (interaction.kind === "calculate" && interaction.answerSpec.operation === "two-set-cardinality") {
    return buildCardinalityRegionChallenge(scene, interaction);
  }
  return null;
}

function buildCardinalityRegionChallenge(scene: VisualScene, interaction: Extract<NonNullable<VisualScene["interaction"]>, { kind: "calculate" }>): RegionChallenge | null {
  if (interaction.answerSpec.operation !== "two-set-cardinality") return null;
  const regions = scene.visualObjects.filter((object) => object.kind === "region");
  const inside = regions.filter((object) => object.regionType === "inside");
  const overlap = regions.find((object) => object.regionType === "overlap");
  const outside = regions.find((object) => object.regionType === "outside");
  if (!inside[0] || !inside[1] || !overlap || !outside) return null;
  const answer = interaction.answerSpec;
  const neither = answer.neitherCount ?? (answer.totalCount === undefined ? undefined : answer.totalCount - answer.unionCount);
  if (neither === undefined) return null;
  const items: PracticeItem[] = [
    { id: "derived-first-only", label: String(answer.setACount - answer.intersectionCount) },
    { id: "derived-overlap", label: String(answer.intersectionCount) },
    { id: "derived-second-only", label: String(answer.setBCount - answer.intersectionCount) },
    { id: "derived-outside", label: String(neither) },
  ];
  return {
    contract: "ADEENA-PRACTICE-v1",
    version: "1",
    kind: "region-classification",
    id: interaction.id,
    prompt: interaction.prompt,
    items,
    regions: [inside[0], overlap, inside[1], outside].map((region) => ({ id: region.id, label: region.label })),
    expectedRegionByItemId: {
      "derived-first-only": inside[0].id,
      "derived-overlap": overlap.id,
      "derived-second-only": inside[1].id,
      "derived-outside": outside.id,
    },
    feedback: interaction.feedback,
  };
}

export function createPracticeState(challenge: PracticeChallenge): PracticeState {
  return {
    challenge,
    phase: "answering",
    attempt: 1,
    order: challenge.kind === "sequence-ordering" ? deterministicStartingOrder(challenge.items.map((item) => item.id)) : [],
    placements: {},
    selectedItemId: challenge.kind === "region-classification" ? challenge.items[0]?.id ?? null : null,
    latestSubmission: null,
    submissions: [],
  };
}

export function reducePractice(state: PracticeState, action: PracticeAction): PracticeState {
  if (action.type === "reset") return createPracticeState(state.challenge);
  if (action.type === "continue") return state.phase === "feedback" && state.latestSubmission?.correct ? { ...state, phase: "complete" } : state;
  if (action.type === "retry") {
    if (state.phase !== "feedback" || state.latestSubmission?.correct) return state;
    const reset = createPracticeState(state.challenge);
    return { ...reset, attempt: state.attempt + 1, submissions: state.submissions };
  }
  if (state.phase !== "answering") return state;
  if (action.type === "move-sequence" && state.challenge.kind === "sequence-ordering") {
    const index = state.order.indexOf(action.itemId);
    const destination = index + action.direction;
    if (index < 0 || destination < 0 || destination >= state.order.length) return state;
    const order = [...state.order];
    [order[index], order[destination]] = [order[destination], order[index]];
    return { ...state, order };
  }
  if (action.type === "select-item" && state.challenge.kind === "region-classification") {
    return state.challenge.items.some((item) => item.id === action.itemId) ? { ...state, selectedItemId: action.itemId } : state;
  }
  if (action.type === "place-item" && state.challenge.kind === "region-classification") {
    if (!state.selectedItemId || !state.challenge.regions.some((region) => region.id === action.regionId)) return state;
    const currentIndex = state.challenge.items.findIndex((item) => item.id === state.selectedItemId);
    const next = state.challenge.items[(currentIndex + 1) % state.challenge.items.length]?.id ?? null;
    return { ...state, placements: { ...state.placements, [state.selectedItemId]: action.regionId }, selectedItemId: next };
  }
  if (action.type === "submit") {
    const correct = evaluatePractice(state);
    const submission: PracticeSubmission = {
      contract: "ADEENA-PRACTICE-EVENT-v1",
      challengeId: state.challenge.id,
      challengeVersion: state.challenge.version,
      answer: state.challenge.kind === "sequence-ordering" ? [...state.order] : { ...state.placements },
      correct,
      attempt: state.attempt,
      feedbackId: correct ? "correct" : "incorrect",
    };
    return { ...state, phase: "feedback", latestSubmission: submission, submissions: [...state.submissions, submission] };
  }
  return state;
}

export function evaluatePractice(state: PracticeState) {
  if (state.challenge.kind === "sequence-ordering") {
    const challenge = state.challenge;
    return state.order.length === challenge.correctOrder.length && state.order.every((id, index) => id === challenge.correctOrder[index]);
  }
  const challenge = state.challenge;
  return challenge.items.every((item) => state.placements[item.id] === challenge.expectedRegionByItemId[item.id]);
}

function deterministicStartingOrder(ids: readonly string[]) {
  if (ids.length < 2) return [...ids];
  return [...ids.slice(1), ids[0]];
}

