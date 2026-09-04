/**
 * The house 'random' baseline agent: picks uniformly from view.legal_moves
 * using its own deterministic SeedStream, seeded from
 * sha256(agent_id + game_id). Two instances created with the same ids and fed
 * the same sequence of views choose identical moves — useful as the baseline
 * opponent and for reproducible e2e matches.
 *
 * Seed-draw purposes: `random:turn:<turn_index>` (per-purpose counters make
 * repeat asks on the same turn — e.g. after a rejection — advance rather than
 * repeat).
 *
 * IT NEVER SPEAKS, and it must never backfill a seat in a speech game. Uniform
 * choice over legal_moves is not merely mute there: in werewolf it would
 * claim(seer) and report(pN, wolf) at random, which does not add noise to the
 * information channel — it destroys the one the real seer needs. The roster
 * filter that keeps it out of those queues lives in the pairer, not here.
 */

import { sha256Hex } from '../crypto/canonical.ts';
import { createSeedStream } from '../kernel/seed.ts';
import type { SeedStream, ViewObject } from '../kernel/types.ts';
import { submissionByIndex, type HouseAdapter } from './adapter.ts';

export function createRandomAgent(agentId: string, gameId: string): HouseAdapter {
  const seed: SeedStream = createSeedStream(sha256Hex(agentId + gameId));
  return {
    kind: 'random',
    agentId,
    // eslint-disable-next-line @typescript-eslint/require-await
    async chooseMove(view: ViewObject) {
      const n = view.legal_moves.length;
      if (n === 0) throw new Error(`random agent ${agentId}: view carries no legal moves`);
      const pick = seed.int(`random:turn:${view.turn_index}`, n);
      return submissionByIndex(view, pick);
    },
  };
}
