import type { ReactNode } from "react";
import styles from "./player.module.css";
import type { ExperienceRenderer, SceneVisualProps } from "./types";

export function FallbackSceneVisual({ title }: SceneVisualProps) {
  return (
    <div className={styles.fallback} role="img" aria-label={`No illustration for ${title}`}>
      <p>No illustration for this scene.</p>
    </div>
  );
}

export const cssRenderer: ExperienceRenderer = {
  kind: "css",
  Visual: FallbackSceneVisual,
};

export function createSceneRenderer(
  art: Partial<Record<string, () => ReactNode>>,
): ExperienceRenderer {
  return {
    kind: "css",
    Visual(props) {
      const Art = art[props.sceneId];
      if (!Art || props.missing) return <FallbackSceneVisual {...props} />;
      return (
        <div
          className={styles.visual}
          role={props.decorative ? undefined : "img"}
          aria-label={props.decorative ? undefined : props.description}
          aria-hidden={props.decorative ? true : undefined}
        >
          <Art />
        </div>
      );
    },
  };
}
