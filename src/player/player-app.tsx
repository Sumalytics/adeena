"use client";

import { Component, type ReactNode } from "react";
import { presentPlayer } from "./present";
import { PlayerScreen } from "./player-screen";
import { EXPERIENCE_UNAVAILABLE, type ExperiencePresentation, type ExperienceRenderer } from "./types";
import { usePlayerSession } from "./use-player-session";

export function PlayerApp({
  manifest,
  presentation,
  renderer,
}: {
  manifest: unknown;
  presentation: ExperiencePresentation;
  renderer: ExperienceRenderer;
}) {
  const { session, begin, choose, replay } = usePlayerSession(manifest);
  const view = presentPlayer(session, presentation);
  return (
    <PlayerBoundary>
      <PlayerScreen view={view} renderer={renderer} onBegin={begin} onChoose={choose} onReplay={replay} />
    </PlayerBoundary>
  );
}

export class PlayerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main id="content">
          <h1>{EXPERIENCE_UNAVAILABLE}</h1>
          <p>Nothing was started, and no information was saved.</p>
        </main>
      );
    }
    return this.props.children;
  }
}
