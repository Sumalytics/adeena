"use client";

import { useState } from "react";
import { authoredHistoryFixture, authoredProcessFixture, authoredTwoSetFixture } from "./fixtures";
import type { VisualLearningBlueprint } from "./schema";
import { VisualScenePlayer } from "./visual-player";
import { processDemoNarration } from "./demo-narration";
import styles from "./visual-director.module.css";

const demos = {
  process: { label: "Process pathway", description: "Authored respiratory-system acceptance fixture", blueprint: authoredProcessFixture },
  sets: { label: "Two-set relationship", description: "Authored mathematics acceptance fixture", blueprint: authoredTwoSetFixture },
  history: { label: "Unsupported archetype check", description: "Authored unrelated history compatibility fixture", blueprint: authoredHistoryFixture },
} satisfies Record<string, { label: string; description: string; blueprint: VisualLearningBlueprint }>;

type DemoId = keyof typeof demos;

export function VisualDirectorDemo() {
  const [selected, setSelected] = useState<DemoId>("process");
  const demo = demos[selected];
  const scene = demo.blueprint.scenes[0];
  return (
    <main id="content" className={styles.demoShell}>
      <header className={styles.demoHeader}>
        <p className={styles.eyebrow}>Adeena Visual Director · development preview</p>
        <h1>Watch the idea take shape</h1>
        <p>These are plainly authored acceptance fixtures. The process fixture uses local prerecorded narration; the alternate fixtures retain deterministic silent playback.</p>
      </header>
      <nav className={styles.demoPicker} aria-label="Choose an authored demonstration">
        {(Object.entries(demos) as Array<[DemoId, (typeof demos)[DemoId]]>).map(([id, item]) => (
          <button key={id} type="button" aria-pressed={selected === id} onClick={() => setSelected(id)}>
            <strong>{item.label}</strong><span>{item.description}</span>
          </button>
        ))}
      </nav>
      <section className={styles.demoCard}>
        <div className={styles.sceneHeading}>
          <div><p>{scene.phase}</p><h2>{demo.label}</h2></div>
          <span>{demo.blueprint.ageBand} · {demo.blueprint.locale}</span>
        </div>
        <VisualScenePlayer key={scene.id} scene={scene} narrationMedia={selected === "process" ? processDemoNarration : undefined} />
      </section>
    </main>
  );
}

