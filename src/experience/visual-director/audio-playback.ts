import { NarrationPlaybackTrackV1, type VisualScene } from "./schema";
import type { AnimationScheduler } from "./timeline";

export type NarrationMediaTrack = {
  playback: unknown;
  source: string;
  plannedStartMs: number;
  plannedDurationMs: number;
};

export type ValidatedNarrationMediaTrack = {
  playback: ReturnType<typeof NarrationPlaybackTrackV1.parse>;
  source: string;
  plannedStartMs: number;
  plannedDurationMs: number;
};

export type AudioPlaybackStatus = "idle" | "loading" | "playing" | "paused" | "buffering" | "completed" | "error";
export type AudioPlaybackSnapshot = {
  timeMs: number;
  status: AudioPlaybackStatus;
  error: string | null;
};

export type AudioElementPort = {
  currentTime: number;
  duration: number;
  muted: boolean;
  volume: number;
  playbackRate: number;
  paused: boolean;
  src: string;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

export function validateNarrationMedia(scene: VisualScene, input: readonly NarrationMediaTrack[]): ValidatedNarrationMediaTrack[] {
  if (input.length !== scene.narration.length) throw new Error("Narration media must cover every scene narration segment.");
  return input.map((candidate, index) => {
    const playback = NarrationPlaybackTrackV1.parse(candidate.playback);
    const segment = scene.narration[index];
    if (!segment || playback.segmentId !== segment.id) throw new Error("Narration media order must match the validated scene narration order.");
    if (candidate.plannedStartMs !== segment.startMs || candidate.plannedDurationMs !== segment.durationMs) throw new Error("Narration media alignment must match the validated scene timeline.");
    if (playback.captions.length !== 1 || playback.captions[0]?.text !== segment.caption) throw new Error("Narration media captions must match the validated spoken narration.");
    if (!/^\/api\/(?:dev\/visual-director-audio\/[a-z][a-z0-9-]{0,40}|creator\/audio\/[0-9a-f-]{36})$/.test(candidate.source)) throw new Error("Narration media must use an approved private or local development asset route.");
    return { ...candidate, playback };
  });
}

export class AudioPlaybackController {
  private snapshotValue: AudioPlaybackSnapshot = { timeMs: 0, status: "idle", error: null };
  private activeIndex = 0;
  private frameHandle: number | null = null;
  private wantsPlayback = false;
  private disposed = false;
  private pendingMediaTime = 0;
  private readonly listeners: Array<[string, () => void]>;

  constructor(
    private readonly durationMs: number,
    private readonly tracks: readonly ValidatedNarrationMediaTrack[],
    private readonly media: AudioElementPort,
    private readonly scheduler: AnimationScheduler,
    private readonly onChange: (snapshot: AudioPlaybackSnapshot) => void,
    private readonly onComplete?: () => void,
  ) {
    if (tracks.length === 0) throw new Error("Audio playback requires at least one validated track.");
    this.listeners = [
      ["loadedmetadata", this.handleLoadedMetadata],
      ["timeupdate", this.handleTimeUpdate],
      ["playing", this.handlePlaying],
      ["waiting", this.handleBuffering],
      ["stalled", this.handleBuffering],
      ["ended", this.handleEnded],
      ["error", this.handleError],
    ];
    this.listeners.forEach(([type, listener]) => media.addEventListener(type, listener));
    this.activateTrack(0, 0);
  }

  snapshot() { return this.snapshotValue; }
  isMuted() { return this.media.muted; }
  volume() { return this.media.volume; }
  playbackRate() { return this.media.playbackRate; }

  async play() {
    if (this.disposed || this.snapshotValue.status === "playing") return;
    if (this.snapshotValue.status === "completed") this.seek(0);
    this.wantsPlayback = true;
    this.update({ ...this.snapshotValue, status: "loading", error: null });
    try {
      await this.media.play();
      if (!this.disposed && this.wantsPlayback) this.handlePlaying();
    } catch {
      if (!this.disposed) this.fail("Narration could not be played. Captions and silent playback remain available.");
    }
  }

  pause() {
    this.wantsPlayback = false;
    this.media.pause();
    this.cancelFrame();
    if (this.snapshotValue.status !== "completed") this.update({ ...this.snapshotValue, status: "paused" });
  }

  seek(requestedTimeMs: number) {
    const timeMs = Math.max(0, Math.min(this.durationMs, requestedTimeMs));
    if (timeMs >= this.durationMs) {
      this.wantsPlayback = false;
      this.media.pause();
      this.cancelFrame();
      this.update({ timeMs: this.durationMs, status: "completed", error: null });
      return;
    }
    const index = this.trackIndexAt(timeMs);
    const mediaTime = this.toMediaTime(index, timeMs);
    if (index !== this.activeIndex) this.activateTrack(index, mediaTime);
    else this.media.currentTime = mediaTime;
    this.update({ timeMs, status: this.wantsPlayback ? "loading" : "paused", error: null });
    if (this.wantsPlayback) void this.resumeAfterTrackChange();
  }

  restart(autoPlay = true) {
    this.wantsPlayback = false;
    this.media.pause();
    this.cancelFrame();
    this.activateTrack(0, 0);
    this.update({ timeMs: 0, status: "idle", error: null });
    if (autoPlay) void this.play();
  }

  setPlaybackRate(rate: number) {
    this.media.playbackRate = Math.max(0.5, Math.min(2, rate));
  }

  setMuted(muted: boolean) { this.media.muted = muted; }
  setVolume(volume: number) { this.media.volume = Math.max(0, Math.min(1, volume)); }

  recover() {
    const wasPlaying = this.wantsPlayback;
    const currentTime = this.snapshotValue.timeMs;
    this.activateTrack(this.trackIndexAt(currentTime), this.toMediaTime(this.trackIndexAt(currentTime), currentTime));
    this.update({ ...this.snapshotValue, status: wasPlaying ? "loading" : "paused", error: null });
    if (wasPlaying) void this.resumeAfterTrackChange();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.wantsPlayback = false;
    this.cancelFrame();
    this.media.pause();
    this.listeners.forEach(([type, listener]) => this.media.removeEventListener(type, listener));
    this.media.removeAttribute("src");
    this.media.load();
  }

  private readonly handleLoadedMetadata = () => {
    this.media.currentTime = this.pendingMediaTime;
    this.sample();
  };

  private readonly handleTimeUpdate = () => this.sample();

  private readonly handlePlaying = () => {
    if (!this.wantsPlayback || this.disposed) return;
    this.update({ ...this.snapshotValue, status: "playing", error: null });
    this.queue();
  };

  private readonly handleBuffering = () => {
    if (!this.wantsPlayback || this.disposed) return;
    this.sample("buffering");
  };

  private readonly handleEnded = () => {
    const nextIndex = this.activeIndex + 1;
    if (nextIndex < this.tracks.length) {
      const next = this.tracks[nextIndex];
      this.update({ timeMs: next.plannedStartMs, status: this.wantsPlayback ? "loading" : "paused", error: null });
      this.activateTrack(nextIndex, 0);
      if (this.wantsPlayback) void this.resumeAfterTrackChange();
      return;
    }
    this.wantsPlayback = false;
    this.media.pause();
    this.cancelFrame();
    this.update({ timeMs: this.durationMs, status: "completed", error: null });
    this.onComplete?.();
  };

  private readonly handleError = () => this.fail("Narration failed to load. Captions and silent playback remain available.");

  private activateTrack(index: number, mediaTime: number) {
    this.activeIndex = index;
    this.pendingMediaTime = mediaTime;
    this.media.pause();
    this.media.src = this.tracks[index].source;
    this.media.load();
    try { this.media.currentTime = mediaTime; } catch { /* The metadata event applies the pending seek. */ }
  }

  private async resumeAfterTrackChange() {
    try {
      await this.media.play();
      if (!this.disposed && this.wantsPlayback) this.handlePlaying();
    } catch {
      if (!this.disposed) this.fail("Narration could not resume. Captions and silent playback remain available.");
    }
  }

  private trackIndexAt(timeMs: number) {
    const index = this.tracks.findIndex((track) => timeMs >= track.plannedStartMs && timeMs < track.plannedStartMs + track.plannedDurationMs);
    if (index >= 0) return index;
    return timeMs < this.tracks[0].plannedStartMs ? 0 : this.tracks.length - 1;
  }

  private toMediaTime(index: number, sceneTimeMs: number) {
    const track = this.tracks[index];
    const progress = Math.max(0, Math.min(1, (sceneTimeMs - track.plannedStartMs) / track.plannedDurationMs));
    return progress * track.playback.durationMs / 1_000;
  }

  private toSceneTime(index: number, mediaTime: number) {
    const track = this.tracks[index];
    const progress = Math.max(0, Math.min(1, mediaTime * 1_000 / track.playback.durationMs));
    return track.plannedStartMs + progress * track.plannedDurationMs;
  }

  private sample(status = this.snapshotValue.status) {
    if (this.disposed) return;
    this.update({ timeMs: this.toSceneTime(this.activeIndex, this.media.currentTime), status, error: null });
  }

  private queue() {
    if (this.frameHandle !== null || this.disposed) return;
    this.frameHandle = this.scheduler.request(() => {
      this.frameHandle = null;
      if (this.snapshotValue.status !== "playing" && this.snapshotValue.status !== "buffering") return;
      this.sample();
      this.queue();
    });
  }

  private cancelFrame() {
    if (this.frameHandle === null) return;
    this.scheduler.cancel(this.frameHandle);
    this.frameHandle = null;
  }

  private fail(message: string) {
    this.wantsPlayback = false;
    this.media.pause();
    this.cancelFrame();
    this.update({ ...this.snapshotValue, status: "error", error: message });
  }

  private update(snapshot: AudioPlaybackSnapshot) {
    this.snapshotValue = snapshot;
    this.onChange(snapshot);
  }
}
