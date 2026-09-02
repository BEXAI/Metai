/**
 * UCI move notation (the ONLY notation parseMove accepts; index fallback is
 * kernel-level). Format: from-square + to-square + optional promotion letter,
 * e.g. 'e2e4', 'e1g1' (castling = king two squares), 'e7e8q'.
 */

import { mvFrom, mvPromo, mvTo, sqName } from './rules.ts';

const PROMO_CHARS = 'nbrq'; // piece types N=2, B=3, R=4, Q=5 -> index promo-2

const UCI_RE = /^([a-h][1-8])([a-h][1-8])([nbrq])?$/;

/** Packed move int -> UCI string. */
export function uciOfMove(m: number): string {
  const promo = mvPromo(m);
  return sqName(mvFrom(m)) + sqName(mvTo(m)) + (promo !== 0 ? PROMO_CHARS.charAt(promo - 2) : '');
}

/**
 * Normalizes a UCI string (trim, lowercase). Returns null when the input is
 * not syntactically UCI. Legality is checked separately against legalMoves.
 */
export function normalizeUci(input: string): string | null {
  const s = input.trim().toLowerCase();
  return UCI_RE.test(s) ? s : null;
}
