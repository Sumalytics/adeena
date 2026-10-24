import type { VisualCue, VisualObject, VisualScene } from "./schema";

export type ScheduledCue = { cue: VisualCue; startMs: number };
export type VisualObjectState = {
  visible: boolean;
  highlighted: boolean;
  emphasized: boolean;
  compared: boolean;
  connected: boolean;
  state: "default" | "active" | "completed" | "correct" | "incorrect";
  x: number;
  y: number;
};

export type SceneFrame = {
  timeMs: number;
  progress: number;
  caption: string | null;
  activeNarrationId: string | null;
  objects: Readonly<Record<string, VisualObjectState>>;
};

export function scheduleSceneCues(scene: VisualScene, appliedChoiceIds: readonly string[] = []): ScheduledCue[] {
  const segmentStarts = new Map(scene.narration.map((segment) => [segment.id, segment.startMs]));
  return scene.cues
    .flatMap((cue): ScheduledCue[] => {
      if (cue.trigger.kind === "on-enter") return [{ cue, startMs: cue.trigger.atMs }];
      if (cue.trigger.kind === "narration-segment") {
        const start = segmentStarts.get(cue.trigger.segmentId);
        return start === undefined ? [] : [{ cue, startMs: start + cue.trigger.offsetMs }];
      }
      return appliedChoiceIds.includes(cue.trigger.choiceId) ? [{ cue, startMs: 0 }] : [];
    })
    .sort((left, right) => left.startMs - right.startMs || left.cue.id.localeCompare(right.cue.id));
}

function initialObjectState(object: VisualObject, scene: VisualScene): VisualObjectState {
  const startsHidden = scene.cues.some((cue) => cue.targetId === object.id && cue.action.kind === "reveal");
  return {
    visible: !startsHidden,
    highlighted: false,
    emphasized: false,
    compared: false,
    connected: object.kind === "edge",
    state: "default",
    x: object.geometry.x,
    y: object.geometry.y,
  };
}

export function frameAt(scene: VisualScene, requestedTimeMs: number, options: { reducedMotion?: boolean; appliedChoiceIds?: readonly string[] } = {}): SceneFrame {
  const timeMs = Math.max(0, Math.min(scene.durationMs, requestedTimeMs));
  const states: Record<string, VisualObjectState> = Object.fromEntries(scene.visualObjects.map((object) => [object.id, initialObjectState(object, scene)]));
  for (const { cue, startMs } of scheduleSceneCues(scene, options.appliedChoiceIds)) {
    if (timeMs < startMs) continue;
    const target = states[cue.targetId];
    if (!target) continue;
    const elapsed = timeMs - startMs;
    const progress = options.reducedMotion || cue.durationMs === 0 ? 1 : Math.min(1, elapsed / cue.durationMs);
    switch (cue.action.kind) {
      case "reveal": target.visible = true; break;
      case "hide": target.visible = progress < 1; break;
      case "highlight": target.highlighted = true; break;
      case "emphasize": target.emphasized = true; break;
      case "move": {
        const object = scene.visualObjects.find((item) => item.id === cue.targetId);
        if (object) {
          target.x = object.geometry.x + (cue.action.to.x - object.geometry.x) * progress;
          target.y = object.geometry.y + (cue.action.to.y - object.geometry.y) * progress;
        }
        break;
      }
      case "connect": target.connected = true; break;
      case "disconnect": target.connected = false; break;
      case "compare": {
        target.compared = true;
        const related = states[cue.action.relatedTargetId];
        if (related) related.compared = true;
        break;
      }
      case "transform":
      case "change-state": target.state = cue.action.state; break;
    }
  }
  const segment = scene.narration.find((item) => timeMs >= item.startMs && timeMs < item.startMs + item.durationMs) ?? null;
  return {
    timeMs,
    progress: scene.durationMs === 0 ? 1 : timeMs / scene.durationMs,
    caption: segment?.caption ?? null,
    activeNarrationId: segment?.id ?? null,
    objects: states,
  };
}

export type PlaybackStatus = "idle" | "playing" | "paused" | "completed";
export type PlaybackSnapshot = { timeMs: number; status: PlaybackStatus };
export type AnimationScheduler = {
  now(): number;
  request(callback: (time: number) => void): number;
  cancel(handle: number): void;
};

export class DeterministicPlaybackController {
  private snapshotValue: PlaybackSnapshot = { timeMs: 0, status: "idle" };
  private frameHandle: number | null = null;
  private anchorMs = 0;

  constructor(private readonly durationMs: number, private readonly scheduler: AnimationScheduler, private readonly onChange: (snapshot: PlaybackSnapshot) => void) {}

  snapshot() { return this.snapshotValue; }

  play() {
    if (this.snapshotValue.status === "playing") return;
    if (this.snapshotValue.status === "completed") this.snapshotValue = { timeMs: 0, status: "idle" };
    this.anchorMs = this.scheduler.now() - this.snapshotValue.timeMs;
    this.update({ ...this.snapshotValue, status: "playing" });
    this.queue();
  }

  pause() {
    if (this.snapshotValue.status !== "playing") return;
    this.cancelFrame();
    this.update({ ...this.snapshotValue, status: "paused" });
  }

  seek(timeMs: number) {
    const clamped = Math.max(0, Math.min(this.durationMs, timeMs));
    const status = clamped >= this.durationMs ? "completed" : this.snapshotValue.status === "completed" ? "paused" : this.snapshotValue.status;
    this.update({ timeMs: clamped, status });
    if (status === "playing") this.anchorMs = this.scheduler.now() - clamped;
    if (status === "completed") this.cancelFrame();
  }

  restart(autoPlay = true) {
    this.cancelFrame();
    this.snapshotValue = { timeMs: 0, status: "idle" };
    this.onChange(this.snapshotValue);
    if (autoPlay) this.play();
  }

  dispose() { this.cancelFrame(); }

  private queue() { this.frameHandle = this.scheduler.request((time) => this.tick(time)); }

  private tick(time: number) {
    this.frameHandle = null;
    if (this.snapshotValue.status !== "playing") return;
    const timeMs = Math.min(this.durationMs, Math.max(0, time - this.anchorMs));
    if (timeMs >= this.durationMs) {
      this.update({ timeMs: this.durationMs, status: "completed" });
      return;
    }
    this.update({ timeMs, status: "playing" });
    this.queue();
  }

  private cancelFrame() {
    if (this.frameHandle === null) return;
    this.scheduler.cancel(this.frameHandle);
    this.frameHandle = null;
  }

  private update(snapshot: PlaybackSnapshot) {
    this.snapshotValue = snapshot;
    this.onChange(snapshot);
  }
}

