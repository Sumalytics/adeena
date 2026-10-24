import { describe, expect, it, vi } from "vitest";
import { AudioPlaybackController, validateNarrationMedia, type AudioElementPort, type AudioPlaybackSnapshot } from "./audio-playback";
import { processDemoNarration } from "./demo-narration";
import { authoredProcessFixture } from "./fixtures";
import { frameAt, type AnimationScheduler } from "./timeline";

class ManualScheduler implements AnimationScheduler {
  time = 0;
  nextHandle = 1;
  callbacks = new Map<number, (time: number) => void>();
  now() { return this.time; }
  request(callback: (time: number) => void) { const handle = this.nextHandle++; this.callbacks.set(handle, callback); return handle; }
  cancel(handle: number) { this.callbacks.delete(handle); }
  advance(time: number) { this.time = time; const callbacks = [...this.callbacks.values()]; this.callbacks.clear(); callbacks.forEach((callback) => callback(time)); }
}

class FakeAudio implements AudioElementPort {
  currentTime = 0;
  duration = Number.NaN;
  muted = false;
  volume = 1;
  playbackRate = 1;
  paused = true;
  src = "";
  loadCount = 0;
  pauseCount = 0;
  removedSource = false;
  rejectPlay = false;
  listeners = new Map<string, Set<() => void>>();
  async play() { if (this.rejectPlay) throw new Error("media failure"); this.paused = false; }
  pause() { this.paused = true; this.pauseCount += 1; }
  load() { this.loadCount += 1; }
  removeAttribute(name: string) { if (name === "src") { this.src = ""; this.removedSource = true; } }
  addEventListener(type: string, listener: () => void) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { this.listeners.get(type)?.forEach((listener) => listener()); }
}

function setup(onComplete = vi.fn()) {
  const scene = authoredProcessFixture.scenes[0];
  const tracks = validateNarrationMedia(scene, processDemoNarration);
  const media = new FakeAudio();
  const scheduler = new ManualScheduler();
  const snapshots: AudioPlaybackSnapshot[] = [];
  const controller = new AudioPlaybackController(scene.durationMs, tracks, media, scheduler, (snapshot) => snapshots.push(snapshot), onComplete);
  return { scene, media, scheduler, snapshots, controller, onComplete };
}

describe("Visual Director narration playback", () => {
  it("maps the authoritative audio clock onto the planned visual and caption timeline", async () => {
    const { controller, media, scheduler, scene } = setup();
    await controller.play();
    media.currentTime = 1.682;
    scheduler.advance(20);
    expect(controller.snapshot()).toMatchObject({ timeMs: 2_000, status: "playing" });
    expect(frameAt(scene, controller.snapshot().timeMs).caption).toBe(scene.narration[0].caption);
    expect(frameAt(scene, controller.snapshot().timeMs, { reducedMotion: true }).objects.entry.visible).toBe(true);
  });

  it("keeps pause, resume, speed, mute and volume on the same media element", async () => {
    const { controller, media, scheduler } = setup();
    await controller.play();
    media.currentTime = 1;
    scheduler.advance(10);
    controller.pause();
    const pausedTime = controller.snapshot().timeMs;
    scheduler.advance(2_000);
    expect(controller.snapshot()).toEqual({ timeMs: pausedTime, status: "paused", error: null });
    controller.setPlaybackRate(1.5);
    controller.setMuted(true);
    controller.setVolume(0.4);
    await controller.play();
    expect(media).toMatchObject({ playbackRate: 1.5, muted: true, volume: 0.4, paused: false });
  });

  it("seeks forward and backward across segment assets and restarts", () => {
    const { controller, media } = setup();
    controller.seek(7_000);
    expect(media.src).toContain("air-route");
    expect(media.currentTime).toBeCloseTo(2.6895, 3);
    expect(controller.snapshot().timeMs).toBe(7_000);
    controller.seek(1_000);
    expect(media.src).toContain("air-start");
    expect(media.currentTime).toBeCloseTo(0.841, 3);
    controller.restart(false);
    expect(controller.snapshot()).toEqual({ timeMs: 0, status: "idle", error: null });
    expect(media.src).toContain("air-start");
  });

  it("reports buffering, supports recovery, and exposes a silent fallback error", async () => {
    const { controller, media } = setup();
    await controller.play();
    media.currentTime = 1;
    media.emit("waiting");
    expect(controller.snapshot().status).toBe("buffering");
    media.emit("playing");
    expect(controller.snapshot().status).toBe("playing");
    media.emit("error");
    expect(controller.snapshot()).toMatchObject({ status: "error", error: expect.stringContaining("silent playback") });
    controller.recover();
    expect(controller.snapshot().error).toBeNull();
  });

  it("advances through audio segments and enters practice only after final narration", async () => {
    const complete = vi.fn();
    const { controller, media, onComplete } = setup(complete);
    await controller.play();
    media.emit("ended");
    expect(media.src).toContain("air-route");
    expect(onComplete).not.toHaveBeenCalled();
    media.emit("ended");
    expect(media.src).toContain("gas-exchange");
    media.emit("ended");
    expect(controller.snapshot()).toEqual({ timeMs: 18_000, status: "completed", error: null });
    expect(onComplete).toHaveBeenCalledOnce();
    expect(media.paused).toBe(true);
  });

  it("fails closed for unapproved sources and mismatched alignment", () => {
    const scene = authoredProcessFixture.scenes[0];
    expect(() => validateNarrationMedia(scene, [{ ...processDemoNarration[0], source: "https://example.test/private.wav" }, ...processDemoNarration.slice(1)])).toThrow("approved local development asset");
    expect(() => validateNarrationMedia(scene, [{ ...processDemoNarration[0], plannedDurationMs: 3_364 }, ...processDemoNarration.slice(1)])).toThrow("validated scene timeline");
  });

  it("handles media rejection without network generation and completely cleans up", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { controller, media, scheduler } = setup();
    media.rejectPlay = true;
    await controller.play();
    expect(controller.snapshot().status).toBe("error");
    expect(fetchSpy).not.toHaveBeenCalled();
    controller.dispose();
    expect(scheduler.callbacks.size).toBe(0);
    expect(media.removedSource).toBe(true);
    expect([...media.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    fetchSpy.mockRestore();
  });
});
