"use client";

import { useEffect, useRef, useState } from "react";
import styles from "@/player/player.module.css";
import { FallbackSceneVisual } from "@/player/renderer";
import type { SceneVisualProps } from "@/player/types";
import { createShelfAdapter, type ShelfAdapter } from "./adapter";

const LOAD_TIMEOUT_MS = 8000;

export function PhaserShelfVisual({
  onUnavailable,
  ...props
}: SceneVisualProps & { onUnavailable?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<ShelfAdapter | null>(null);
  const onChooseRef = useRef(props.onChoose);
  const unavailableRef = useRef(onUnavailable);
  const [failed, setFailed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    onChooseRef.current = props.onChoose;
    unavailableRef.current = onUnavailable;
  });

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    let alive = true;
    const adapter = createShelfAdapter({
      onIntent(intent) {
        if (!alive) return;
        onChooseRef.current?.(intent.choiceId);
      },
    });
    adapterRef.current = adapter;
    const timeout = window.setTimeout(() => {
      if (!alive || adapter.ready) return;
      adapter.destroy();
      setFailed(true);
      unavailableRef.current?.();
    }, LOAD_TIMEOUT_MS);
    adapter.mount(node).then(
      () => {
        if (!alive) adapter.destroy();
      },
      () => {
        if (!alive) return;
        adapter.destroy();
        setFailed(true);
        unavailableRef.current?.();
      },
    );
    return () => {
      alive = false;
      window.clearTimeout(timeout);
      adapter.destroy();
      if (adapterRef.current === adapter) adapterRef.current = null;
    };
  }, []);

  useEffect(() => {
    adapterRef.current?.render({
      sceneId: props.sceneId,
      choices: props.choices ?? [],
      variables: props.variables ?? {},
      completed: props.completed === true,
      reducedMotion,
      revision: props.revision ?? 0,
    });
  }, [props.sceneId, props.choices, props.variables, props.completed, props.revision, reducedMotion]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReducedMotion(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const choiceId = target.closest("[data-choice]")?.getAttribute("data-choice") ?? null;
      adapterRef.current?.setFocusedChoice(choiceId);
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);

  if (failed) return <FallbackSceneVisual {...props} />;

  return (
    <div>
      <p className={styles.worldCaption}>{props.missing ? `No illustration for ${props.title}` : props.description}</p>
      <div ref={hostRef} className={styles.world} aria-hidden="true" data-reduced-motion={reducedMotion ? "true" : "false"} data-engine="local-script" />
    </div>
  );
}
