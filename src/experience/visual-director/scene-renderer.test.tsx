import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { authoredHistoryFixture, authoredProcessFixture, authoredTwoSetFixture } from "./fixtures";
import { SceneStage } from "./scene-renderer";

describe("Visual Director scene renderer", () => {
  it("renders validated process and two-set fixtures through distinct archetypes", () => {
    const process = renderToStaticMarkup(<SceneStage scene={authoredProcessFixture.scenes[0]} timeMs={5_000} />);
    const sets = renderToStaticMarkup(<SceneStage scene={authoredTwoSetFixture.scenes[0]} timeMs={7_000} />);
    expect(process).toContain('data-archetype="process-pathway@1"');
    expect(process).toContain("Trachea");
    expect(process).toContain('data-object-id="path-two"');
    expect(sets).toContain('data-archetype="venn-two-set@1"');
    expect(sets).toContain("First set only");
    expect(sets).toContain("union 26");
    expect(sets).toContain(">6<");
  });

  it("renders different cue times as different deterministic states", () => {
    const before = renderToStaticMarkup(<SceneStage scene={authoredTwoSetFixture.scenes[0]} timeMs={6_000} />);
    const during = renderToStaticMarkup(<SceneStage scene={authoredTwoSetFixture.scenes[0]} timeMs={6_350} />);
    expect(before).toContain('data-x="430"');
    expect(during).toContain('data-x="465"');
  });

  it("reports an unsupported registered renderer explicitly", () => {
    const output = renderToStaticMarkup(<SceneStage scene={authoredHistoryFixture.scenes[0]} timeMs={2_000} />);
    expect(output).toContain("This visual renderer is not available yet.");
    expect(output).toContain("timeline-sequence@1");
  });

  it("uses reduced-motion state and never interprets labels as markup", () => {
    const scene = structuredClone(authoredProcessFixture.scenes[0]);
    scene.visualObjects[0].label = "<script>globalThis.compromised=true</script>";
    const output = renderToStaticMarkup(<SceneStage scene={scene} timeMs={5_000} reducedMotion />);
    expect(output).toContain('data-reduced-motion="true"');
    expect(output).not.toContain("<script>");
    expect(output).toContain("&lt;script&gt;");
  });
});

