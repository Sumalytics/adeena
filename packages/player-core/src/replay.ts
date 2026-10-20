import { createInitialState, openingFacts, transition } from "./engine";
import type { GameAction, PlayableGame, ReplayResult, RuntimeFact } from "./types";

/** Same manifest and action order always rebuild the same state and fact log. */
export function replay(game: PlayableGame, actions: readonly GameAction[]): ReplayResult {
  let state = createInitialState(game);
  const facts: RuntimeFact[] = [];
  const push = (batch: readonly RuntimeFact[]) => {
    for (const event of batch) {
      facts.push({ ...event, sequence: facts.length });
    }
  };
  push(openingFacts(game, state));
  for (const action of actions) {
    const result = transition(game, state, action);
    if (result.accepted) push(result.facts);
    state = result.state;
  }
  return { state, facts };
}
