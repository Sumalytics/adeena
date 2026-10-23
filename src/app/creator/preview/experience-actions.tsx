"use client";

import { useEffect, useRef, useState } from "react";
import styles from "../../auth.module.css";
import studio from "./creator-studio.module.css";
import { ExperienceEditor, type ExperienceEditorProps } from "./experience-editor";
import { ExperienceShare } from "./experience-share";

export function ExperienceActions({ versionId, editor }: { versionId: string; editor: ExperienceEditorProps }) {
  const [panel, setPanel] = useState<"improve" | "share" | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (panel) panelRef.current?.focus();
  }, [panel]);

  function toggle(next: "improve" | "share") {
    setPanel((current) => current === next ? null : next);
  }

  return (
    <section className={studio.actions} aria-label="Creator actions">
      <div className={studio.actionBar}>
        <button className={styles.secondary} type="button" aria-expanded={panel === "improve"} aria-controls="improve-panel" onClick={() => toggle("improve")}>
          {editor.isProposal ? "Review changes" : "Improve"}
        </button>
        <button className={styles.secondary} type="button" aria-expanded={panel === "share"} aria-controls="share-panel" onClick={() => toggle("share")}>
          Share
        </button>
      </div>
      {panel ? (
        <div id={`${panel}-panel`} className={studio.panel} tabIndex={-1} ref={panelRef}>
          {panel === "improve" ? <ExperienceEditor {...editor} /> : <ExperienceShare versionId={versionId} />}
        </div>
      ) : null}
    </section>
  );
}
