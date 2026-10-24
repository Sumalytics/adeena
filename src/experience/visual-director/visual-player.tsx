"use client";

import { useEffect, useState } from "react";
import type { VisualScene } from "./schema";
import { SceneStage } from "./scene-renderer";
import { frameAt } from "./timeline";
import { useVisualPlayback } from "./use-visual-playback";
import styles from "./visual-director.module.css";

export function VisualScenePlayer({ scene, reducedMotion: controlledReducedMotion }: { scene: VisualScene; reducedMotion?: boolean }) {
  const { snapshot, controller } = useVisualPlayback(scene.durationMs);
  const [localReducedMotion, setLocalReducedMotion] = useState(false);
  const reducedMotion = controlledReducedMotion ?? localReducedMotion;
  const frame = frameAt(scene, snapshot.timeMs, { reducedMotion });
  const progressLabel = `${formatTime(snapshot.timeMs)} of ${formatTime(scene.durationMs)}`;

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setLocalReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return (
    <section className={styles.player} aria-label="Visual explanation player">
      <SceneStage scene={scene} timeMs={snapshot.timeMs} reducedMotion={reducedMotion} />
      <div className={styles.caption} aria-live="polite" aria-atomic="true">
        <span className={styles.captionLabel}>Caption</span>
        <p>{frame.caption ?? (snapshot.status === "completed" ? "Explanation complete." : "Press play to begin the silent visual explanation.")}</p>
      </div>
      <div className={styles.transport}>
        <button type="button" onClick={() => snapshot.status === "playing" ? controller.pause() : controller.play()}>{snapshot.status === "playing" ? "Pause" : snapshot.status === "paused" ? "Resume" : "Play"}</button>
        <button type="button" onClick={() => controller.restart(true)}>Restart</button>
        <label className={styles.scrubber}>
          <span>Position</span>
          <input aria-label="Animation position" type="range" min="0" max={scene.durationMs} step="100" value={snapshot.timeMs} onChange={(event) => controller.seek(Number(event.currentTarget.value))} />
        </label>
        <output className={styles.time} aria-label="Playback time">{progressLabel}</output>
        {controlledReducedMotion === undefined ? <label className={styles.motionToggle}><input type="checkbox" checked={reducedMotion} onChange={(event) => setLocalReducedMotion(event.currentTarget.checked)} /> Reduced motion</label> : null}
      </div>
      <p className={styles.silentNote}>Silent authored demonstration. Captions and visual cues use the same deterministic timeline reserved for future prerecorded narration.</p>
    </section>
  );
}

function formatTime(timeMs: number) {
  const seconds = Math.floor(timeMs / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

