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
