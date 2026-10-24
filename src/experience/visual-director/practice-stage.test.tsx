import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { authoredProcessFixture, authoredTwoSetFixture } from "./fixtures";
import { PracticeStage } from "./practice-stage";

describe("Visual Director practice presentation", () => {
  it("offers keyboard and touch-friendly sequence controls", () => {
    const output = renderToStaticMarkup(<PracticeStage scene={authoredProcessFixture.scenes[0]} reducedMotion={false} onWatchAgain={() => undefined} />);
    expect(output).toContain("Current sequence");
    expect(output).toContain("Move Trachea earlier");
    expect(output).toContain("Move Trachea later");
    expect(output).toContain("Check answer");
  });

  it("offers a non-drag region placement flow and reduced-motion state", () => {
    const output = renderToStaticMarkup(<PracticeStage scene={authoredTwoSetFixture.scenes[0]} reducedMotion onWatchAgain={() => undefined} />);
    expect(output).toContain('data-kind="region-classification"');
    expect(output).toContain('data-reduced-motion="true"');
    expect(output).toContain("dragging is not required");
    expect(output).toContain("First set only");
    expect(output).toContain(">12<");
  });
});

