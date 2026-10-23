import type { CSSProperties, ReactNode } from "react";
import styles from "./player.module.css";
import type { ExperienceRenderer, SceneVisualProps } from "./types";

function visualTone(sceneId: string) {
  let value = 0;
  for (const character of sceneId) value = (value * 31 + character.charCodeAt(0)) % 3;
  return String(value);
}

export function FallbackSceneVisual({ sceneId, title, description, decorative, choices = [], variables = {}, completed = false, revision = 0 }: SceneVisualProps) {
  const level = Math.max(0, ...Object.values(variables).filter((value) => Number.isFinite(value)));
  const style = { "--story-level": String(Math.min(2, level)), "--story-revision": revision } as CSSProperties;
  return (
    <div
      className={styles.storyVisual}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : description ? `${title}. ${description}` : title}
      aria-hidden={decorative ? true : undefined}
      data-tone={visualTone(sceneId)}
      data-completed={completed ? "true" : "false"}
      style={style}
    >
      <div className={styles.storySky} />
      <div className={styles.storyGlow} />
      <div className={styles.storyStars} aria-hidden="true">
        <i /><i /><i /><i />
      </div>
      <div className={styles.storySet} aria-hidden="true">
        <span className={styles.storyPanel} />
        <span className={styles.storyArch} />
        <span className={styles.storyPropLeft} />
        <span className={styles.storyPropRight} />
      </div>
      <div className={styles.storyCharacter} aria-hidden="true">
        <span className={styles.storyHair} />
        <span className={styles.storyFace}><i /><i /><b /></span>
        <span className={styles.storyBody} />
        <span className={styles.storyArmLeft} />
        <span className={styles.storyArmRight} />
      </div>
      <div className={styles.storyChoices} aria-hidden="true">
        {choices.slice(0, 3).map((choice, index) => <span key={choice.id} style={{ "--choice-index": index } as CSSProperties} />)}
      </div>
      <p className={styles.storyLabel}>{completed ? "Outcome revealed" : choices.length > 0 ? "Your choice shapes the story" : "A new story begins"}</p>
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
