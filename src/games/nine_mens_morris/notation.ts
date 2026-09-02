/**
 * Nine Men's Morris notation. Moves ARE their canonical notation strings:
 *   place            'd1'
 *   place + removal  'd1xd6'
 *   slide/fly        'd1-d2'
 *   slide + removal  'd1-d2xd6'
 * parseMove validates the syntax and that every label is a real point;
 * legality (occupancy, adjacency, mill/removal correctness) is enforced by
 * apply against the enumerated legal list.
 */

import type { ParseError } from '../../kernel/types.ts';
import { pointIndex, SYMBOLS, type NmmMove, type NmmState } from './rules.ts';

const SHAPE = /^([a-g][1-7])(?:-([a-g][1-7]))?(?:x([a-g][1-7]))?$/;

export function parseNmmMove(input: string, _state: NmmState): NmmMove | ParseError {
  const s = input.trim().toLowerCase();
  const m = SHAPE.exec(s);
  const bad = (why: string): ParseError => ({
    parseError: true,
    message: `'${input}' is not morris notation (${why}); expected 'd1', 'd1xd6', 'd1-d2' or 'd1-d2xd6'`,
  });
  if (!m) return bad('wrong shape');
  for (const label of [m[1], m[2], m[3]]) {
    if (label !== undefined && pointIndex(label) === undefined) {
      return bad(`'${label}' is not a point on the morris board`);
    }
  }
  return s;
}

export function nmmMoveSummary(move: NmmMove, state: NmmState): string {
  const sym = SYMBOLS[state.toMove]!;
  const [movePart, removePart] = move.split('x') as [string, string?];
  const tail = removePart !== undefined ? `, forms a mill and removes ${removePart}` : '';
  if (movePart.includes('-')) {
    const [from, to] = movePart.split('-') as [string, string];
    return `slides ${sym} ${from} to ${to}${tail}`;
  }
  return `places ${sym} at ${movePart}${tail}`;
}
