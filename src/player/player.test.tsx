import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sharedShelf } from "@adeena/experience-schema";
import { sharedShelfPresentation } from "@/app/play/demo/presentation";
import { sharedShelfRenderer } from "@/app/play/demo/renderer";
import { PlayerApp, PlayerBoundary } from "@/player/player-app";
import { PlayerScreen } from "@/player/player-screen";
import { presentPlayer } from "@/player/present";
import { cssRenderer } from "@/player/renderer";
import { applyChoice, createPlayerController, openSession } from "@/player/session";

const playerDir = fileURLToPath(new URL(".", import.meta.url));
const playDir = fileURLToPath(new URL("../app/play", import.meta.url));

function started() {
  const controller = createPlayerController(sharedShelf);
  controller.beginPlay();
  return controller;
}

function play(choiceIds: readonly string[]) {
  const controller = started();
  for (const choiceId of choiceIds) {
    controller.beginChoice(choiceId);
    controller.settle();
  }
  return controller;
}

describe("universal player session", () => {
  it("loads the synthetic shared shelf experience", () => {
    const session = openSession(sharedShelf);
    expect(session.phase).toBe("playing");
    expect(session.state?.sceneId).toBe("ask");
    expect(session.state?.variables["shared-tools"]).toBe(3);
    expect(session.facts.map((fact) => fact.kind)).toEqual(["experience_started", "scene_entered"]);
  });

  it("fails closed for an invalid manifest without internal details", () => {
    const session = openSession({ schema: "adeena.experience-manifest", schemaVersion: "2" });
    expect(session.phase).toBe("unavailable");
    expect(session.game).toBeNull();
    expect(session.notice).toBe("This experience cannot be played.");
    expect(JSON.stringify(session)).not.toMatch(/diagnostic|stack|Zod|schemaVersion/i);

    const html = renderToStaticMarkup(
      <PlayerApp manifest={{ schemaVersion: "2" }} presentation={sharedShelfPresentation} renderer={cssRenderer} />,
    );
    expect(html).toContain("This experience cannot be played.");
    expect(html).not.toContain("schemaVersion");
  });

  it("renders the opening and then the initial scene", () => {
    const cover = presentPlayer(openSession(sharedShelf), sharedShelfPresentation);
    expect(cover.kind).toBe("cover");
    if (cover.kind !== "cover") return;
    expect(cover.title).toBe("Shared shelf");
    expect(cover.locale).toBe("en");
    expect(cover.meters.map((meter) => [meter.label, meter.value])).toEqual([
      ["Tools on the shelf", 3],
      ["Repairs recorded", 0],
      ["Keeper notes", 0],
    ]);

    const scene = presentPlayer(started().snapshot(), sharedShelfPresentation);
    expect(scene.kind).toBe("scene");
    if (scene.kind !== "scene") return;
    expect(scene.sceneTitle).toBe("At the shelf");
    expect(scene.narrative).toContain("shared drill");
    expect(scene.choices).toHaveLength(3);

    const html = renderToStaticMarkup(
      <PlayerScreen view={scene} renderer={sharedShelfRenderer} onBegin={() => {}} onChoose={() => {}} onReplay={() => {}} />,
    );
    expect(html).toContain("At the shelf");
    expect(html).toContain("Hand over the drill");
    expect(html).toContain("Tools on the shelf: 3");
    expect(html).not.toContain("shared-tools");
  });

  it("shows the next scene and the numeric consequence of a choice", () => {
    const controller = play(["share-now"]);
    const view = presentPlayer(controller.snapshot(), sharedShelfPresentation);
    expect(view.kind).toBe("scene");
    if (view.kind !== "scene") return;
    expect(view.sceneTitle).toBe("How to record it");
    expect(view.changes).toContain("Tools on the shelf went from 3 to 2.");
    expect(view.chosenText).toContain("Hand over the drill");
    expect(view.meters.find((meter) => meter.label === "Tools on the shelf")?.value).toBe(2);
  });

  it("reaches different endings from different choices", () => {
    const card = presentPlayer(play(["share-now", "write-card"]).snapshot(), sharedShelfPresentation);
    const posted = presentPlayer(play(["point-to-board", "post-request"]).snapshot(), sharedShelfPresentation);
    expect(card.kind).toBe("ending");
    expect(posted.kind).toBe("ending");
    if (card.kind !== "ending" || posted.kind !== "ending") return;
    expect(card.sceneTitle).toBe("Card on the shelf");
    expect(posted.sceneTitle).toBe("Request posted");
    expect(card.summary.map((item) => item.outcome)).toEqual(["How to record it", "Card on the shelf"]);
    expect(posted.sceneTitle).not.toBe(card.sceneTitle);
  });

  it("renders a completion screen with replay", () => {
    const view = presentPlayer(play(["ask-purpose", "offer-hand-tool"]).snapshot(), sharedShelfPresentation);
    const html = renderToStaticMarkup(
      <PlayerScreen view={view} renderer={sharedShelfRenderer} onBegin={() => {}} onChoose={() => {}} onReplay={() => {}} />,
    );
    expect(html).toContain("Hand tool");
    expect(html).toContain("What happened");
    expect(html).toContain("Play again");
    expect(html).not.toContain("mastered");
    expect(html).not.toContain("Excellent");
  });

  it("restores the initial state on replay", () => {
    const controller = play(["share-now", "tell-keeper"]);
    expect(controller.snapshot().phase).toBe("completed");
    controller.beginRestart();
    controller.settle();
    const again = controller.snapshot();
    expect(again.started).toBe(false);
    expect(again.state?.sceneId).toBe("ask");
    expect(again.state?.revision).toBe(0);
    expect(again.state?.variables).toEqual({ "shared-tools": 3, repairs: 0, keepers: 0 });
    expect(presentPlayer(again, sharedShelfPresentation).kind).toBe("cover");
  });

  it("leaves state unchanged when a choice is rejected", () => {
    const controller = started();
    const before = controller.snapshot();
    const after = applyChoice(before, "not-a-choice");
    expect(after.state).toBe(before.state);
    expect(after.facts).toBe(before.facts);
    expect(after.notice).toBe("That choice is not available.");
    expect(after.notice).not.toMatch(/INVALID_ACTION|diagnostic/);
  });

  it("ignores a second choice while the first is still in progress", () => {
    const controller = started();
    const first = controller.beginChoice("share-now");
    const second = controller.beginChoice("write-card");
    expect(second).toBe(first);
    expect(second.state?.sceneId).toBe("record");
    expect(second.state?.revision).toBe(1);
    controller.settle();
    const next = controller.beginChoice("write-card");
    expect(next.state?.sceneId).toBe("card-ending");
  });
});

describe("universal player presentation", () => {
  it("uses buttons, locale, and a polite live region", () => {
    const html = renderToStaticMarkup(
      <PlayerApp manifest={sharedShelf} presentation={sharedShelfPresentation} renderer={sharedShelfRenderer} />,
    );
    expect(html).toContain('lang="en"');
    expect(html).toContain(">Begin<");
    expect(html).toContain('data-renderer="css"');

    const scene = presentPlayer(started().snapshot(), sharedShelfPresentation);
    const sceneHtml = renderToStaticMarkup(
      <PlayerScreen view={scene} renderer={sharedShelfRenderer} onBegin={() => {}} onChoose={() => {}} onReplay={() => {}} />,
    );
    expect(sceneHtml).toContain('<button type="button"');
    expect(sceneHtml).toContain('aria-live="polite"');
    expect(sceneHtml).toContain('aria-label="Current situation"');
    expect(sceneHtml).not.toContain("tabindex=\"0\"");
  });

  it("keeps reduced motion in the player stylesheet", () => {
    const css = readFileSync(join(playerDir, "player.module.css"), "utf8");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none");
    const scene = presentPlayer(play(["share-now"]).snapshot(), sharedShelfPresentation);
    const html = renderToStaticMarkup(
      <PlayerScreen view={scene} renderer={cssRenderer} onBegin={() => {}} onChoose={() => {}} onReplay={() => {}} />,
    );
    expect(html).toContain("Tools on the shelf went from 3 to 2.");
  });

  it("renders narrative as text and does not request manifest asset urls", () => {
    const scene = presentPlayer(started().snapshot(), sharedShelfPresentation);
    if (scene.kind !== "scene") throw new Error("expected a scene");
    const hostile = { ...scene, narrative: '<script>alert(1)</script><img src=x onerror=alert(1)>' };
    const html = renderToStaticMarkup(
      <PlayerScreen view={hostile} renderer={sharedShelfRenderer} onBegin={() => {}} onChoose={() => {}} onReplay={() => {}} />,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("assets/shelf.svg");

    const sources = [...walk(playerDir), ...walk(playDir)].filter(
      (file) => /\.(ts|tsx|css)$/.test(file) && !file.includes(".test."),
    );
    const combined = sources.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(combined).not.toContain("dangerouslySetInnerHTML");
    expect(combined).not.toContain("assets/shelf.svg");
  });

  it("shows a visible fallback when a scene has no illustration", () => {
    const Visual = sharedShelfRenderer.Visual;
    const html = renderToStaticMarkup(
      <Visual
        sceneId="keeper-ending"
        title="Keeper knows"
        description="The shelf keeper has been told who borrowed the drill."
        decorative={false}
        missing={false}
      />,
    );
    expect(html).toContain("No illustration for this scene.");
    expect(html).toContain("Keeper knows");
  });

  it("hides a thrown player error without the exception text", () => {
    expect(PlayerBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const boundary = new PlayerBoundary({ children: "secret stack trace" });
    boundary.state = { failed: true };
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain("This experience cannot be played.");
    expect(html).not.toContain("secret stack trace");
  });
});

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
