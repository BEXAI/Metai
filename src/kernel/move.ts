/**
 * The single place a submitted move is resolved into a game move: the
 * `{ index }` / `'#n'` / `parseMove` ladder, followed by the optional
 * `bindUtterance` step for speech games.
 *
 * Both rooms/core.ts (live) and kernel/verify.ts (offline replay) call it.
 * That is the whole point: a room/verifier divergence on move resolution
 * would surface months later as a replay that reports as tampered, and would
 * look exactly like tampering. One implementation, two call sites.
 *
 * FAILURES ARE DISCRIMINATED, NOT FORMATTED. The two call sites word the same
 * failure differently today ('index 3 is out of range: 2 legal moves' in the
 * room vs 'submission index 3 out of range (2 legal moves)' in the verifier),
 * and those strings are load-bearing for the twelve existing games' tests. The
 * helper returns a reason plus the operands; each caller formats its own text
 * verbatim.
 *
 * ONE DELIBERATE BEHAVIOUR CHANGE, recorded here so it is a decision and not
 * a drift: the index check is rooms/core.ts's stricter
 * `Number.isInteger(index) && index >= 0`, not verify.ts's `typeof === 'number'`.
 * A non-integer or negative index (1.5, -1) therefore resolves to
 * `bad_index_type` rather than falling through to an out-of-range lookup, so
 * verify.ts's message for that (unreachable-in-practice, tamper-only) case
 * changes from its out-of-range string to its bad-shape string. The room is
 * byte-identical.
 *
 * The branch ORDER is also rooms/core.ts's (`typeof move === 'object' && !== null`
 * first, so an ARRAY is a bad index rather than a bad shape) rather than
 * verify.ts's asObj-first order. That choice keeps BOTH call sites' messages
 * for an array move exactly as they are today, because verify.ts formats
 * `bad_index_type` with the same bad-shape string asObj would have produced.
 */

import { isParseError, type AnyGame, type Json, type PlayerId } from './types.ts';

/**
 * The submission fields this helper reads. Deliberately `unknown`: the room
 * passes a validated MoveSubmission, the verifier passes an untrusted log
 * payload, and every shape check lives here so both get the same answer.
 */
export interface SubmittedMove {
  move: unknown;
  utterance?: unknown;
}

export type ResolveOk = { ok: true; move: Json };

export type ResolveFail = {
  ok: false;
  reason: 'bad_index_type' | 'index_out_of_range' | 'bad_move_shape' | 'parse_error';
  /** How the index was supplied: `{ index: n }` or the `'#n'` notation fallback. */
  via?: 'index' | 'hash';
  index?: number;
  legalCount?: number;
  notation?: string;
  parseMessage?: string;
};

export type ResolveResult = ResolveOk | ResolveFail;

export function resolveSubmittedMove(
  game: AnyGame,
  state: Json,
  player: PlayerId,
  submission: SubmittedMove,
): ResolveResult {
  const raw = submission.move;
  let move: Json;

  if (typeof raw === 'object' && raw !== null) {
    const index = (raw as { index?: unknown }).index;
    if (!Number.isInteger(index) || (index as number) < 0) {
      return { ok: false, reason: 'bad_index_type', via: 'index' };
    }
    const legal = game.legalMoves(state, player);
    const chosen = legal[index as number];
    if (chosen === undefined) {
      return {
        ok: false,
        reason: 'index_out_of_range',
        via: 'index',
        index: index as number,
        legalCount: legal.length,
      };
    }
    move = chosen;
  } else if (typeof raw === 'string') {
    // Kernel-level index fallback (the frozen rule): '#7' means legal_moves[7]
    // in the game's canonical legalMoves order.
    const hash = /^#(\d+)$/.exec(raw.trim());
    if (hash) {
      const index = Number(hash[1]);
      const legal = game.legalMoves(state, player);
      const chosen = legal[index];
      if (chosen === undefined) {
        return { ok: false, reason: 'index_out_of_range', via: 'hash', index, legalCount: legal.length };
      }
      move = chosen;
    } else {
      const parsed = game.parseMove(raw, state, player);
      if (isParseError(parsed)) {
        return { ok: false, reason: 'parse_error', notation: raw, parseMessage: parsed.message };
      }
      move = parsed;
    }
  } else {
    return { ok: false, reason: 'bad_move_shape' };
  }

  // Speech games only. Absent hook (every board game) => byte-identical result.
  // The binder is TOTAL and PURE; legality of the bound text is still apply()'s
  // job. Never reached on the forced or timeout paths, which do not go through
  // a submission at all.
  if (game.bindUtterance && typeof submission.utterance === 'string' && submission.utterance.length > 0) {
    move = game.bindUtterance(move, submission.utterance, state, player);
  }
  return { ok: true, move };
}
