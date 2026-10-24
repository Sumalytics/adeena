"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AudioPlaybackController, validateNarrationMedia, type AudioElementPort, type AudioPlaybackSnapshot, type NarrationMediaTrack } from "./audio-playback";
import type { VisualScene } from "./schema";
import type { AnimationScheduler } from "./timeline";

const browserScheduler: AnimationScheduler = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export function useNarrationPlayback(scene: VisualScene, tracks: readonly NarrationMediaTrack[], onComplete: () => void) {
  const [snapshot, setSnapshot] = useState<AudioPlaybackSnapshot>({ timeMs: 0, status: "idle", error: null });
  const validated = useMemo(() => validateNarrationMedia(scene, tracks), [scene, tracks]);
  const controllerRef = useRef<AudioPlaybackController | null>(null);
  useEffect(() => {
    const instance = new AudioPlaybackController(scene.durationMs, validated, new Audio() as AudioElementPort, browserScheduler, setSnapshot, onComplete);
    controllerRef.current = instance;
    return () => { controllerRef.current = null; instance.dispose(); };
  }, [scene.durationMs, validated, onComplete]);
  const controller = useMemo(() => ({
    play: () => controllerRef.current?.play(),
    pause: () => controllerRef.current?.pause(),
    seek: (timeMs: number) => controllerRef.current?.seek(timeMs),
    restart: (autoPlay = true) => controllerRef.current?.restart(autoPlay),
    recover: () => controllerRef.current?.recover(),
    setMuted: (muted: boolean) => controllerRef.current?.setMuted(muted),
    setVolume: (volume: number) => controllerRef.current?.setVolume(volume),
    setPlaybackRate: (rate: number) => controllerRef.current?.setPlaybackRate(rate),
  }), []);
  return { snapshot, controller };
}
