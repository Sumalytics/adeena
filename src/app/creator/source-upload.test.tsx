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
});
