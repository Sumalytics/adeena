import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sharedShelf } from "@adeena/experience-schema";
import type { CreatorVisualExperience } from "@/experience/visual-director/association";
import { authoredProcessFixture } from "@/experience/visual-director/fixtures";
import { ExperiencePreview } from "./experience-preview";

const ready: CreatorVisualExperience = {
  status: "ready",
  association: {
    contract: "ADEENA-VISUAL-EXPERIENCE-ASSOCIATION-v1",
    associationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    experienceVersionId: sharedShelf.versionId,
    blueprintHash: "a".repeat(64), rendererVersion: "visual-renderer@1", authoredFixture: true,
    fixtureLabel: "Authored fixture", blueprint: authoredProcessFixture,
    mapping: { contract: "ADEENA-VISUAL-SCENE-MAPPING-v1", legacyExperienceId: sharedShelf.experienceId,
      scenes: [{ visualSceneId: "air-path", legacySceneId: sharedShelf.initialSceneId }],
      choices: [{ visualSceneId: "air-path", visualChoiceId: "airway-order-correct", legacyChoiceId: sharedShelf.scenes.find((scene) => scene.role === "dialogue")!.choices[0].id }] },
  }, narration: [],
};

describe("Creator unified experience preview", () => {
  it("keeps legacy drafts on the existing player when no visual association exists", () => {
    const html = renderToStaticMarkup(<ExperiencePreview manifest={sharedShelf} notice="Private draft" />);
    expect(html).toContain(sharedShelf.title);
    expect(html).not.toContain("Animated learning experience");
  });
  it("renders the associated blueprint and a usable silent fallback without stacking the legacy player", () => {
    const html = renderToStaticMarkup(<ExperiencePreview manifest={sharedShelf} notice="Private draft" visual={ready} />);
    expect(html).toContain("Animated learning experience");
    expect(html).toContain("Narration is not available for every segment");
    expect(html).toContain("Breathing moves air into and out of the lungs");
    expect(html).not.toContain("Choose a path and see what happens");
  });
  it("shows a recoverable state for an unsupported renderer", () => {
    const visual: CreatorVisualExperience = { status: "unsupported", message: "This animation needs a newer renderer." };
    const html = renderToStaticMarkup(<ExperiencePreview manifest={sharedShelf} notice="Private draft" visual={visual} />);
    expect(html).toContain("needs a newer renderer");
    expect(html).toContain("Open original playable draft");
    expect(html).not.toContain("Animated learning experience");
  });
});
