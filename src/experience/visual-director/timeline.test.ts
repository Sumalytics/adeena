import { describe, expect, it, vi } from "vitest";
import { authoredProcessFixture, authoredTwoSetFixture } from "./fixtures";
import { DeterministicPlaybackController, frameAt, scheduleSceneCues, type AnimationScheduler, type PlaybackSnapshot } from "./timeline";

class ManualScheduler implements AnimationScheduler {
  time = 0;
  nextHandle = 1;
  callbacks = new Map<number, (time: number) => void>();
  cancelled: number[] = [];
  now() { return this.time; }
  request(callback: (time: number) => void) { const handle = this.nextHandle++; this.callbacks.set(handle, callback); return handle; }
  cancel(handle: number) { this.cancelled.push(handle); this.callbacks.delete(handle); }
  advance(time: number) {
    this.time = time;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback(time));
  }
}

describe("Visual Director deterministic timeline", () => {
  const processScene = authoredProcessFixture.scenes[0];
  const setScene = authoredTwoSetFixture.scenes[0];

  it("orders narration cues by resolved timeline position", () => {
    expect(scheduleSceneCues(processScene).map(({ cue, startMs }) => [cue.id, startMs])).toEqual([
      ["show-entry", 0], ["trace-airway", 4_200], ["show-exchange", 10_100],
    ]);
  });

  it("reconstructs different visible states for highlight, emphasize and movement", () => {
    const before = frameAt(processScene, 4_000);
    const highlighted = frameAt(processScene, 4_500);
    const emphasized = frameAt(processScene, 11_000);
    expect(before.objects["path-two"].highlighted).toBe(false);
    expect(highlighted.objects["path-two"].highlighted).toBe(true);
    expect(emphasized.objects["air-sacs"].emphasized).toBe(true);

    const moving = frameAt(setScene, 6_350);
    expect(moving.objects["overlap-count"].x).toBe(465);
    expect(moving.objects["overlap-count"].y).toBe(415);
    expect(frameAt(setScene, 6_000, { reducedMotion: true }).objects["overlap-count"]).toMatchObject({ x: 500, y: 440 });
  });

  it("provides synchronized captions and deterministic seek reconstruction", () => {
    expect(frameAt(processScene, 2_000).caption).toBe(processScene.narration[0].caption);
    expect(frameAt(processScene, 8_000).caption).toBe(processScene.narration[1].caption);
    expect(frameAt(processScene, 8_000)).toEqual(frameAt(processScene, 8_000));
  });

  it("pauses, resumes and completes using an injectable clock", () => {
    const scheduler = new ManualScheduler();
    const snapshots: PlaybackSnapshot[] = [];
    const controller = new DeterministicPlaybackController(2_000, scheduler, (snapshot) => snapshots.push(snapshot));
    controller.play();
    scheduler.advance(800);
    controller.pause();
    scheduler.advance(4_000);
    expect(controller.snapshot()).toEqual({ timeMs: 800, status: "paused" });
    controller.play();
    scheduler.advance(4_700);
    expect(controller.snapshot()).toEqual({ timeMs: 1_500, status: "playing" });
    scheduler.advance(5_300);
    expect(controller.snapshot()).toEqual({ timeMs: 2_000, status: "completed" });
    expect(snapshots.some((snapshot) => snapshot.status === "paused")).toBe(true);
  });

  it("restarts to the same state, seeks safely and cleans up scheduled work", () => {
    const scheduler = new ManualScheduler();
    const controller = new DeterministicPlaybackController(2_000, scheduler, () => undefined);
    controller.play();
    scheduler.advance(900);
    controller.restart(false);
    expect(controller.snapshot()).toEqual({ timeMs: 0, status: "idle" });
    controller.seek(99_000);
    expect(controller.snapshot()).toEqual({ timeMs: 2_000, status: "completed" });
    controller.restart(true);
    expect(scheduler.callbacks.size).toBe(1);
    controller.dispose();
    expect(scheduler.callbacks.size).toBe(0);
    expect(scheduler.cancelled.length).toBeGreaterThan(0);
  });

  it("does not request a model or network resource during playback", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const scheduler = new ManualScheduler();
    const controller = new DeterministicPlaybackController(1_000, scheduler, () => undefined);
    controller.play();
    scheduler.advance(1_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

