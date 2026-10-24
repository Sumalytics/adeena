import { describe, expect, it, vi } from "vitest";
import { authoredHistoryFixture, authoredProcessFixture, authoredTwoSetFixture } from "./fixtures";
import { buildPracticeChallenge, createPracticeState, reducePractice, type PracticeState } from "./practice";

function sequenceState() {
  const challenge = buildPracticeChallenge(authoredProcessFixture.scenes[0]);
  if (!challenge || challenge.kind !== "sequence-ordering") throw new Error("Expected sequence challenge");
  return createPracticeState(challenge);
}

function regionState() {
  const challenge = buildPracticeChallenge(authoredTwoSetFixture.scenes[0]);
  if (!challenge || challenge.kind !== "region-classification") throw new Error("Expected region challenge");
  return createPracticeState(challenge);
}

function place(state: PracticeState, itemId: string, regionId: string) {
  return reducePractice(reducePractice(state, { type: "select-item", itemId }), { type: "place-item", regionId });
}

describe("Visual Director practice engine", () => {
  it("accepts the declared sequence and records minimal ephemeral evidence", () => {
    let state = sequenceState();
    for (let index = 0; index < 3; index += 1) state = reducePractice(state, { type: "move-sequence", itemId: "entry", direction: -1 });
    state = reducePractice(state, { type: "submit" });
    expect(state.latestSubmission).toMatchObject({ contract: "ADEENA-PRACTICE-EVENT-v1", challengeId: "order-airway", challengeVersion: "1", correct: true, attempt: 1, feedbackId: "correct" });
    expect(state.latestSubmission).not.toHaveProperty("learnerId");
    expect(state.latestSubmission).not.toHaveProperty("timestamp");
  });

  it("rejects an incorrect sequence with authored feedback and supports deterministic retry", () => {
    let state = reducePractice(sequenceState(), { type: "submit" });
    expect(state.latestSubmission?.correct).toBe(false);
    expect(state.challenge.feedback.incorrect).toBe("Try again using the order shown in the explanation.");
    const duplicate = reducePractice(state, { type: "submit" });
    expect(duplicate.submissions).toHaveLength(1);
    state = reducePractice(state, { type: "retry" });
    expect(state).toMatchObject({ phase: "answering", attempt: 2, latestSubmission: null });
    expect(state.order).toEqual(sequenceState().order);
  });

  it("accepts correct region placements derived from validated cardinalities", () => {
    let state = regionState();
    const challenge = state.challenge;
    if (challenge.kind !== "region-classification") throw new Error("Expected region challenge");
    for (const item of challenge.items) state = place(state, item.id, challenge.expectedRegionByItemId[item.id]);
    state = reducePractice(state, { type: "submit" });
    expect(state.latestSubmission?.correct).toBe(true);
    expect(challenge.items.map((item) => Number(item.label))).toEqual([12, 6, 8, 4]);
  });

  it("rejects incorrect region placement without revealing the expected target", () => {
    let state = regionState();
    const challenge = state.challenge;
    if (challenge.kind !== "region-classification") throw new Error("Expected region challenge");
    state = place(state, "derived-overlap", "outside");
    state = reducePractice(state, { type: "submit" });
    expect(state.latestSubmission?.correct).toBe(false);
    expect(challenge.feedback.incorrect).toContain("without double-counting");
    expect(challenge.feedback.incorrect).not.toContain("Both sets");
  });

  it("builds the unrelated history sequence through the same generic mechanic", () => {
    const challenge = buildPracticeChallenge(authoredHistoryFixture.scenes[0]);
    expect(challenge).toMatchObject({ kind: "sequence-ordering", correctOrder: ["event-one", "event-two", "event-three"] });
    expect(JSON.stringify(challenge)).not.toMatch(/lung|bronch|intersection/i);
  });

  it("completes only a correct evaluation and reset clears practice state", () => {
    let state = sequenceState();
    expect(reducePractice(state, { type: "continue" }).phase).toBe("answering");
    for (let index = 0; index < 3; index += 1) state = reducePractice(state, { type: "move-sequence", itemId: "entry", direction: -1 });
    state = reducePractice(state, { type: "submit" });
    state = reducePractice(state, { type: "continue" });
    expect(state.phase).toBe("complete");
    expect(reducePractice(state, { type: "reset" })).toMatchObject({ phase: "answering", attempt: 1, submissions: [] });
  });

  it("makes no model or network request while evaluating practice", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    reducePractice(sequenceState(), { type: "submit" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

