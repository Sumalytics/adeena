import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SourceUpload } from "./source-upload";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

describe("creator upload controls", () => {
  it("describes a private upload that does not generate an experience", () => {
    const html = renderToStaticMarkup(<SourceUpload sources={[]} />);
    expect(html).toContain("Upload a source");
    expect(html).toContain("stored privately");
    expect(html).toContain("does not clear source rights");
    expect(html).toContain("does not generate a game");
    expect(html).toContain("I have permission to use this source");
    expect(html).toContain("Rights are blocked");
    expect(html).not.toContain("Generate preview");
    expect(html).not.toContain("private://");
  });

  it("shows the real processing status and the next action on a source card", () => {
    const html = renderToStaticMarkup(
      <SourceUpload
        sources={[{
          documentVersionId: "22222222-2222-4222-8222-222222222222",
          filename: "rivers.md",
          extractionStatus: "pending",
          rightsStatus: "unverified",
          byteCount: 128,
        }]}
      />,
    );
    expect(html).toContain("rivers.md");
    expect(html).toContain("Processing");
    expect(html).toContain("Rights not verified");
    expect(html).toContain("Next: finish processing a source.");
    expect(html).toContain("Continue processing");
    expect(html).not.toContain("Generate preview");
  });
});
