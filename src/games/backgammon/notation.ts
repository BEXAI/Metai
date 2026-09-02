/**
 * Backgammon move notation (mover-perspective point numbers).
 *
 * Emitted canonical form: hop groups sorted bar-first then by from/to
 * descending, identical hops grouped with a count — '24/18 13/11',
 * 'bar/22', '6/off', '13/11(2) 6/4(2)', hits marked '24/18*'. A blocked
 * turn is '(no play)'.
 *
 * parseMove accepts: the compact parenthesized form, the fully expanded form
 * ('13/11 13/11 6/4 6/4'), single-checker runs ('24/18/13', adjacent pairs),
 * '*' hit markers (ignored — recomputed), commas or whitespace between hops,
 * and '(no play)' / 'no play' / 'dance' / 'pass' for the blocked turn.
 * Matching is by the (from,to) multiset against the enumerated legal turns,
 * so die assignment never has to be spelled out.
 */

import { seatIndex, type ParseError, type PlayerId } from '../../kernel/types.ts';
import {
  BAR,
  OFF,
  hopMultisetKey,
  legalTurns,
  simulateTurn,
  terminalResult,
  type BgMove,
  type BgState,
  type Hop,
} from './rules.ts';

const NO_PLAY = '(no play)';

function endpoint(n: number): string {
  if (n === BAR) return 'bar';
  if (n === OFF) return 'off';
  return String(n);
}

/** Canonical compact notation for a turn in the given (pre-move) state. */
export function turnNotation(move: BgMove, state: BgState): string {
  if (move.hops.length === 0) return NO_PLAY;

  // Hit markers come from strict simulation; if the move does not fit the
  // state (should not happen for legal moves) render without markers.
  let hits: boolean[] = move.hops.map(() => false);
  const sim = simulateTurn(state, move.hops);
  if (typeof sim !== 'string') hits = sim.hits;

  type G = { from: number; to: number; count: number; hit: boolean };
  const groups = new Map<string, G>();
  move.hops.forEach((h, i) => {
    const key = `${h.from}/${h.to}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.hit = g.hit || hits[i] === true;
    } else {
      groups.set(key, { from: h.from, to: h.to, count: 1, hit: hits[i] === true });
    }
  });

  return [...groups.values()]
    .sort((a, b) => b.from - a.from || a.to - b.to)
    .map((g) => {
      let s = `${endpoint(g.from)}/${endpoint(g.to)}`;
      if (g.hit) s += '*';
      if (g.count > 1) s += `(${g.count})`;
      return s;
    })
    .join(' ');
}

/** One short human line for the feed/history. */
export function turnSummary(move: BgMove, state: BgState): string {
  if (move.hops.length === 0) return 'cannot play — dances';
  const sim = simulateTurn(state, move.hops);
  const nHits = typeof sim === 'string' ? 0 : sim.hits.filter(Boolean).length;
  const nOff = move.hops.filter((h) => h.to === OFF).length;
  const enters = move.hops.filter((h) => h.from === BAR).length;
  const bits: string[] = [`plays ${turnNotation(move, state)}`];
  if (enters > 0) bits.push(`entering ${enters} from the bar`);
  if (nHits > 0) bits.push(`hitting ${nHits} blot${nHits > 1 ? 's' : ''}`);
  if (nOff > 0) bits.push(`bearing off ${nOff}`);
  return bits.join(', ');
}

/** (from,to) pairs of one notation token, expanded; null on syntax error. */
function parseToken(token: string): { from: number; to: number }[] | null {
  let t = token.replace(/\*/g, '');
  let count = 1;
  const m = /^(.*?)\((\d+)\)$/.exec(t);
  if (m) {
    t = m[1]!;
    count = Number(m[2]);
    if (!Number.isInteger(count) || count < 1 || count > 15) return null;
  }
  const parts = t.split('/');
  if (parts.length < 2) return null;
  const nums: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!.trim().toLowerCase();
    if (p === 'bar') {
      if (i !== 0) return null;
      nums.push(BAR);
    } else if (p === 'off') {
      if (i !== parts.length - 1) return null;
      nums.push(OFF);
    } else {
      if (!/^\d{1,2}$/.test(p)) return null;
      const n = Number(p);
      if (n < 1 || n > 24) return null;
      nums.push(n);
    }
  }
  const pairs: { from: number; to: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i++) {
    const from = nums[i]!;
    const to = nums[i + 1]!;
    if (to >= from) return null; // checkers always move toward 0
    pairs.push({ from, to });
  }
  const out: { from: number; to: number }[] = [];
  for (let c = 0; c < count; c++) out.push(...pairs);
  return out;
}

/** Parses the game's notation into the matching enumerated legal turn. */
export function parseTurn(input: string, state: BgState, player: PlayerId): BgMove | ParseError {
  const seat = seatIndex(player);
  if (terminalResult(state) !== null || seat !== state.turn) {
    return { parseError: true, message: `it is not ${player}'s turn` };
  }

  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase().replace(/[()\s]/g, '');
  const legal = legalTurns(state);

  if (normalized === 'noplay' || normalized === 'dance' || normalized === 'pass') {
    const dance = legal.find((mv) => mv.hops.length === 0);
    if (dance) return dance;
    return { parseError: true, message: 'you have playable dice — (no play) is not legal here' };
  }

  const tokens = trimmed.split(/[\s,]+/).filter((s) => s.length > 0);
  if (tokens.length === 0) return { parseError: true, message: 'empty move' };
  const pairs: { from: number; to: number }[] = [];
  for (const token of tokens) {
    const parsed = parseToken(token);
    if (parsed === null) {
      return {
        parseError: true,
        message: `cannot parse '${token}' — expected hops like 24/18, bar/22, 6/off, 13/11(2)`,
      };
    }
    pairs.push(...parsed);
  }

  const wanted = hopMultisetKey(pairs.map((p): Hop => ({ from: p.from, to: p.to, die: 1 })));
  for (const mv of legal) {
    if (hopMultisetKey(mv.hops) === wanted) return mv;
  }
  return {
    parseError: true,
    message: `'${trimmed}' is not a complete legal turn for dice ${state.dice.join(' ')} (you must use as many dice as possible, larger die first when only one plays; bar checkers enter first)`,
  };
}
