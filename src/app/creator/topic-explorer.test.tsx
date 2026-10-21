import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TopicExplorer } from "./topic-explorer";

describe("creator topic controls", () => {
  it("asks for a recommendation without generating an experience", () => {
    const html = renderToStaticMarkup(
      <TopicExplorer
        sources={[{ documentVersionId: "22222222-2222-4222-8222-222222222222", filename: "rivers.md", extractionStatus: "complete", rightsStatus: "unverified", byteCount: 128 }]}
      />,
    );
    expect(html).toContain("Recommend a starting topic");
    expect(html).toContain("does not generate a game");
    expect(html).toContain("rivers.md");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Generate preview");
  });
});
