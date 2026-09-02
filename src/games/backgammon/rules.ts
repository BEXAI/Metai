/**
 * Backgammon rules — pure logic, no I/O, all randomness via the SeedStream.
 *
 * Representation
 * --------------
 * - `points` is a 24-entry array of ABSOLUTE points 1..24 (index = point - 1).
 *   Positive counts are p0 checkers, negative counts are p1 checkers.
 * - p0 moves from absolute 24 toward 1 and bears off from 1..6.
 *   p1 moves the other way; p1's relative point r is absolute 25 - r.
 * - All hops inside a move are MOVER-RELATIVE: from 24..1 (25 = bar) down to
 *   to 24..0 (0 = off). A complete legal TURN is one move object: an ordered
 *   list of hops that uses as many dice as the rules allow.
 *
 * Dice flow (documented seed purposes)
 * ------------------------------------
 * - initialState: 'dice:open:a' (p0's opening die), 'dice:open:b' (p1's);
 *   ties re-roll both (the per-purpose counters advance automatically).
 *   The higher roller starts and plays those two dice.
 * - apply: after a turn is applied, the NEXT turn's dice are rolled with two
 *   die() draws on purpose `dice:turn:${nextTurnIndex}` (doubles => 4 dice).
 *
 * Turn legality
 * -------------
 * All maximal hop sequences are enumerated by depth-first search over every
 * ordering; a sequence is complete when no remaining die is playable. Rules:
 * both dice must be used when any ordering allows it (doubles: all four);
 * when only one die can be played and both are individually playable, the
 * LARGER must be played; a player with checkers on the bar must enter them
 * before any other checker moves; bearing off requires every checker home,
 * with overshoot (die > point) allowed only from the highest occupied point.
 *
 * Canonical dedupe (per the build spec): two hop sequences are the SAME turn
 * iff their sorted multiset of (from, to) pairs and their resulting board are
 * identical. Die assignment is intentionally NOT part of the key (e.g. with
 * dice 6-5 and lone checkers on 2 and 1, '2/off 1/off' is one turn no matter
 * which die takes which checker — the final board is identical). Distinct
 * routes to the same board (bar/20 20/17 vs bar/22 22/17) have different
 * (from,to) multisets and stay distinct moves. The kept representative is the
 * first sequence found in DFS order (larger die first, higher points first).
 *
 * Termination: first player with 15 borne off wins. Loser bore off none =>
 * gammon (2 points); additionally a loser checker on the bar or in the
 * winner's home board => backgammon (3 points). A safety turn limit of
 * TURN_LIMIT turns ends the game as a draw ('turn_limit') so random playouts
 * are guaranteed to halt; real games never approach it.
 */

import { hashJson } from '../../crypto/canonical.ts';
import {
  playerId,
  type GameResult,
  type PlayerId,
  type SeedStream,
  type VariantConfig,
} from '../../kernel/types.ts';

export const TURN_LIMIT = 2000;
export const BAR = 25;
export const OFF = 0;

export type Hop = { from: number; to: number; die: number };
export type BgMove = { hops: Hop[] };
export type BgState = {
  /** Absolute points 1..24 (index point-1); + = p0 checkers, - = p1. */
  points: number[];
  /** Checkers on the bar: [p0, p1]. */
  bar: number[];
  /** Checkers borne off: [p0, p1]. */
  off: number[];
  /** Seat to move: 0 | 1 (meaningless once terminal). */
  turn: number;
  /** The current player's rolled dice: 2 values (sorted desc) or 4 for doubles; [] once terminal. */
  dice: number[];
  /** Number of completed turns so far; the dice above belong to turn `turnIndex`. */
  turnIndex: number;
  /** 'p0 24/18 13/11' — last applied turn, for rendering; null before the first. */
  lastMove: string | null;
};

/** Mutable board position used during enumeration/simulation. */
export type Pos = { pts: number[]; bar: number[]; off: number[] };

export function clonePos(s: { points?: number[]; pts?: number[]; bar: number[]; off: number[] }): Pos {
  return {
    pts: (s.pts ?? s.points ?? []).slice(),
    bar: s.bar.slice(),
    off: s.off.slice(),
  };
}

/** Absolute point (1..24) for seat's relative point r (1..24). */
export function absOf(seat: number, r: number): number {
  return seat === 0 ? r : 25 - r;
}

export function myCount(pos: Pos, seat: number, r: number): number {
  const c = pos.pts[absOf(seat, r) - 1] ?? 0;
  return seat === 0 ? Math.max(c, 0) : Math.max(-c, 0);
}

export function theirCount(pos: Pos, seat: number, r: number): number {
  const c = pos.pts[absOf(seat, r) - 1] ?? 0;
  return seat === 0 ? Math.max(-c, 0) : Math.max(c, 0);
}

/** Highest occupied relative point for seat (0 if none on the board). */
function highestPoint(pos: Pos, seat: number): number {
  for (let r = 24; r >= 1; r--) if (myCount(pos, seat, r) > 0) return r;
  return 0;
}

/** All legal single hops for one die value, canonical order (bar, then high points first). */
export function hopsForDie(pos: Pos, seat: number, die: number): Hop[] {
  if ((pos.bar[seat] ?? 0) > 0) {
    const to = BAR - die; // relative 19..24
    if (theirCount(pos, seat, to) <= 1) return [{ from: BAR, to, die }];
    return [];
  }
  const hi = highestPoint(pos, seat);
  const home = hi > 0 && hi <= 6;
  const out: Hop[] = [];
  for (let from = 24; from >= 1; from--) {
    if (myCount(pos, seat, from) === 0) continue;
    const to = from - die;
    if (to >= 1) {
      if (theirCount(pos, seat, to) <= 1) out.push({ from, to, die });
    } else if (home) {
      if (to === 0) out.push({ from, to: OFF, die }); // exact bear-off
      else if (from === hi) out.push({ from, to: OFF, die }); // overshoot only from the highest point
    }
  }
  return out;
}

/** Mutates pos; returns whether the hop hit an opposing blot. */
export function applyHop(pos: Pos, seat: number, hop: Hop): boolean {
  const oppSeat = 1 - seat;
  if (hop.from === BAR) {
    pos.bar[seat] = (pos.bar[seat] ?? 0) - 1;
  } else {
    const a = absOf(seat, hop.from) - 1;
    pos.pts[a] = (pos.pts[a] ?? 0) + (seat === 0 ? -1 : 1);
  }
  if (hop.to === OFF) {
    pos.off[seat] = (pos.off[seat] ?? 0) + 1;
    return false;
  }
  const a = absOf(seat, hop.to) - 1;
  let c = pos.pts[a] ?? 0;
  let hit = false;
  if (seat === 0) {
    if (c === -1) {
      c = 0;
      pos.bar[oppSeat] = (pos.bar[oppSeat] ?? 0) + 1;
      hit = true;
    }
    pos.pts[a] = c + 1;
  } else {
    if (c === 1) {
      c = 0;
      pos.bar[oppSeat] = (pos.bar[oppSeat] ?? 0) + 1;
      hit = true;
    }
    pos.pts[a] = c - 1;
  }
  return hit;
}

function posJson(pos: Pos): { pts: number[]; bar: number[]; off: number[] } {
  return { pts: pos.pts, bar: pos.bar, off: pos.off };
}

/** Sorted (from,to) multiset — die assignment deliberately excluded (see header). */
export function hopMultisetKey(hops: readonly Hop[]): string {
  return hops
    .map((h) => `${h.from}/${h.to}`)
    .sort()
    .join(',');
}

export function turnKey(hops: readonly Hop[], finalPos: Pos): string {
  return `${hopMultisetKey(hops)}#${hashJson(posJson(finalPos))}`;
}

/**
 * Every distinct complete legal turn for the player on roll, in canonical
 * order (sorted by dedupe key), paired with the dedupe key. When nothing is
 * playable the single legal turn is the explicit no-play { hops: [] }.
 */
export function legalTurnsWithKeys(state: BgState): { key: string; move: BgMove }[] {
  const seat = state.turn;
  const seqs: { hops: Hop[]; pos: Pos }[] = [];

  const dfs = (pos: Pos, remaining: number[], hops: Hop[]): void => {
    const tried = new Set<number>();
    let extended = false;
    for (let i = 0; i < remaining.length; i++) {
      const die = remaining[i]!;
      if (tried.has(die)) continue;
      tried.add(die);
      const rest = remaining.slice(0, i).concat(remaining.slice(i + 1));
      for (const hop of hopsForDie(pos, seat, die)) {
        extended = true;
        const next = clonePos(pos);
        applyHop(next, seat, hop);
        dfs(next, rest, hops.concat([hop]));
      }
    }
    if (!extended) seqs.push({ hops, pos });
  };

  dfs(clonePos(state), state.dice.slice(), []);

  let maxLen = 0;
  for (const s of seqs) maxLen = Math.max(maxLen, s.hops.length);
  let kept = seqs.filter((s) => s.hops.length === maxLen);

  // Larger-die rule: only one die playable, both individually playable => larger.
  if (maxLen === 1 && state.dice.length === 2 && state.dice[0] !== state.dice[1]) {
    const larger = Math.max(state.dice[0]!, state.dice[1]!);
    if (kept.some((s) => s.hops[0]!.die === larger)) {
      kept = kept.filter((s) => s.hops[0]!.die === larger);
    }
  }

  if (maxLen === 0) {
    const dance = kept[0]!;
    return [{ key: turnKey([], dance.pos), move: { hops: [] } }];
  }

  const byKey = new Map<string, BgMove>();
  for (const s of kept) {
    const key = turnKey(s.hops, s.pos);
    if (!byKey.has(key)) byKey.set(key, { hops: s.hops });
  }
  return [...byKey.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, move]) => ({ key, move }));
}

/** Every distinct complete legal turn, canonical order. */
export function legalTurns(state: BgState): BgMove[] {
  return legalTurnsWithKeys(state).map((e) => e.move);
}

/**
 * Strictly simulates a submitted hop list against the state's dice/board.
 * Returns the final position and hit flags, or an error message string.
 */
export function simulateTurn(
  state: BgState,
  hops: readonly Hop[],
): { pos: Pos; hits: boolean[] } | string {
  const seat = state.turn;
  const pos = clonePos(state);
  const remaining = state.dice.slice();
  const hits: boolean[] = [];
  for (const hop of hops) {
    if (
      !Number.isInteger(hop.from) ||
      !Number.isInteger(hop.to) ||
      !Number.isInteger(hop.die) ||
      hop.die < 1 ||
      hop.die > 6
    ) {
      return `malformed hop ${JSON.stringify(hop)}`;
    }
    const i = remaining.indexOf(hop.die);
    if (i < 0) return `die ${hop.die} is not available (dice: ${state.dice.join(' ')})`;
    const legal = hopsForDie(pos, seat, hop.die);
    if (!legal.some((h) => h.from === hop.from && h.to === hop.to)) {
      return `illegal hop ${hop.from}/${hop.to === OFF ? 'off' : hop.to} with die ${hop.die}`;
    }
    remaining.splice(i, 1);
    hits.push(applyHop(pos, seat, hop));
  }
  return { pos, hits };
}

/** Standard opening layout in absolute points (p0 positive, p1 negative). */
export function startingPoints(): number[] {
  const pts = new Array<number>(24).fill(0);
  pts[24 - 1] = 2; // p0: 24-point
  pts[13 - 1] = 5;
  pts[8 - 1] = 3;
  pts[6 - 1] = 5;
  pts[1 - 1] = -2; // p1 mirror
  pts[12 - 1] = -5;
  pts[17 - 1] = -3;
  pts[19 - 1] = -5;
  return pts;
}

export function makeInitialState(
  seed: SeedStream,
  players: PlayerId[],
  variant: VariantConfig,
): BgState {
  if (players.length !== 2) {
    throw new Error(`backgammon needs exactly 2 players, got ${players.length}`);
  }
  const cube = variant['cube'] ?? false;
  if (cube !== false) {
    throw new Error("backgammon: the doubling cube variant is declared but not implemented; 'cube' must be false");
  }
  const matchTo = variant['matchTo'] ?? 1;
  if (matchTo !== 1) {
    throw new Error("backgammon: match play is not implemented; 'matchTo' must be 1");
  }

  let a = 0;
  let b = 0;
  do {
    a = seed.die('dice:open:a', 6);
    b = seed.die('dice:open:b', 6);
  } while (a === b);

  return {
    points: startingPoints(),
    bar: [0, 0],
    off: [0, 0],
    turn: a > b ? 0 : 1,
    dice: [Math.max(a, b), Math.min(a, b)],
    turnIndex: 0,
    lastMove: null,
  };
}

/** Pip count for a seat (bar checkers count 25 each). */
export function pipCount(state: BgState, seat: number): number {
  const pos: Pos = { pts: state.points, bar: state.bar, off: state.off };
  let pips = (state.bar[seat] ?? 0) * 25;
  for (let r = 1; r <= 24; r++) pips += myCount(pos, seat, r) * r;
  return pips;
}

export function terminalResult(state: BgState): GameResult | null {
  for (const seat of [0, 1]) {
    if ((state.off[seat] ?? 0) === 15) {
      const loser = 1 - seat;
      const pos: Pos = { pts: state.points, bar: state.bar, off: state.off };
      let mult = 1;
      let reason = 'bearoff';
      if ((state.off[loser] ?? 0) === 0) {
        mult = 2;
        reason = 'gammon';
        // Winner's home board = loser's relative points 19..24.
        let inWinnersHome = false;
        for (let r = 19; r <= 24; r++) if (myCount(pos, loser, r) > 0) inWinnersHome = true;
        if ((state.bar[loser] ?? 0) > 0 || inWinnersHome) {
          mult = 3;
          reason = 'backgammon';
        }
      }
      return {
        winners: [playerId(seat)],
        draw: false,
        scores: { [playerId(seat)]: mult, [playerId(loser)]: 0 },
        reason,
      };
    }
  }
  if (state.turnIndex >= TURN_LIMIT) {
    return { winners: [], draw: true, scores: { p0: 0, p1: 0 }, reason: 'turn_limit' };
  }
  return null;
}

/** Applies a validated turn and rolls the next dice. Caller has already checked legality. */
export function advance(
  state: BgState,
  finalPos: Pos,
  notation: string,
  seed: SeedStream,
): BgState {
  const seat = state.turn;
  const nextTurnIndex = state.turnIndex + 1;
  const next: BgState = {
    points: finalPos.pts.slice(),
    bar: finalPos.bar.slice(),
    off: finalPos.off.slice(),
    turn: 1 - seat,
    dice: [],
    turnIndex: nextTurnIndex,
    lastMove: `p${seat} ${notation}`,
  };
  const over = (next.off[seat] ?? 0) === 15 || nextTurnIndex >= TURN_LIMIT;
  if (!over) {
    const d1 = seed.die(`dice:turn:${nextTurnIndex}`, 6);
    const d2 = seed.die(`dice:turn:${nextTurnIndex}`, 6);
    next.dice = d1 === d2 ? [d1, d1, d1, d1] : [Math.max(d1, d2), Math.min(d1, d2)];
  }
  return next;
}
