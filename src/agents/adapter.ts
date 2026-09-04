/**
 * Shared shape of every house agent adapter (spec §architecture.agents.house).
 *
 * An adapter turns a ViewObject into a MoveSubmission. It never signs —
 * signing is done by the house-agent runner that owns the seat's Ed25519 key
 * (src/crypto/ed25519.ts signEd25519 over the frozen move message from
 * src/rooms/core.ts moveSignMessage).
 */

import type { MoveSubmission, ViewObject } from '../kernel/types.ts';

export interface HouseAdapter {
  /** 'random' | 'mock-llm' | 'anthropic' | ... */
  readonly kind: string;
  readonly agentId: string;
  chooseMove(view: ViewObject): Promise<MoveSubmission>;
}

/** Builds the unsigned submission for answering by index into legal_moves. */
export function submissionByIndex(view: ViewObject, index: number, commentary?: string): MoveSubmission {
  const sub: MoveSubmission = {
    game_id: view.game_id,
    turn_index: view.turn_index,
    move: { index },
  };
  if (commentary !== undefined) sub.commentary = commentary.slice(0, 280);
  return sub;
}

/**
 * The same, plus in-game SPEECH. Without this every house adapter is
 * structurally mute (they can only emit `{ index }`) and a speech game's
 * transcript ships empty.
 *
 * `utterance` is capped at view.speech.limit — the cap for THIS phase, which
 * is what the room and the game will enforce. It is dropped entirely when the
 * view carries no speech channel: a game without meta.speechLimit rejects a
 * submitted utterance outright, and a house seat must never spend a turn
 * discovering that. Empty text is dropped too — index 0 with no words is
 * silence, which is a legal move everywhere, not an empty string to sign.
 */
export function submissionByIndexWithUtterance(
  view: ViewObject,
  index: number,
  utterance: string,
  commentary?: string,
): MoveSubmission {
  const sub = submissionByIndex(view, index, commentary);
  const speech = view.speech;
  if (speech === undefined) return sub;
  const text = utterance.slice(0, Math.max(0, speech.limit));
  if (text.length > 0) sub.utterance = text;
  return sub;
}
