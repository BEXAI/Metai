/**
 * Chinese checkers notation. Moves ARE canonical notation strings:
 *   step        'm3-l4'   (adjacent hole)
 *   jump chain  'd5-f7-h9' (every hop jumps one adjacent peg; may stop anywhere)
 *   pass        'pass'    (only when no other move exists)
 *
 * parseMove validates the submitted path hop by hop against the current board
 * and then CANONICALIZES a jump chain to the enumerated representative with
 * the same origin and endpoint (the legal list dedupes chains by endpoint,
 * keeping the BFS-shortest path). apply() only accepts canonical strings, so
 * agents may submit any physically valid chain and it will still match.
 */

import { seatIndex, type ParseError } from '../../kernel/types.ts';
import type { PlayerId } from '../../kernel/types.ts';
import { DIRS, enumerateCc, holeAt, holeIndex, HOLES, isStepMove, type CcMove, type CcState } from './rules.ts';

function bad(input: string, why: string): ParseError {
  return {
    parseError: true,
    message: `'${input}' is not chinese-checkers notation (${why}); expected 'm3-l4', a jump chain like 'd5-f7-h9', or 'pass'`,
  };
}

export function parseCcMove(input: string, state: CcState, player: PlayerId): CcMove | ParseError {
  const s = input.trim().toLowerCase();
  if (s === 'pass') return 'pass';

  const labels = s.split('-');
  if (labels.length < 2) return bad(input, 'a move needs an origin and a destination');
  const idxs: number[] = [];
  for (const label of labels) {
    const idx = holeIndex(label);
    if (idx === undefined) return bad(input, `'${label}' is not a hole on the star`);
    idxs.push(idx);
  }

  // A plain step: exactly two adjacent holes.
  if (idxs.length === 2 && isStepMove(s)) return s;

  // Otherwise every hop must be a jump: 2x a direction, over an occupied
  // adjacent hole, landing empty (the origin counts as empty once left).
  const origin = idxs[0]!;
  for (let i = 0; i + 1 < idxs.length; i++) {
    const a = HOLES[idxs[i]!]!;
    const b = HOLES[idxs[i + 1]!]!;
    const dc = b.c - a.c;
    const dr = b.r - a.r;
    const dir = DIRS.find(([xc, xr]) => 2 * xc === dc && 2 * xr === dr);
    if (!dir) return bad(input, `${a.label}-${b.label} is neither a step nor a jump`);
    const mid = holeAt(a.c + dir[0], a.r + dir[1]);
    if (mid === undefined || mid === origin || state.board[mid] === '.') {
      return bad(input, `${a.label}-${b.label} does not jump over a peg`);
    }
    if (idxs[i + 1]! !== origin && state.board[idxs[i + 1]!] !== '.') {
      return bad(input, `${b.label} is occupied`);
    }
  }
  const endpoint = idxs[idxs.length - 1]!;
  if (endpoint === origin) return bad(input, 'a chain may not end on its origin');

  // Canonicalize to the enumerated representative with the same origin+endpoint.
  const fromLabel = labels[0]!;
  const endLabel = HOLES[endpoint]!.label;
  const canonical = enumerateCc(state, seatIndex(player)).find((m) => {
    if (m === 'pass') return false;
    const parts = m.split('-');
    return parts[0] === fromLabel && parts[parts.length - 1] === endLabel;
  });
  // A valid path whose endpoint is not legal (e.g. re-enters the start
  // triangle) parses to itself; apply() will reject it with the rule reason.
  return canonical ?? s;
}

export function ccMoveSummary(move: CcMove, _state: CcState): string {
  if (move === 'pass') return 'passes (no legal move)';
  const labels = move.split('-');
  if (isStepMove(move)) return `steps ${labels[0]!} to ${labels[1]!}`;
  return `jump chain of ${labels.length - 1} to ${labels[labels.length - 1]!}`;
}
