/**
 * Go coordinates: column letter (skipping 'I') + row number, row 1 at the
 * bottom. 'A1' is the bottom-left corner; 'T19' the top-right on 19x19.
 * Lowercase accepted on input; canonical output is uppercase. 'pass' passes.
 */

import type { ParseError } from '../../kernel/types.ts';
import type { GoMove } from './rules.ts';

/** 19 column letters, 'I' skipped (standard Go convention). */
export const GO_LETTERS = 'ABCDEFGHJKLMNOPQRST';

export function colLetter(col: number): string {
  const l = GO_LETTERS[col];
  if (l === undefined) throw new Error(`go: column index ${col} out of range`);
  return l;
}

export function pointToNotation(col: number, row: number): string {
  return colLetter(col) + String(row + 1);
}

export function goMoveToNotation(move: GoMove): string {
  return move.pass ? 'pass' : pointToNotation(move.col, move.row);
}

function perr(message: string): ParseError {
  return { parseError: true, message };
}

export function parseGoMove(input: string, size: number): GoMove | ParseError {
  const s = input.trim();
  if (/^pass$/i.test(s)) return { pass: true };
  const m = /^([A-Za-z])([0-9]{1,2})$/.exec(s);
  if (!m) {
    return perr(`expected a coordinate like 'E5' (column letter, no 'I', + row number) or 'pass'; got ${JSON.stringify(input)}`);
  }
  const letter = m[1]!.toUpperCase();
  const col = GO_LETTERS.indexOf(letter);
  if (col === -1 || col >= size) {
    return perr(`column '${letter}' is not on this ${size}x${size} board (columns ${GO_LETTERS.slice(0, size)}; the letter 'I' is skipped)`);
  }
  const row = Number(m[2]!) - 1;
  if (row < 0 || row >= size) {
    return perr(`row ${m[2]!} is off the ${size}x${size} board (rows 1..${size})`);
  }
  return { pass: false, col, row };
}
