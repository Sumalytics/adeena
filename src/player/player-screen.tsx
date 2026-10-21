"use client";

import { useEffect, useRef } from "react";
import styles from "./player.module.css";
import type { ExperienceRenderer, PlayerMeter, PlayerView } from "./types";

function MeterList({ meters }: { meters: readonly PlayerMeter[] }) {
  if (meters.length === 0) return null;
  return (
    <ul className={styles.meterList} aria-label="Current situation">
      {meters.map((meter) => (
        <li key={meter.id}>
          {meter.label}: {meter.value}
        </li>
      ))}
    </ul>
  );
}

export function PlayerScreen({
  view,
  renderer,
  onBegin,
  onChoose,
  onReplay,
}: {
  view: PlayerView;
  renderer: ExperienceRenderer;
  onBegin: () => void;
  onChoose: (choiceId: string) => void;
  onReplay: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sceneId = view.kind === "scene" || view.kind === "ending" ? view.sceneId : "";

  useEffect(() => {
    if (!sceneId) return;
    headingRef.current?.focus();
  }, [sceneId]);

  if (view.kind === "unavailable") {
    return (
      <main id="content" className={styles.shell} data-renderer={renderer.kind}>
        <h1 className={styles.title}>{view.message}</h1>
        <p>Nothing was started, and no information was saved.</p>
      </main>
    );
  }

  if (view.kind === "cover") {
    return (
      <main id="content" className={styles.shell} lang={view.locale} data-renderer={renderer.kind}>
        <h1 className={styles.title}>{view.title}</h1>
        <p className={styles.intro}>{view.intro}</p>
        <MeterList meters={view.meters} />
        <button type="button" className={styles.begin} onClick={onBegin}>
          Begin
        </button>
      </main>
    );
  }

  const Visual = renderer.Visual;
  const showConsequence = view.chosenText !== null || view.changes.length > 0;

  return (
    <main id="content" className={styles.shell} lang={view.locale} data-renderer={renderer.kind}>
      <h1 className={styles.title}>{view.title}</h1>
      <p className={styles.progress}>{view.progress}</p>
      <section className={styles.scene} aria-labelledby="scene-heading">
        <Visual
          sceneId={view.illustration.sceneId}
          title={view.sceneTitle}
          description={view.illustration.description}
          decorative={view.illustration.decorative}
          missing={view.illustration.missing}
          choices={view.choices.map((choice) => ({ id: choice.id, text: choice.label }))}
          variables={Object.fromEntries(view.meters.map((meter) => [meter.id, meter.value]))}
          completed={view.kind === "ending"}
          revision={view.revision}
          onChoose={onChoose}
        />
        <h2 id="scene-heading" className={styles.sceneTitle} tabIndex={-1} ref={headingRef}>
          {view.sceneTitle}
        </h2>
        <p className={styles.narrative}>{view.narrative}</p>
        <MeterList meters={view.meters} />
        <div aria-live="polite" aria-atomic="true">
          {showConsequence ? (
            <div className={styles.consequence}>
              <p className={styles.consequenceLabel}>
                <span className={styles.mark} aria-hidden="true" />
                What changed
              </p>
              {view.chosenText ? <p>You chose: {view.chosenText}</p> : null}
              {view.changes.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          ) : null}
        </div>
        {view.kind === "scene" ? (
          <div className={styles.choices}>
            <h3 className={styles.groupTitle}>What will you do?</h3>
            {view.choices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                className={styles.choice}
                data-choice={choice.id}
                disabled={view.busy}
                onClick={() => onChoose(choice.id)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        ) : (
          <div>
            <h3 className={styles.groupTitle}>What happened</h3>
            <ul className={styles.summaryList}>
              {view.summary.map((item) => (
                <li key={`${item.choice} ${item.outcome}`}>
                  {item.choice} This led to {item.outcome}.
                </li>
              ))}
            </ul>
            <button type="button" className={styles.replay} disabled={view.busy} onClick={onReplay}>
              Play again
            </button>
          </div>
        )}
        {view.notice ? (
          <p className={styles.notice} role="alert">
            {view.notice}
          </p>
        ) : null}
      </section>
    </main>
  );
}
