/**
 * Stage-3 tournament judge: backgammon full-turn enumeration.
 * (spec: LUDUS_BUILD_SPEC.json workflow.stage_3_tournaments, contest
 * "backgammon full-turn enumerator" — "known dice-position fixtures including
 * must-use-both and larger-die rules")
 *
 * Incumbent:  src/games/backgammon (Game object; one move = one complete turn,
 *             absolute board, mover-relative hops, dice held in state).
 * Candidate B: src/games/backgammon/candidates/b.ts
 *             (legalTurns(pos, dice) over a mover-perspective signed board;
 *             hops 'from/to' strings; [] = dance).
 *
 * Rule lines under judgment (spec games.M2_large_boards_and_multiplayer
 * .backgammon.rules): a player must use both dice when possible and the
 * larger die if only one can be used (doubles play four); entry from the bar
 * has priority; bear off only with all checkers home, overshoot only from the
 * highest occupied point.
 *
 * Equality model: two complete turns are THE SAME turn iff their multisets of
 * (from, to) hops match — die assignment excluded (the same hop multiset
 * always produces the same final board: the set of landing points fixes the
 * hits, counts are additive). A position's enumeration is correct iff the
 * multiset of turn-multisets matches, with "dance" as an explicit marker
 * (incumbent: the single { hops: [] } move; candidate: the empty list).
 *
 * Re-runnable and deterministic: every random draw goes through
 * createSeedStream(sha256Hex(tag)). The tests PASS while the engines agree
 * and FAIL loudly with the smallest reproducing position (mover-perspective
 * points array + dice + incumbent encodeState string) when they diverge.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { isRuleError, playerId } from '../../src/kernel/types.ts';
import backgammon from '../../src/games/backgammon/index.ts';
import type { BgMove, BgState } from '../../src/games/backgammon/rules.ts';
import {
  legalTurns as candidateLegalTurns,
  type BgPos,
} from '../../src/games/backgammon/candidates/b.ts';

const BAR = 25;
const OFF = 0;
const DANCE_KEY = '(no play)';

type FT = { from: number; to: number };

/** Candidate B's canonical hop order: descending from ('bar' = 25), then descending to ('off' = 0). */
function cmpHop(a: FT, b: FT): number {
  return a.from !== b.from ? b.from - a.from : b.to - a.to;
}

function hopString(h: FT): string {
  return `${h.from === BAR ? 'bar' : h.from}/${h.to === OFF ? 'off' : h.to}`;
}

function parseHop(s: string): FT {
  const parts = s.split('/');
  const f = parts[0];
  const t = parts[1];
  if (parts.length !== 2 || f === undefined || t === undefined) {
    throw new Error(`bad hop string '${s}'`);
  }
  const from = f === 'bar' ? BAR : Number(f);
  const to = t === 'off' ? OFF : Number(t);
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error(`bad hop string '${s}'`);
  return { from, to };
}

/** Canonical key of one complete turn: its hop multiset in candidate B's sort order. */
function turnKey(hops: readonly FT[]): string {
  return hops.slice().sort(cmpHop).map(hopString).join(',');
}

/**
 * Expand incumbent notation to the same canonical key: '(n)' shorthand
 * expanded, '*' hit markers dropped, 'bar'/'off' endpoints kept, hops sorted
 * per candidate B's comparator. '(no play)' maps to the dance marker.
 */
function notationTurnKey(notation: string): string {
  if (notation === DANCE_KEY) return DANCE_KEY;
  const hops: FT[] = [];
  for (const tok of notation.trim().split(/\s+/)) {
    const m = /^(bar|\d{1,2})\/(off|\d{1,2})(\*)?(?:\((\d+)\))?$/.exec(tok);
    if (!m) throw new Error(`cannot expand notation token '${tok}' in '${notation}'`);
    const from = m[1] === 'bar' ? BAR : Number(m[1]);
    const to = m[2] === 'off' ? OFF : Number(m[2]);
    const count = m[4] !== undefined ? Number(m[4]) : 1;
    for (let i = 0; i < count; i++) hops.push({ from, to });
  }
  return turnKey(hops);
}

/** A position's enumeration result, normalized for comparison. */
interface TurnSet {
  dance: boolean;
  /** canonical turn key -> multiplicity (multiplicity > 1 is itself a defect). */
  turns: Map<string, number>;
}

function incumbentSetFromMoves(moves: readonly BgMove[]): { set: TurnSet; anomalies: string[] } {
  const anomalies: string[] = [];
  let dance = false;
  const turns = new Map<string, number>();
  for (const mv of moves) {
    if (mv.hops.length === 0) {
      dance = true;
      continue;
    }
    const k = turnKey(mv.hops);
    turns.set(k, (turns.get(k) ?? 0) + 1);
  }
  if (moves.length === 0) {
    anomalies.push('incumbent returned an empty legal-move list (dance must be the explicit no-play move)');
  }
  if (dance && turns.size > 0) {
    anomalies.push('incumbent mixed the explicit no-play move with playable turns');
  }
  return { set: { dance, turns }, anomalies };
}

function incumbentSet(state: BgState): { set: TurnSet; anomalies: string[] } {
  return incumbentSetFromMoves(backgammon.legalMoves(state, playerId(state.turn)));
}

function candidateSet(pos: BgPos, dice: [number, number]): TurnSet {
  const raw = candidateLegalTurns(pos, dice);
  const turns = new Map<string, number>();
  for (const t of raw) {
    const k = turnKey(t.map(parseHop)); // defensive re-canonicalization
    turns.set(k, (turns.get(k) ?? 0) + 1);
  }
  return { dance: raw.length === 0, turns };
}

/** Human-readable difference between two normalized turn sets, or null when equal. */
function diffSets(aName: string, a: TurnSet, bName: string, b: TurnSet): string | null {
  const problems: string[] = [];
  if (a.dance !== b.dance) {
    problems.push(`dance mismatch: ${aName}=${a.dance ? 'dance' : 'playable'} ${bName}=${b.dance ? 'dance' : 'playable'}`);
  }
  const keys = [...new Set([...a.turns.keys(), ...b.turns.keys()])].sort();
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  const countDiff: string[] = [];
  for (const k of keys) {
    const ca = a.turns.get(k) ?? 0;
    const cb = b.turns.get(k) ?? 0;
    if (ca > 0 && cb === 0) onlyA.push(k);
    else if (cb > 0 && ca === 0) onlyB.push(k);
    else if (ca !== cb) countDiff.push(`${k} (${aName} x${ca}, ${bName} x${cb})`);
  }
  if (onlyA.length > 0) problems.push(`turns only in ${aName}: [${onlyA.join(' | ')}]`);
  if (onlyB.length > 0) problems.push(`turns only in ${bName}: [${onlyB.join(' | ')}]`);
  if (countDiff.length > 0) problems.push(`duplicate-count mismatch: ${countDiff.join(' ; ')}`);
  return problems.length > 0 ? problems.join('\n') : null;
}

// ---------------------------------------------------------------------------
// Adapter: incumbent BgState (absolute board, seat to move, dice in state)
// -> candidate BgPos (mover-perspective signed board) + dice pair.
// ---------------------------------------------------------------------------

function toBgPos(state: BgState): BgPos {
  const seat = state.turn;
  const points = new Array<number>(24).fill(0);
  for (let r = 1; r <= 24; r++) {
    const abs = seat === 0 ? r : 25 - r;
    const c = state.points[abs - 1] ?? 0;
    points[r - 1] = seat === 0 ? c : -c;
  }
  const bar: [number, number] = [state.bar[seat] ?? 0, state.bar[1 - seat] ?? 0];
  const off: [number, number] = [state.off[seat] ?? 0, state.off[1 - seat] ?? 0];
  return { points, bar, off };
}

function dicePair(state: BgState): [number, number] {
  const a = state.dice[0];
  const b = state.dice[1];
  if (a === undefined || b === undefined) {
    throw new Error(`state has no rollable dice: [${state.dice.join(',')}]`);
  }
  return [a, b]; // doubles are stored [d,d,d,d]; the first two carry the roll
}

function encode(state: BgState): string {
  return backgammon.encodeState !== undefined ? backgammon.encodeState(state) : JSON.stringify(state);
}

// ---------------------------------------------------------------------------
// Divergence bookkeeping: always report the SMALLEST reproducing position.
// ---------------------------------------------------------------------------

interface Divergence {
  label: string;
  pos: BgPos;
  dice: [number, number];
  encoded: string;
  detail: string;
}

function boardSize(pos: BgPos): number {
  let n = pos.bar[0] + pos.bar[1];
  for (const c of pos.points) n += Math.abs(c);
  return n;
}

function failOnDivergences(divs: Divergence[], positionsChecked: number): void {
  if (divs.length === 0) return;
  divs.sort(
    (a, b) =>
      boardSize(a.pos) - boardSize(b.pos) ||
      a.encoded.length - b.encoded.length ||
      (a.encoded < b.encoded ? -1 : a.encoded > b.encoded ? 1 : 0),
  );
  const d = divs[0];
  if (d === undefined) return;
  throw new Error(
    [
      `BACKGAMMON ENUMERATION DIVERGENCE: ${divs.length} diverging position(s) out of ${positionsChecked} checked; smallest shown.`,
      `at: ${d.label}`,
      `dice (mover perspective): [${d.dice.join(', ')}]`,
      `BgPos.points: [${d.pos.points.join(', ')}]`,
      `BgPos.bar: [${d.pos.bar.join(', ')}]   BgPos.off: [${d.pos.off.join(', ')}]`,
      `incumbent encodeState: ${d.encoded}`,
      d.detail,
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Shared ground-truth fixtures (mover perspective). Sources: candidate B's 18
// hand-verified fixtures (candidates/tests/b.test.ts) + the incumbent's gate
// A5 fixture positions (tests/fixtures.test.ts), re-expressed in one format.
// `expected` lists turns as hop multisets (order-insensitive); 'dance' means
// no die is playable. Borne-off counts are auto-derived (15 per side).
// ---------------------------------------------------------------------------

interface Fixture {
  name: string;
  mover?: Record<number, number>;
  opp?: Record<number, number>;
  /** [moverBar, oppBar] */
  bar?: [number, number];
  dice: [number, number];
  expected: readonly (readonly string[])[] | 'dance';
}

const FIXTURES: readonly Fixture[] = [
  // ---- candidate B's fixture suite (B1..B18) ----
  {
    name: 'B1 standard opening, dice 3-1 — all 19 distinct turns',
    mover: { 24: 2, 13: 5, 8: 3, 6: 5 },
    opp: { 19: 5, 17: 3, 12: 5, 1: 2 },
    dice: [3, 1],
    expected: [
      ['24/23', '24/21'],
      ['24/23', '23/20'],
      ['24/23', '13/10'],
      ['24/23', '8/5'],
      ['24/23', '6/3'],
      ['24/21', '21/20'],
      ['24/21', '8/7'],
      ['24/21', '6/5'],
      ['13/10', '10/9'],
      ['13/10', '8/7'],
      ['13/10', '6/5'],
      ['8/7', '8/5'],
      ['8/7', '7/4'],
      ['8/7', '6/3'],
      ['8/5', '6/5'],
      ['8/5', '5/4'],
      ['6/5', '6/3'],
      ['6/5', '5/2'],
      ['6/3', '3/2'],
    ],
  },
  {
    name: 'B2 must-use-both — the tempting 2 (24/22) kills the 6 and is illegal',
    mover: { 24: 1, 13: 2, 6: 12 },
    opp: { 18: 2, 16: 2, 7: 2, 4: 2, 1: 7 },
    dice: [6, 2],
    expected: [['13/11', '11/5']],
  },
  {
    name: 'B3 larger-die forcing — either die playable alone, never both; the 6 must be played',
    mover: { 24: 1, 2: 14 },
    opp: { 15: 2, 1: 13 },
    dice: [6, 3],
    expected: [['24/18']],
  },
  {
    name: 'B4 smaller die only — larger die has no play anywhere',
    mover: { 24: 1, 2: 14 },
    opp: { 18: 2, 15: 2, 1: 11 },
    dice: [6, 3],
    expected: [['24/21']],
  },
  {
    name: 'B5 bar entry, one entry blocked — enter on the blot then play the 6',
    mover: { 13: 2, 6: 12 },
    opp: { 21: 1, 19: 2, 1: 12 },
    bar: [1, 0],
    dice: [6, 4],
    expected: [
      ['bar/21', '21/15'],
      ['bar/21', '13/7'],
    ],
  },
  {
    name: 'B6 dance — both entry points blocked with two on the bar',
    mover: { 6: 13 },
    opp: { 22: 2, 20: 2, 1: 11 },
    bar: [2, 0],
    dice: [3, 5],
    expected: 'dance',
  },
  {
    name: 'B7 doubles with limited material — only 2 of 4 sixes playable',
    mover: { 24: 2, 3: 13 },
    opp: { 12: 2, 1: 13 },
    dice: [6, 6],
    expected: [['24/18', '24/18']],
  },
  {
    name: 'B8 doubles, bar entry first with a hit, four forced hops in a chain',
    mover: { 6: 14 },
    opp: { 23: 1, 4: 2, 1: 12 },
    bar: [1, 0],
    dice: [2, 2],
    expected: [['bar/23', '23/21', '21/19', '19/17']],
  },
  {
    name: 'B9 bear-off — exact die vs illegal overshoot while a higher point is occupied',
    mover: { 5: 2, 3: 1, 2: 4, 1: 8 },
    opp: { 24: 2, 23: 2, 22: 2, 21: 2, 20: 2, 19: 2, 18: 3 },
    dice: [5, 3],
    expected: [
      ['5/2', '5/off'],
      ['5/off', '3/off'],
    ],
  },
  {
    name: 'B10 bear-off overshoot legal only from the highest occupied point',
    mover: { 3: 2, 2: 2, 1: 11 },
    opp: { 24: 8, 23: 7 },
    dice: [6, 4],
    expected: [['3/off', '3/off']],
  },
  {
    name: 'B11 bear-off eligibility gained mid-turn — 8 exact turns',
    mover: { 7: 1, 4: 2, 3: 2, 2: 5, 1: 5 },
    opp: { 20: 8, 19: 7 },
    dice: [3, 2],
    expected: [
      ['7/5', '5/2'],
      ['7/5', '4/1'],
      ['7/5', '3/off'],
      ['7/4', '4/2'],
      ['7/4', '3/1'],
      ['7/4', '2/off'],
      ['4/2', '4/1'],
      ['4/1', '3/1'],
    ],
  },
  {
    name: 'B12 hitting sequences — single hits and the double hit',
    mover: { 24: 1, 13: 2, 6: 12 },
    opp: { 22: 2, 20: 2, 11: 1, 9: 1, 4: 2, 2: 2, 1: 5 },
    dice: [4, 2],
    expected: [
      ['13/11', '13/9'],
      ['13/11', '11/7'],
      ['13/9', '9/7'],
    ],
  },
  {
    name: 'B13 overshoot after clearing — both die orders collapse to one turn',
    mover: { 5: 1, 1: 14 },
    opp: { 24: 5, 23: 5, 22: 5 },
    dice: [6, 5],
    expected: [['5/off', '1/off']],
  },
  {
    name: 'B14 only the larger die playable, two different ways — both kept',
    mover: { 24: 1, 18: 1, 2: 13 },
    opp: { 23: 2, 17: 2, 11: 2, 1: 9 },
    dice: [6, 1],
    expected: [['24/18'], ['18/12']],
  },
  {
    name: 'B15 full block without the bar — dance',
    mover: { 24: 2, 1: 13 },
    opp: { 20: 11, 19: 2, 18: 2 },
    dice: [6, 5],
    expected: 'dance',
  },
  {
    name: 'B16 two on the bar, one entry open — one enters, the 6 is lost',
    mover: { 6: 13 },
    opp: { 19: 2, 12: 13 },
    bar: [2, 0],
    dice: [6, 2],
    expected: [['bar/23']],
  },
  {
    name: 'B17 doubles chain-feeding — unique 4-hop multiset',
    mover: { 10: 1, 7: 1, 1: 13 },
    opp: { 20: 5, 19: 5, 18: 5 },
    dice: [3, 3],
    expected: [['10/7', '7/4', '7/4', '4/1']],
  },
  {
    name: 'B18 doubles bear-off, 13 off — forced 3 of 4 fives, movement before overshoot',
    mover: { 6: 1, 4: 1 },
    opp: { 24: 5, 23: 5, 22: 5 },
    dice: [5, 5],
    expected: [['6/1', '4/off', '1/off']],
  },

  // ---- incumbent gate-A5 fixture positions (F1..F8 + extras) ----
  {
    name: 'F1 must use both dice — order forced through the open route',
    mover: { 24: 1, 2: 1 },
    opp: { 21: 2, 19: 5, 20: 4, 17: 4 },
    dice: [6, 3],
    expected: [['24/18', '18/15']],
  },
  {
    name: 'F2 only one die playable — the larger must be chosen',
    mover: { 24: 1 },
    opp: { 15: 2, 19: 5, 20: 4, 17: 4 },
    dice: [6, 3],
    expected: [['24/18']],
  },
  {
    name: 'F3 must use both — 6 first, then the 3 elsewhere',
    mover: { 24: 1, 5: 1 },
    opp: { 21: 2, 15: 2, 19: 5, 20: 3, 17: 3 },
    dice: [6, 3],
    expected: [['24/18', '5/2']],
  },
  {
    name: 'F4 doubles 2-2 on 6+6+4+4 home chain — exactly 5 distinct turns',
    mover: { 6: 2, 4: 2 },
    opp: { 20: 5, 19: 5, 17: 5 },
    dice: [2, 2],
    expected: [
      ['4/2', '4/2', '2/off', '2/off'],
      ['6/4', '4/2', '4/2', '4/2'],
      ['6/4', '4/2', '4/2', '2/off'],
      ['6/4', '6/4', '4/2', '4/2'],
      ['6/4', '6/4', '4/2', '2/off'],
    ],
  },
  {
    name: 'F5 bar entry has absolute priority — second bar checker freezes the board',
    mover: { 13: 3 },
    opp: { 20: 2, 19: 5, 24: 4, 23: 4 },
    bar: [2, 0],
    dice: [5, 3],
    expected: [['bar/22']],
  },
  {
    name: 'F5b bar entry with both dice — 4 distinct routes by hop multiset',
    mover: { 13: 1 },
    opp: { 19: 5, 23: 5, 24: 5 },
    bar: [1, 0],
    dice: [5, 3],
    expected: [
      ['bar/20', '13/10'],
      ['bar/20', '20/17'],
      ['bar/22', '13/8'],
      ['bar/22', '22/17'],
    ],
  },
  {
    name: 'F6a bear-off exact + overshoot from highest, dice 6-3 on 5,5,3',
    mover: { 5: 2, 3: 1 },
    opp: { 19: 5, 20: 5, 17: 5 },
    dice: [6, 3],
    expected: [
      ['5/off', '3/off'],
      ['5/off', '5/2'],
    ],
  },
  {
    name: 'F6b doubles bear-off overshoot ordering — only 3 of 4 sixes playable',
    mover: { 5: 1, 2: 2 },
    opp: { 19: 5, 20: 5, 17: 5 },
    dice: [6, 6],
    expected: [['5/off', '2/off', '2/off']],
  },
  {
    name: 'F7 dance from the bar — both entry points blocked',
    mover: { 13: 2 },
    opp: { 19: 2, 22: 2, 24: 5, 23: 6 },
    bar: [1, 0],
    dice: [6, 3],
    expected: 'dance',
  },
  {
    name: 'F8 overshoot forbidden while a higher point is occupied (die 5 on 4,2)',
    mover: { 4: 1, 2: 1 },
    opp: { 19: 5, 20: 5, 17: 5 },
    dice: [5, 1],
    expected: [
      ['4/off', '2/1'],
      ['4/3', '3/off'],
    ],
  },
  {
    name: 'F9 die-agnostic bear-off — 2/off 1/off is ONE turn for dice 6-5',
    mover: { 2: 1, 1: 1 },
    opp: { 19: 5, 20: 5, 17: 5 },
    dice: [6, 5],
    expected: [['2/off', '1/off']],
  },
  {
    name: 'F10 hit en route — blot on 8 with dice 5-3',
    mover: { 13: 2 },
    opp: { 8: 1, 19: 5, 20: 5, 23: 4 },
    dice: [5, 3],
    expected: [
      ['13/10', '13/8'],
      ['13/8', '8/5'],
      ['13/10', '10/5'],
    ],
  },
];

function buildPos(f: Fixture): BgPos {
  const points = new Array<number>(24).fill(0);
  const bar: [number, number] = f.bar !== undefined ? [f.bar[0], f.bar[1]] : [0, 0];
  let mSum = bar[0];
  let oSum = bar[1];
  for (const [k, n] of Object.entries(f.mover ?? {})) {
    const p = Number(k);
    if (!Number.isInteger(p) || p < 1 || p > 24 || n <= 0) throw new Error(`bad mover point ${k} in '${f.name}'`);
    points[p - 1] = n;
    mSum += n;
  }
  for (const [k, n] of Object.entries(f.opp ?? {})) {
    const p = Number(k);
    if (!Number.isInteger(p) || p < 1 || p > 24 || n <= 0) throw new Error(`bad opp point ${k} in '${f.name}'`);
    if ((points[p - 1] ?? 0) !== 0) throw new Error(`point ${k} assigned to both sides in '${f.name}'`);
    points[p - 1] = -n;
    oSum += n;
  }
  if (mSum > 15 || oSum > 15) throw new Error(`fixture '${f.name}' exceeds 15 checkers per side`);
  return { points, bar, off: [15 - mSum, 15 - oSum] };
}

/** Mirror a mover-perspective position into an incumbent absolute state with `seat` on roll. */
function incumbentStateFor(pos: BgPos, dice: [number, number], seat: 0 | 1): BgState {
  const points = new Array<number>(24).fill(0);
  for (let r = 1; r <= 24; r++) {
    const c = pos.points[r - 1] ?? 0;
    if (c === 0) continue;
    const abs = seat === 0 ? r : 25 - r;
    points[abs - 1] = seat === 0 ? c : -c;
  }
  const [a, b] = dice;
  return {
    points,
    bar: seat === 0 ? [pos.bar[0], pos.bar[1]] : [pos.bar[1], pos.bar[0]],
    off: seat === 0 ? [pos.off[0], pos.off[1]] : [pos.off[1], pos.off[0]],
    turn: seat,
    dice: a === b ? [a, a, a, a] : [Math.max(a, b), Math.min(a, b)],
    turnIndex: 10,
    lastMove: null,
  };
}

function expectedTurnSet(f: Fixture): TurnSet {
  if (f.expected === 'dance') return { dance: true, turns: new Map() };
  const turns = new Map<string, number>();
  for (const t of f.expected) {
    const k = turnKey(t.map(parseHop));
    turns.set(k, (turns.get(k) ?? 0) + 1);
  }
  if (turns.size !== f.expected.length) throw new Error(`fixture '${f.name}' has duplicate expected turns`);
  return { dance: false, turns };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tournament: backgammon full-turn enumeration — incumbent vs candidate B', () => {
  describe('spec-criterion fixtures (shared ground truth, both engines, both seats)', () => {
    for (const f of FIXTURES) {
      it(f.name, () => {
        const pos = buildPos(f);
        const expected = expectedTurnSet(f);
        const cand = candidateSet(pos, f.dice);

        // Candidate against ground truth (seat-independent: it takes BgPos directly).
        const candVsExpected = diffSets('candidate', cand, 'expected', expected);
        expect(candVsExpected, `candidate B vs expected\n${candVsExpected ?? ''}`).toBeNull();

        // Incumbent against ground truth and against the candidate, from both seats
        // (exercises the absolute-board mirroring both ways).
        for (const seat of [0, 1] as const) {
          const state = incumbentStateFor(pos, f.dice, seat);
          const inc = incumbentSet(state);
          const problems = [...inc.anomalies];
          const dExp = diffSets('incumbent', inc.set, 'expected', expected);
          if (dExp !== null) problems.push(dExp);
          const dCand = diffSets('incumbent', inc.set, 'candidate', cand);
          if (dCand !== null) problems.push(dCand);
          expect(
            problems.length === 0 ? null : problems.join('\n'),
            `seat=${seat} encodeState=${encode(state)}`,
          ).toBeNull();

          // Adapter normalization check: incumbent notation ('(n)' shorthand,
          // '*' hits, bar/off) expands to exactly the hop-object multiset.
          for (const mv of backgammon.legalMoves(state, playerId(seat))) {
            const notation = backgammon.moveToNotation(mv, state);
            const viaHops = mv.hops.length === 0 ? DANCE_KEY : turnKey(mv.hops);
            expect(notationTurnKey(notation), `notation '${notation}' (seat ${seat})`).toBe(viaHops);
          }
        }
      });
    }
  });

  it('dice grid: every fixture position x all 21 rolls x both seats — engines agree', { timeout: 600_000 }, () => {
    const divs: Divergence[] = [];
    let checked = 0;
    for (const f of FIXTURES) {
      const pos = buildPos(f);
      for (let hi = 1; hi <= 6; hi++) {
        for (let lo = 1; lo <= hi; lo++) {
          const dice: [number, number] = [hi, lo];
          const cand = candidateSet(pos, dice);
          for (const seat of [0, 1] as const) {
            const state = incumbentStateFor(pos, dice, seat);
            const inc = incumbentSet(state);
            checked++;
            const problems = [...inc.anomalies];
            const d = diffSets('incumbent', inc.set, 'candidate', cand);
            if (d !== null) problems.push(d);
            if (problems.length > 0) {
              divs.push({
                label: `dice grid: '${f.name}' seat=${seat}`,
                pos,
                dice,
                encoded: encode(state),
                detail: problems.join('\n'),
              });
            }
          }
        }
      }
    }
    expect(checked).toBe(FIXTURES.length * 21 * 2);
    failOnDivergences(divs, checked);
  });

  it('differential sweep: >= 300 seeded games, >= 5,000 turn positions', { timeout: 600_000 }, () => {
    const GAMES = 300;
    const TURN_GUARD = 600; // real games average ~97 turns; hard stop per game
    const divs: Divergence[] = [];
    let positions = 0;

    for (let g = 0; g < GAMES; g++) {
      const gameSeed = createSeedStream(sha256Hex(`tournament:backgammon:game:${g}`));
      const pickSeed = createSeedStream(sha256Hex(`tournament:backgammon:pick:${g}`));
      let state: BgState = backgammon.initialState(gameSeed, [playerId(0), playerId(1)], {});

      for (let turn = 0; turn < TURN_GUARD && backgammon.isTerminal(state) === null; turn++) {
        const mover = playerId(state.turn);
        const moves = backgammon.legalMoves(state, mover);
        positions++;

        const pos = toBgPos(state);
        const dice = dicePair(state);
        const inc = incumbentSetFromMoves(moves);
        const cand = candidateSet(pos, dice);
        const problems = [...inc.anomalies];
        const d = diffSets('incumbent', inc.set, 'candidate', cand);
        if (d !== null) problems.push(d);
        if (problems.length > 0) {
          divs.push({
            label: `sweep: game ${g}, turnIndex ${state.turnIndex}, seat ${state.turn}`,
            pos,
            dice,
            encoded: encode(state),
            detail: problems.join('\n'),
          });
        }

        if (moves.length === 0) break; // anomaly recorded above; cannot advance this game
        const idx = moves.length === 1 ? 0 : pickSeed.int(`pick:turn:${turn}`, moves.length);
        const move = moves[idx];
        if (move === undefined) throw new Error('unreachable: picked move index out of range');
        const applied = backgammon.apply(state, mover, move, gameSeed);
        if (isRuleError(applied)) {
          throw new Error(
            `incumbent rejected its own enumerated move (game ${g}, turn ${turn}, ` +
              `encodeState=${encode(state)}): ${applied.message}`,
          );
        }
        state = applied.state;
      }
    }

    expect(positions).toBeGreaterThanOrEqual(5000);
    expect(GAMES).toBeGreaterThanOrEqual(300);
    failOnDivergences(divs, positions);
  });
});
