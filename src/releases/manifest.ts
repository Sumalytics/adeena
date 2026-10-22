import { parseManifest, type ExperienceManifest } from "@adeena/experience-schema";
import { limitedSensitivityMatch } from "@/topic/analyze";
import { ReleaseError } from "./contract";

/** Preserve gameplay; private provenance stays on the referenced immutable version. */
export function publicReleaseManifest(input: unknown, releaseId: string): ExperienceManifest {
  const parsed = parseManifest(input);
  if (!parsed.ok) throw new ReleaseError("publication-denied");
  const manifest = parsed.manifest;
  const text = [manifest.title, ...manifest.scenes.flatMap((scene) => [
    scene.title, scene.text, ...(scene.role === "dialogue" ? scene.choices.map((choice) => choice.text) : []),
  ])].join("\n");
  if (limitedSensitivityMatch(text) || /private:\/\/|https?:\/\/|postgres(?:ql)?:\/\//i.test(text)) {
    throw new ReleaseError("publication-denied");
  }
  // This MVP uses bundled/synthetic visuals only, never private or signed asset URLs.
  if (manifest.assets.some((asset) => !asset.locator.startsWith("synthetic:"))) {
    throw new ReleaseError("publication-denied");
  }
  const publicManifest = parseManifest({
    ...manifest,
    experienceId: releaseId,
    versionId: releaseId,
    assets: manifest.assets.map((asset) => ({ ...asset, locator: `synthetic:public-${asset.id}` })),
    sources: [{ sourceId: releaseId, locator: "synthetic:reviewed-source", note: "Source provenance is retained privately by the publisher." }],
  });
  if (!publicManifest.ok) throw new ReleaseError("publication-denied");
  return publicManifest.manifest;
}
