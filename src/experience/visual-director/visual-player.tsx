"use client";

import { useCallback, useEffect, useState } from "react";
import type { NarrationMediaTrack } from "./audio-playback";
import type { VisualScene } from "./schema";
import { SceneStage } from "./scene-renderer";
import { frameAt, type PlaybackSnapshot } from "./timeline";
import { useVisualPlayback } from "./use-visual-playback";
import { useNarrationPlayback } from "./use-narration-playback";
import { buildPracticeChallenge } from "./practice";
import { PracticeStage } from "./practice-stage";
import styles from "./visual-director.module.css";

type CommonController = {
  play(): void | Promise<void>;
  pause(): void;
  seek(timeMs: number): void;
  restart(autoPlay?: boolean): void;
};

type ExplanationSnapshot = PlaybackSnapshot | { timeMs: number; status: "idle" | "loading" | "playing" | "paused" | "buffering" | "completed" | "error"; error: string | null };

export function VisualScenePlayer({ scene, reducedMotion: controlledReducedMotion, narrationMedia }: { scene: VisualScene; reducedMotion?: boolean; narrationMedia?: readonly NarrationMediaTrack[] }) {
  const [localReducedMotion, setLocalReducedMotion] = useState(false);
  const [mode, setMode] = useState<"explanation" | "practice">("explanation");
  const reducedMotion = controlledReducedMotion ?? localReducedMotion;
  const beginPracticeMode = useCallback(() => setMode("practice"), []);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setLocalReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  if (mode === "practice") {
    return (
      <section className={styles.player} aria-label="Interactive practice player">
        <PracticeStage scene={scene} reducedMotion={reducedMotion} onWatchAgain={() => setMode("explanation")} />
        <div className={styles.practiceToolbar}>
          <button type="button" onClick={() => setMode("explanation")}>Back to explanation</button>
          {controlledReducedMotion === undefined ? <MotionToggle reducedMotion={reducedMotion} onChange={setLocalReducedMotion} /> : null}
        </div>
      </section>
    );
  }

  const shared = { scene, reducedMotion, controlledReducedMotion, setLocalReducedMotion, onBeginPractice: beginPracticeMode };
  return narrationMedia
    ? <NarratedExplanation {...shared} narrationMedia={narrationMedia} />
    : <SilentExplanation {...shared} />;
}

type ExplanationProps = {
  scene: VisualScene;
  reducedMotion: boolean;
  controlledReducedMotion?: boolean;
  setLocalReducedMotion(value: boolean): void;
  onBeginPractice(): void;
};

function SilentExplanation(props: ExplanationProps & { fallbackMessage?: string }) {
  const { snapshot, controller } = useVisualPlayback(props.scene.durationMs);
  return <ExplanationView {...props} snapshot={snapshot} controller={controller} mediaNote={props.fallbackMessage ?? "Silent authored demonstration. Captions and visual cues use the deterministic fallback clock."} />;
}

function NarratedExplanation(props: ExplanationProps & { narrationMedia: readonly NarrationMediaTrack[] }) {
  const { onBeginPractice } = props;
  const [useSilentFallback, setUseSilentFallback] = useState(false);
  const complete = useCallback(() => onBeginPractice(), [onBeginPractice]);
  const { snapshot, controller } = useNarrationPlayback(props.scene, props.narrationMedia, complete);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);

  if (useSilentFallback) return <SilentExplanation {...props} fallbackMessage="Narration is unavailable. Continuing with synchronized captions and silent deterministic playback." />;

  const audioControls = (
    <div className={styles.audioControls} aria-label="Narration settings">
      <label className={styles.motionToggle}>
        <input type="checkbox" checked={muted} onChange={(event) => { const value = event.currentTarget.checked; setMuted(value); controller.setMuted(value); }} /> Mute
      </label>
      <label className={styles.volumeControl}><span>Volume</span><input aria-label="Narration volume" type="range" min="0" max="1" step="0.1" value={volume} onChange={(event) => { const value = Number(event.currentTarget.value); setVolume(value); controller.setVolume(value); }} /></label>
      <label className={styles.speedControl}><span>Speed</span><select aria-label="Narration speed" value={rate} onChange={(event) => { const value = Number(event.currentTarget.value); setRate(value); controller.setPlaybackRate(value); }}><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option></select></label>
    </div>
  );

  const errorControls = snapshot.status === "error" ? (
    <div className={styles.audioError} role="alert">
      <span>{snapshot.error}</span>
      <button type="button" onClick={() => { controller.recover(); void controller.play(); }}>Try audio again</button>
      <button type="button" onClick={() => setUseSilentFallback(true)}>Continue silently</button>
    </div>
  ) : null;

  const status = snapshot.status === "loading" ? "Loading narration…" : snapshot.status === "buffering" ? "Buffering narration…" : snapshot.status === "playing" ? "Narration playing" : "Prerecorded narration ready";
  return <ExplanationView {...props} snapshot={snapshot} controller={controller} mediaNote="Private prerecorded narration. No speech service is called during playback." audioControls={audioControls} errorControls={errorControls} statusAnnouncement={status} />;
}

function ExplanationView({ scene, reducedMotion, controlledReducedMotion, setLocalReducedMotion, onBeginPractice, snapshot, controller, mediaNote, audioControls, errorControls, statusAnnouncement }: ExplanationProps & {
  snapshot: ExplanationSnapshot;
  controller: CommonController;
  mediaNote: string;
  audioControls?: React.ReactNode;
  errorControls?: React.ReactNode;
  statusAnnouncement?: string;
}) {
  const frame = frameAt(scene, snapshot.timeMs, { reducedMotion });
  const progressLabel = `${formatTime(snapshot.timeMs)} of ${formatTime(scene.durationMs)}`;
  const practiceAvailable = buildPracticeChallenge(scene) !== null;
  const active = snapshot.status === "playing" || snapshot.status === "loading" || snapshot.status === "buffering";
  const beginPractice = () => { controller.pause(); controller.seek(scene.durationMs); onBeginPractice(); };
  return (
    <section className={styles.player} aria-label="Visual explanation player">
      <SceneStage scene={scene} timeMs={snapshot.timeMs} reducedMotion={reducedMotion} />
      <div className={styles.caption} aria-live="polite" aria-atomic="true">
        <span className={styles.captionLabel}>Caption</span>
        <p>{frame.caption ?? (snapshot.status === "completed" ? "Explanation complete." : "Press play to begin the explanation.")}</p>
      </div>
      <div className={styles.transport}>
        <button type="button" disabled={snapshot.status === "error"} onClick={() => active ? controller.pause() : void controller.play()}>{active ? "Pause" : snapshot.status === "paused" ? "Resume" : "Play"}</button>
        <button type="button" onClick={() => controller.restart(true)}>Restart</button>
        {practiceAvailable ? <button type="button" className={styles.practiceButton} onClick={beginPractice}>Start practice</button> : null}
        <label className={styles.scrubber}><span>Position</span><input aria-label="Animation position" type="range" min="0" max={scene.durationMs} step="100" value={snapshot.timeMs} onChange={(event) => controller.seek(Number(event.currentTarget.value))} /></label>
        <output className={styles.time} aria-label="Playback time">{progressLabel}</output>
        {controlledReducedMotion === undefined ? <MotionToggle reducedMotion={reducedMotion} onChange={setLocalReducedMotion} /> : null}
        {audioControls}
      </div>
      {statusAnnouncement ? <p className={styles.playbackStatus} aria-live="polite">{statusAnnouncement}</p> : null}
      {errorControls}
      <p className={styles.silentNote}>{mediaNote}</p>
    </section>
  );
}

function MotionToggle({ reducedMotion, onChange }: { reducedMotion: boolean; onChange(value: boolean): void }) {
  return <label className={styles.motionToggle}><input type="checkbox" checked={reducedMotion} onChange={(event) => onChange(event.currentTarget.checked)} /> Reduced motion</label>;
}

function formatTime(timeMs: number) {
  const seconds = Math.floor(timeMs / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
