/** Drops a second tap until React reconciles the first intent. It does not change game state. */
export function createChoiceLatch() {
  let awaiting = false;
  let destroyed = false;

  return {
    submit(choiceId: string, allowed: ReadonlySet<string>, emit: (choiceId: string) => void) {
      if (destroyed || awaiting || !allowed.has(choiceId)) return false;
      awaiting = true;
      emit(choiceId);
      return true;
    },
    reconcile() {
      awaiting = false;
    },
    destroy() {
      destroyed = true;
      awaiting = false;
    },
  };
}

/** Invalidates an in-flight visual pulse when a newer scene arrives. */
export function createPulseGate() {
  let generation = 0;
  return {
    current: () => generation,
    advance: () => {
      generation += 1;
      return generation;
    },
    isCurrent: (token: number) => token === generation,
  };
}
