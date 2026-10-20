"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPlayerController } from "./session";
import type { PlayerSession } from "./types";

export function usePlayerSession(manifest: unknown) {
  const [{ controller, initial }] = useState(() => {
    const created = createPlayerController(manifest);
    return { controller: created, initial: created.snapshot() };
  });
  const [session, setSession] = useState<PlayerSession>(initial);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.dispose();
    };
  }, [controller]);

  const publish = useCallback(
    (next: PlayerSession) => {
      setSession(next);
      if (!next.busy) return;
      queueMicrotask(() => {
        if (!mounted.current) return;
        setSession(controller.settle());
      });
    },
    [controller],
  );

  const begin = useCallback(() => {
    publish(controller.beginPlay());
  }, [controller, publish]);

  const choose = useCallback(
    (choiceId: string) => {
      publish(controller.beginChoice(choiceId));
    },
    [controller, publish],
  );

  const replay = useCallback(() => {
    publish(controller.beginRestart());
  }, [controller, publish]);

  return { session, begin, choose, replay };
}
