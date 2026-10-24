"use client";

import { useEffect, useMemo, useState } from "react";
import { DeterministicPlaybackController, type AnimationScheduler, type PlaybackSnapshot } from "./timeline";

const browserScheduler: AnimationScheduler = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export function useVisualPlayback(durationMs: number) {
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>({ timeMs: 0, status: "idle" });
  const controller = useMemo(() => new DeterministicPlaybackController(durationMs, browserScheduler, setSnapshot), [durationMs]);
  useEffect(() => () => controller.dispose(), [controller]);
  return { snapshot, controller };
}

