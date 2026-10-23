import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { sharedShelf } from "@adeena/experience-schema";
import { ExperienceActions } from "./experience-actions";
import { ExperienceEditor } from "./experience-editor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
}));

const editor = {
  versionId: "version-1",
  isCurrent: true,
  isProposal: false,
  discarded: false,
  editJobId: null,
  baseVersionId: null,
  summary: null,
  uncertainty: null,
  reviewNote: null,
  fixture: true,
  configured: false,
  proposed: sharedShelf,
  original: null,
  currentVersionId: "version-1",
};

describe("Creator preview actions", () => {
  it("keeps Improve and Share closed until the creator requests them", () => {
    const html = renderToStaticMarkup(<ExperienceActions versionId="version-1" editor={editor} />);
    expect(html).toContain("Improve");
    expect(html).toContain("Share");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Choose a supported quick edit");
    expect(html).not.toContain("Publication eligibility");
  });

  it("offers only valid supported instructions in fixture mode", () => {
    const html = renderToStaticMarkup(<ExperienceEditor {...editor} />);
    expect(html).toContain("Choose a supported quick edit");
    expect(html).toContain("Shorten the introduction");
    expect(html).toContain("Clarify wrong-choice feedback");
    expect(html).not.toContain("<textarea");
  });

  it("keeps bounded natural-language editing for configured AI", () => {
    const html = renderToStaticMarkup(<ExperienceEditor {...editor} fixture={false} configured />);
    expect(html).toContain("Describe a bounded change");
    expect(html).toContain("clarify consequences");
    expect(html).toContain("<textarea");
  });

  it("does not render a second rights or approval form in the closed action panel", () => {
    const html = renderToStaticMarkup(<ExperienceActions versionId="version-1" editor={editor} />);
    expect(html).not.toContain("Clear source rights");
    expect(html).not.toContain("Approve this version");
  });
});
