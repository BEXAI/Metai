/**
 * Hex notation: cell labels 'a1'..'m13' (lowercased on input) plus 'swap'.
 * Moves ARE their notation strings, so moveToNotation is the identity.
 */

import type { ParseError } from '../../kernel/types.ts';
import { parseCell, type HexMove, type HexState } from './rules.ts';

export function parseHexMove(input: string, state: HexState): HexMove | ParseError {
  const s = input.trim().toLowerCase();
  if (s === 'swap') return 'swap';
  const cell = parseCell(s, state.size);
  if (!cell) {
    return {
      parseError: true,
      message: `'${input}' is not hex notation: expected a cell like 'f6' (columns a-${String.fromCharCode(96 + state.size)}, rows 1-${state.size}) or 'swap'`,
    };
  }
  return s;
}

export function hexMoveSummary(move: HexMove, state: HexState): string {
  if (move === 'swap') return 'invokes the pie rule: takes over the first stone in place';
  const stone = state.toMove === 0 ? 'X' : 'O';
  return `places an ${stone} stone at ${move}`;
}
