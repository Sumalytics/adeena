import {
  createGame,
  createInitialState,
  openingFacts,
  transition,
  type RejectionReason,
} from "@adeena/player-core";
import { EXPERIENCE_UNAVAILABLE, type PlayerController, type PlayerSession } from "./types";

function unavailable(): PlayerSession {
  return {
    phase: "unavailable",
    started: false,
    game: null,
    state: null,
    facts: [],
    previousVariables: null,
    notice: EXPERIENCE_UNAVAILABLE,
    busy: false,
  };
}

function rejectionNotice(reason: RejectionReason): string {
  if (reason === "INVALID_ACTION") return "That choice is not available.";
  if (reason === "ALREADY_COMPLETED") return "This experience is already finished.";
  return "That choice could not be completed.";
}

export function openSession(input: unknown): PlayerSession {
  try {
    const created = createGame(input);
    if (!created.ok) return unavailable();
    const state = createInitialState(created.game);
    return {
      phase: state.status === "completed" ? "completed" : "playing",
      started: false,
      game: created.game,
      state,
      facts: openingFacts(created.game, state),
      previousVariables: null,
      notice: null,
      busy: false,
    };
  } catch {
    return unavailable();
  }
}

export function revealScene(session: PlayerSession): PlayerSession {
  if (session.phase === "unavailable" || session.started) return session;
  return { ...session, started: true };
}

export function applyChoice(session: PlayerSession, choiceId: string): PlayerSession {
  if (!session.game || !session.state || session.phase !== "playing") return session;
  const result = transition(session.game, session.state, { type: "choose", choiceId });
  if (!result.accepted) {
    return { ...session, notice: rejectionNotice(result.reason) };
  }
  return {
    ...session,
    phase: result.state.status === "completed" ? "completed" : "playing",
    state: result.state,
    facts: [...session.facts, ...result.facts],
    previousVariables: session.state.variables,
    notice: null,
  };
}

export function applyRestart(session: PlayerSession): PlayerSession {
  if (!session.game || !session.state || session.phase === "unavailable") return session;
  const result = transition(session.game, session.state, { type: "restart" });
  if (!result.accepted) {
    return { ...session, notice: "The experience could not be started again." };
  }
  return {
    phase: result.state.status === "completed" ? "completed" : "playing",
    started: false,
    game: session.game,
    state: result.state,
    facts: result.facts,
    previousVariables: null,
    notice: null,
    busy: false,
  };
}

export function createPlayerController(input: unknown): PlayerController {
  let session = openSession(input);
  let locked = false;

  return {
    snapshot() {
      return session;
    },
    beginPlay() {
      session = revealScene(session);
      return session;
    },
    beginChoice(choiceId: string) {
      if (locked || session.busy || !session.started || session.phase !== "playing") return session;
      locked = true;
      session = { ...applyChoice(session, choiceId), busy: true };
      return session;
    },
    beginRestart() {
      if (locked || session.busy || session.phase === "unavailable") return session;
      locked = true;
      session = { ...applyRestart(session), busy: true };
      return session;
    },
    settle() {
      if (!locked && !session.busy) return session;
      locked = false;
      session = { ...session, busy: false };
      return session;
    },
    dispose() {
      locked = false;
      if (session.busy) session = { ...session, busy: false };
    },
  };
}
