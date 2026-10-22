"use client";

import { useEffect, useState } from "react";
import { parseManifest, type ExperienceManifest } from "@adeena/experience-schema";
import { draftPresentation } from "@/experience/present";
import { PlayerApp } from "@/player/player-app";
import { cssRenderer } from "@/player/renderer";
import { EXPERIENCE_UNAVAILABLE } from "@/player/types";

export function ReleasePlayer({ releaseId }: { releaseId: string }) {
  const [state, setState] = useState<{ status: "loading" | "unavailable" | "ready"; manifest?: ExperienceManifest }>({ status: "loading" });
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    let pending: AbortController | undefined;
    async function check(reset = false) {
      const current = ++revision;
      pending?.abort();
      pending = new AbortController();
      if (reset) setState({ status: "loading" });
      try {
        const response = await fetch(`/api/releases/${encodeURIComponent(releaseId)}`, {
          cache: "no-store", credentials: "omit", signal: pending.signal,
        });
        const parsed = parseManifest(response.ok ? (await response.json()).manifest : null);
        if (disposed || current !== revision) return;
        if (!parsed.ok) setState({ status: "unavailable" });
        else setState((previous) => previous.status === "ready" ? previous : { status: "ready", manifest: parsed.manifest });
      } catch {
        if (!disposed && current === revision) setState({ status: "unavailable" });
      }
    }
    function resume() { void check(true); }
    function visibility() {
      if (document.visibilityState === "visible") resume();
      else {
        ++revision;
        pending?.abort();
        setState({ status: "loading" });
      }
    }
    void check();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void check(); }, 15_000);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      pending?.abort();
      clearInterval(timer);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [releaseId]);
  if (state.status === "loading") return <main id="content"><p role="status">Opening experience…</p></main>;
  if (state.status !== "ready" || !state.manifest) return <main id="content"><h1>{EXPERIENCE_UNAVAILABLE}</h1></main>;
  return <PlayerApp manifest={state.manifest} presentation={draftPresentation(state.manifest, "Choose a path and see what happens.")} renderer={cssRenderer} />;
}
