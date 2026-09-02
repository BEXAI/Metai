/**
 * Dropline notation: a single column letter 'a'..'g' (a = leftmost column).
 */

import type { ParseError } from '../../kernel/types.ts';

export function columnIndex(letter: string): number {
  return letter.charCodeAt(0) - 97;
}

export function columnLetter(index: number): string {
  return String.fromCharCode(97 + index);
}

export function parseDropMove(input: string): string | ParseError {
  const t = input.trim().toLowerCase();
  if (!/^[a-g]$/.test(t)) {
    return { parseError: true, message: `unrecognized move '${input}' (want a column letter a..g)` };
  }
  return t;
}
