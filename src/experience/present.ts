import type { ExperienceManifest } from "@adeena/experience-schema";
import type { ExperiencePresentation } from "@/player/types";

export function draftPresentation(manifest: ExperienceManifest, notice: string): ExperiencePresentation {
  const scenes: Record<string, { description: string; decorative: boolean }> = {};
  for (const scene of manifest.scenes) {
    scenes[scene.id] = { description: scene.title, decorative: true };
  }
  return {
    intro: notice,
    // The compiler's internal state supports branching and simulation. It is
    // not presented as a learning score; learner-visible consequences come
    // from the authored scenes and choice history.
    variables: [],
    scenes,
  };
}
