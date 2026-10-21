import type { ExperienceManifest } from "@adeena/experience-schema";
import type { ExperiencePresentation } from "@/player/types";

export function draftPresentation(manifest: ExperienceManifest, notice: string): ExperiencePresentation {
  const scenes: Record<string, { description: string; decorative: boolean }> = {};
  for (const scene of manifest.scenes) {
    scenes[scene.id] = { description: scene.title, decorative: true };
  }
  return {
    intro: notice,
    variables: manifest.state.variables.map((variable) => ({
      id: variable.id,
      label: variable.id === "understanding" ? "Source use" : "Progress",
      changeText(before, after) {
        if (after === before) return "The source note stayed as it was.";
        if (after > before) return "You used more of the source note.";
        return "You left the source note.";
      },
    })),
    scenes,
  };
}
