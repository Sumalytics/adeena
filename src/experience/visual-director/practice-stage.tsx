"use client";

import { useMemo, useReducer } from "react";
import type { VisualScene } from "./schema";
import { buildPracticeChallenge, createPracticeState, reducePractice, type PracticeState } from "./practice";
import styles from "./visual-director.module.css";

export function PracticeStage({ scene, reducedMotion, onWatchAgain }: { scene: VisualScene; reducedMotion: boolean; onWatchAgain: () => void }) {
  const challenge = useMemo(() => buildPracticeChallenge(scene), [scene]);
  if (!challenge) return <section className={styles.unsupported} role="status"><strong>This practice mechanic is not available yet.</strong></section>;
  return <PracticeSession key={challenge.id} challenge={challenge} reducedMotion={reducedMotion} onWatchAgain={onWatchAgain} />;
}

function PracticeSession({ challenge, reducedMotion, onWatchAgain }: { challenge: NonNullable<ReturnType<typeof buildPracticeChallenge>>; reducedMotion: boolean; onWatchAgain: () => void }) {
  const [state, dispatch] = useReducer(reducePractice, challenge, createPracticeState);
  if (state.phase === "complete") {
    return (
      <section className={styles.practiceComplete} data-reduced-motion={reducedMotion ? "true" : "false"}>
        <span aria-hidden="true">✓</span><h3>Challenge complete</h3>
        <p>The submitted response matched the validated answer for this authored challenge.</p>
        <button type="button" onClick={onWatchAgain}>Watch explanation again</button>
      </section>
    );
  }
  return (
    <section className={styles.practice} aria-labelledby={`${challenge.id}-heading`} data-kind={challenge.kind} data-reduced-motion={reducedMotion ? "true" : "false"}>
      <header className={styles.practiceHeader}>
        <div><p>Try it · Attempt {state.attempt}</p><h3 id={`${challenge.id}-heading`}>{challenge.prompt}</h3></div>
        <button type="button" className={styles.resetChallenge} onClick={() => dispatch({ type: "reset" })}>Restart challenge</button>
      </header>
      {challenge.kind === "sequence-ordering" ? <SequenceBoard state={state} dispatch={dispatch} /> : <RegionBoard state={state} dispatch={dispatch} />}
      {state.phase === "feedback" && state.latestSubmission ? (
        <div className={styles.practiceFeedback} data-result={state.latestSubmission.correct ? "correct" : "incorrect"} role="status" aria-live="polite">
          <strong>{state.latestSubmission.correct ? "That works." : "Not yet."}</strong>
          <p>{state.latestSubmission.correct ? challenge.feedback.correct : challenge.feedback.incorrect}</p>
          {state.latestSubmission.correct ? <button type="button" onClick={() => dispatch({ type: "continue" })}>Continue</button> : <button type="button" onClick={() => dispatch({ type: "retry" })}>Retry</button>}
        </div>
      ) : (
        <button type="button" className={styles.submitPractice} onClick={() => dispatch({ type: "submit" })}>Check answer</button>
      )}
    </section>
  );
}

function SequenceBoard({ state, dispatch }: { state: PracticeState; dispatch: (action: Parameters<typeof reducePractice>[1]) => void }) {
  if (state.challenge.kind !== "sequence-ordering") return null;
  const labels = new Map(state.challenge.items.map((item) => [item.id, item.label]));
  const locked = state.phase !== "answering";
  return (
    <ol className={styles.sequenceBoard} data-result={state.latestSubmission?.correct ? "correct" : state.latestSubmission ? "incorrect" : "pending"} aria-label="Current sequence">
      {state.order.map((id, index) => (
        <li key={id} className={styles.sequenceItem} tabIndex={locked ? -1 : 0} onKeyDown={(event) => {
          if (locked || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          dispatch({ type: "move-sequence", itemId: id, direction: event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1 });
        }}>
          <span className={styles.sequenceNumber}>{index + 1}</span><strong>{labels.get(id)}</strong>
          <span className={styles.sequenceActions}>
            <button type="button" disabled={locked || index === 0} aria-label={`Move ${labels.get(id)} earlier`} onClick={() => dispatch({ type: "move-sequence", itemId: id, direction: -1 })}>←</button>
            <button type="button" disabled={locked || index === state.order.length - 1} aria-label={`Move ${labels.get(id)} later`} onClick={() => dispatch({ type: "move-sequence", itemId: id, direction: 1 })}>→</button>
          </span>
        </li>
      ))}
    </ol>
  );
}

function RegionBoard({ state, dispatch }: { state: PracticeState; dispatch: (action: Parameters<typeof reducePractice>[1]) => void }) {
  if (state.challenge.kind !== "region-classification") return null;
  const challenge = state.challenge;
  const locked = state.phase !== "answering";
  return (
    <div className={styles.regionPractice}>
      <div className={styles.valueTray} aria-label="Values to place">
        {challenge.items.map((item) => {
          const placement = state.placements[item.id];
          const itemResult = state.latestSubmission ? challenge.expectedRegionByItemId[item.id] === placement ? "correct" : "incorrect" : "pending";
          return <button key={item.id} type="button" disabled={locked} aria-pressed={state.selectedItemId === item.id} data-result={itemResult} onClick={() => dispatch({ type: "select-item", itemId: item.id })}><strong>{item.label}</strong><span>{placement ? challenge.regions.find((region) => region.id === placement)?.label : "Select, then choose a region"}</span></button>;
        })}
      </div>
      <div className={styles.regionBoard} aria-label="Classification regions">
        {challenge.regions.map((region) => (
          <button key={region.id} type="button" disabled={locked || !state.selectedItemId} className={styles.regionTarget} onClick={() => dispatch({ type: "place-item", regionId: region.id })}>
            <strong>{region.label}</strong>
            <span>{challenge.items.filter((item) => state.placements[item.id] === region.id).map((item) => item.label).join(", ") || "Place a selected value here"}</span>
          </button>
        ))}
      </div>
      <p className={styles.practiceHint}>Choose a value, then choose its region. Every action works with touch or keyboard; dragging is not required.</p>
    </div>
  );
}

