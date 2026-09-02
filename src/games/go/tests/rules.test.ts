/**
 * Go rules fixtures (gate A4): captures (single / multi / corner / edge),
 * simple ko, positional superko (sending-two-returning-one), suicide default
 * and variant, seki + exact Tromp-Taylor area scoring, two-pass ending,
 * notation, codec, render.
 */

import { describe, expect, it } from 'vitest';
import { hashState } from '../../../kernel/hash.ts';
import { createSeedStream } from '../../../kernel/seed.ts';
import { isParseError, isRuleError, type RuleError } from '../../../kernel/types.ts';
import go from '../index.ts';
import { GO_LETTERS } from '../notation.ts';
import { boardHash, type GoState } from '../rules.ts';

const seed = () => createSeedStream('0'.repeat(64));

function pt(n: string, size: number): number {
  const col = GO_LETTERS.indexOf(n[0]!.toUpperCase());
  const row = Number(n.slice(1)) - 1;
  if (col < 0 || col >= size || row < 0 || row >= size) throw new Error(`bad test point ${n}`);
  return row * size + col;
}

/** Compose a position directly through decodeState (hashes=auto seeds superko history). */
function fixture(opts: {
  size?: number;
  black?: string[];
  white?: string[];
  toMove?: 'B' | 'W';
  komi?: number;
  allowSuicide?: boolean;
  passes?: number;
}): GoState {
  const size = opts.size ?? 9;
  const cells = Array<string>(size * size).fill('.');
  for (const n of opts.black ?? []) cells[pt(n, size)] = 'X';
  for (const n of opts.white ?? []) cells[pt(n, size)] = 'O';
  const enc = [
    'go1',
    String(size),
    String(opts.komi ?? 7.5),
    opts.allowSuicide ? '1' : '0',
    opts.toMove ?? 'B',
    String(opts.passes ?? 0),
    '0',
    '0',
    cells.join(''),
    '-',
    'auto',
    '-',
    '0',
  ].join('|');
  return go.decodeState(enc);
}

function play(state: GoState, player: 'p0' | 'p1', notation: string): GoState {
  const mv = go.parseMove(notation, state, player);
  if (isParseError(mv)) throw new Error(`parse ${notation}: ${mv.message}`);
  const r = go.apply(state, player, mv, seed());
  if (isRuleError(r)) throw new Error(`apply ${notation}: ${r.code}: ${r.message}`);
  return r.state;
}

function tryPlay(state: GoState, player: 'p0' | 'p1', notation: string): RuleError | GoState {
  const mv = go.parseMove(notation, state, player);
  if (isParseError(mv)) throw new Error(`parse ${notation}: ${mv.message}`);
  const r = go.apply(state, player, mv, seed());
  return isRuleError(r) ? r : r.state;
}

function at(state: GoState, n: string): string {
  return state.board[pt(n, state.size)]!;
}

function notations(state: GoState, player: 'p0' | 'p1'): string[] {
  return go.legalMoves(state, player).map((m) => go.moveToNotation(m, state));
}

describe('go: setup, notation, codec', () => {
  it('initial 9x9 state: Black (p0) to move with 81 plays + pass', () => {
    const s = go.initialState(seed(), ['p0', 'p1'], {});
    expect(s.size).toBe(9);
    expect(s.komi).toBe(7.5);
    expect(go.playersToMove(s)).toEqual(['p0']);
    const legal = notations(s, 'p0');
    expect(legal).toHaveLength(82);
    expect(legal[0]).toBe('A1');
    expect(legal[legal.length - 1]).toBe('pass');
    expect(go.legalMoves(s, 'p1')).toEqual([]); // not White's turn
    expect(go.isTerminal(s)).toBeNull();
  });

  it('board size variants ship full legal move lists', () => {
    const s13 = go.initialState(seed(), ['p0', 'p1'], { board_size: 13 });
    expect(go.legalMoves(s13, 'p0')).toHaveLength(170);
    const s19 = go.initialState(seed(), ['p0', 'p1'], { board_size: 19 });
    expect(go.legalMoves(s19, 'p0')).toHaveLength(362);
    expect(() => go.initialState(seed(), ['p0', 'p1'], { board_size: 10 })).toThrow();
    expect(() => go.initialState(seed(), ['p0', 'p1'], { komi: 3.25 })).toThrow();
  });

  it("notation skips 'I', accepts lowercase, uppercases output", () => {
    const s = go.initialState(seed(), ['p0', 'p1'], {});
    const mv = go.parseMove('e5', s, 'p0');
    expect(mv).toEqual({ pass: false, col: 4, row: 4 });
    if (!isParseError(mv)) expect(go.moveToNotation(mv, s)).toBe('E5');
    expect(go.parseMove('PASS', s, 'p0')).toEqual({ pass: true });
    expect(isParseError(go.parseMove('I5', s, 'p0'))).toBe(true); // no letter I
    expect(isParseError(go.parseMove('K3', s, 'p0'))).toBe(true); // off 9x9 (A..J only)
    expect(isParseError(go.parseMove('A0', s, 'p0'))).toBe(true);
    expect(isParseError(go.parseMove('A10', s, 'p0'))).toBe(true);
    expect(isParseError(go.parseMove('#3', s, 'p0'))).toBe(true); // index fallback is kernel-level
    const s19 = go.initialState(seed(), ['p0', 'p1'], { board_size: 19 });
    expect(go.parseMove('t19', s19, 'p0')).toEqual({ pass: false, col: 18, row: 18 });
  });

  it('encode/decode round-trips exactly (state-hash equality)', () => {
    let s = go.initialState(seed(), ['p0', 'p1'], {});
    s = play(s, 'p0', 'E5');
    s = play(s, 'p1', 'C3');
    s = play(s, 'p0', 'pass');
    const rt = go.decodeState(go.encodeState(s));
    expect(hashState(rt)).toBe(hashState(s));
    expect(rt).toEqual(s);
    expect(() => go.decodeState('nonsense')).toThrow();
    expect(() => go.decodeState('go1|9|7.5|0|B|0|0|0|xx|-|auto|-|0')).toThrow();
  });

  it('defaultMove is pass; moveSummary reads well', () => {
    const s = go.initialState(seed(), ['p0', 'p1'], {});
    expect(go.defaultMove!(s, 'p0', go.legalMoves(s, 'p0'))).toEqual({ pass: true });
    expect(go.moveSummary!({ pass: false, col: 4, row: 4 }, s)).toBe('Black plays E5');
    expect(go.moveSummary!({ pass: true }, s)).toBe('Black passes');
  });
});

describe('go: captures', () => {
  it('captures a single surrounded stone', () => {
    const s = fixture({ black: ['D5', 'F5', 'E4'], white: ['E5'], toMove: 'B' });
    const n = play(s, 'p0', 'E6');
    expect(at(n, 'E5')).toBe('.');
    expect(n.capB).toBe(1);
    expect(n.capW).toBe(0);
  });

  it('captures a multi-stone group', () => {
    const s = fixture({ black: ['D5', 'D6', 'F5', 'F6', 'E4'], white: ['E5', 'E6'], toMove: 'B' });
    const n = play(s, 'p0', 'E7');
    expect(at(n, 'E5')).toBe('.');
    expect(at(n, 'E6')).toBe('.');
    expect(n.capB).toBe(2);
  });

  it('captures in the corner', () => {
    const s = fixture({ black: ['B1'], white: ['A1'], toMove: 'B' });
    const n = play(s, 'p0', 'A2');
    expect(at(n, 'A1')).toBe('.');
    expect(n.capB).toBe(1);
  });

  it('captures on the edge', () => {
    const s = fixture({ black: ['A4', 'A6'], white: ['A5'], toMove: 'B' });
    const n = play(s, 'p0', 'B5');
    expect(at(n, 'A5')).toBe('.');
    expect(n.capB).toBe(1);
  });

  it('rejects playing on an occupied point', () => {
    const s = fixture({ black: ['E5'], toMove: 'W' });
    const r = tryPlay(s, 'p1', 'E5');
    expect(isRuleError(r) && r.code === 'occupied').toBe(true);
  });

  it('rejects out-of-turn play', () => {
    const s = go.initialState(seed(), ['p0', 'p1'], {});
    const r = go.apply(s, 'p1', { pass: false, col: 0, row: 0 }, seed());
    expect(isRuleError(r) && r.code === 'not_your_turn').toBe(true);
  });
});

describe('go: ko and positional superko', () => {
  it('forbids immediate ko recapture, allows it after exchanges elsewhere', () => {
    const s0 = fixture({ black: ['D5', 'E4', 'E6'], white: ['E5', 'F4', 'F6', 'G5'], toMove: 'B' });
    const s1 = play(s0, 'p0', 'F5'); // Black takes the ko, capturing E5
    expect(at(s1, 'E5')).toBe('.');
    expect(s1.capB).toBe(1);

    // White may not retake at once: that would recreate the previous position.
    const ko = tryPlay(s1, 'p1', 'E5');
    expect(isRuleError(ko) && ko.code === 'superko').toBe(true);
    expect(notations(s1, 'p1')).not.toContain('E5');

    // After an exchange elsewhere the whole-board position differs — retake is legal.
    const s2 = play(s1, 'p1', 'A1');
    const s3 = play(s2, 'p0', 'A9');
    const s4 = play(s3, 'p1', 'E5');
    expect(at(s4, 'F5')).toBe('.');
    expect(s4.capW).toBe(1);
  });

  it('forbids the sending-two-returning-one cycle (positional, NOT simple ko)', () => {
    // Corner: p=A1, q=B1, r=C1. X: Black B1; walls White A2,B2 / Black C2,D1.
    const x = fixture({ black: ['B1', 'C2', 'D1'], white: ['A2', 'B2'], toMove: 'B' });
    const xHash = boardHash(x.board);

    // 1. Black "sends two": A1 makes the group {A1,B1} with one liberty (C1).
    const y = play(x, 'p0', 'A1');
    expect(y.capB + y.capW).toBe(0);

    // 2. White captures the two stones by playing C1.
    const z = play(y, 'p1', 'C1');
    expect(z.capW).toBe(2);
    expect(at(z, 'A1')).toBe('.');
    expect(at(z, 'B1')).toBe('.');
    expect(at(z, 'C1')).toBe('O');

    // 3. Black "returns one": B1 would capture the single stone C1 and recreate
    //    position X, three plies back. Simple ko would NOT bar this (White's
    //    capture took TWO stones); positional superko must.
    const back = tryPlay(z, 'p0', 'B1');
    expect(isRuleError(back) && back.code === 'superko').toBe(true);
    expect(notations(z, 'p0')).not.toContain('B1');
    expect(z.hashes).toContain(xHash); // X really is in the position history

    // A different reply is fine — the engine is not over-blocking.
    const alt = tryPlay(z, 'p0', 'A1');
    expect(isRuleError(alt)).toBe(false);
  });
});

describe('go: suicide', () => {
  it('rejects suicide by default', () => {
    const s = fixture({ white: ['A2', 'B1'], toMove: 'B' });
    const r = tryPlay(s, 'p0', 'A1');
    expect(isRuleError(r) && r.code === 'suicide').toBe(true);
    expect(notations(s, 'p0')).not.toContain('A1');
  });

  it('allows multi-stone suicide under the allow_suicide variant', () => {
    const mk = (allowSuicide: boolean) =>
      fixture({ black: ['A1', 'B1'], white: ['A3', 'B2', 'C1'], toMove: 'B', allowSuicide });

    // Default rules: still suicide.
    const rejected = tryPlay(mk(false), 'p0', 'A2');
    expect(isRuleError(rejected) && rejected.code === 'suicide').toBe(true);

    // Variant: the three-stone group removes itself; opponent gets the tally.
    const n = tryPlay(mk(true), 'p0', 'A2');
    expect(isRuleError(n)).toBe(false);
    if (!isRuleError(n)) {
      expect(at(n, 'A1')).toBe('.');
      expect(at(n, 'A2')).toBe('.');
      expect(at(n, 'B1')).toBe('.');
      expect(n.capW).toBe(3);
      expect(n.capB).toBe(0);
    }
  });

  it('single-stone suicide stays illegal even under allow_suicide (recreates the current position)', () => {
    const s = fixture({ white: ['A2', 'B1'], toMove: 'B', allowSuicide: true });
    const r = tryPlay(s, 'p0', 'A1');
    expect(isRuleError(r) && r.code === 'superko').toBe(true);
  });
});

describe('go: two passes end the game, area scoring', () => {
  it('two consecutive passes end; a play resets the pass count', () => {
    let s = go.initialState(seed(), ['p0', 'p1'], {});
    s = play(s, 'p0', 'pass');
    expect(s.passes).toBe(1);
    expect(go.isTerminal(s)).toBeNull();
    s = play(s, 'p1', 'E5'); // play resets the count
    expect(s.passes).toBe(0);
    s = play(s, 'p0', 'pass');
    s = play(s, 'p1', 'pass');
    expect(s.ended).toBe(true);
    const result = go.isTerminal(s);
    expect(result).not.toBeNull();
    // One white stone reaches the whole empty board: White 81 + 7.5, Black 0.
    expect(result!.scores).toEqual({ p0: 0, p1: 88.5 });
    expect(result!.winners).toEqual(['p1']);
    expect(result!.reason).toBe('two_passes');
    // After the end: no moves, no players, applies rejected.
    expect(go.playersToMove(s)).toEqual([]);
    expect(go.legalMoves(s, 'p0')).toEqual([]);
    const r = go.apply(s, 'p0', { pass: true }, seed());
    expect(isRuleError(r) && r.code === 'game_over').toBe(true);
  });

  it('empty-board double pass: White wins on komi alone (no draws at 7.5)', () => {
    let s = go.initialState(seed(), ['p0', 'p1'], {});
    s = play(s, 'p0', 'pass');
    s = play(s, 'p1', 'pass');
    const result = go.isTerminal(s)!;
    expect(result.scores).toEqual({ p0: 0, p1: 7.5 });
    expect(result.winners).toEqual(['p1']);
    expect(result.draw).toBe(false);
  });

  it('integer komi 0 can draw', () => {
    let s = go.initialState(seed(), ['p0', 'p1'], { komi: 0 });
    s = play(s, 'p0', 'pass');
    s = play(s, 'p1', 'pass');
    const result = go.isTerminal(s)!;
    expect(result.draw).toBe(true);
    expect(result.winners).toEqual([]);
    expect(result.scores).toEqual({ p0: 0, p1: 0 });
  });

  it('exact area count: full columns split the board', () => {
    // Black column D (9 stones), White column F (9 stones), column E neutral.
    const cols = (letter: string) => Array.from({ length: 9 }, (_, r) => `${letter}${r + 1}`);
    let s = fixture({ black: cols('D'), white: cols('F'), toMove: 'B' });
    s = play(s, 'p0', 'pass');
    s = play(s, 'p1', 'pass');
    const result = go.isTerminal(s)!;
    // Black: 9 stones + 27 empty (cols A-C). White: 9 + 27 (cols G-J) + 7.5.
    expect(result.scores).toEqual({ p0: 36, p1: 43.5 });
    expect(result.winners).toEqual(['p1']);
  });

  it('seki: stones stand as they are, shared liberties count for nobody', () => {
    // Bottom-left corner seki: inner Black B1 and inner White A2-B2-C2 share
    // exactly the liberties A1 and C1; whoever plays first there dies.
    // Walls: Black A3,B3,C3,D1,D2 + full column E; White full column F.
    const colE = Array.from({ length: 9 }, (_, r) => `E${r + 1}`);
    const colF = Array.from({ length: 9 }, (_, r) => `F${r + 1}`);
    let s = fixture({
      black: ['B1', 'A3', 'B3', 'C3', 'D1', 'D2', ...colE],
      white: ['A2', 'B2', 'C2', ...colF],
      toMove: 'B',
    });
    s = play(s, 'p0', 'pass');
    s = play(s, 'p1', 'pass');
    const result = go.isTerminal(s)!;
    // Black: 15 stones + 25 territory (cols A-D above the seki) = 40.
    // White: 12 stones + 27 territory (cols G-J) + 7.5 komi = 46.5.
    // A1 and C1 reach both colors -> neutral (40 + 39 + 2 = 81 points).
    expect(result.scores).toEqual({ p0: 40, p1: 46.5 });
    expect(result.winners).toEqual(['p1']);
  });
});

describe('go: render', () => {
  it('shows column letters on both top and bottom, stars, captures, last move', () => {
    let s = go.initialState(seed(), ['p0', 'p1'], {});
    const empty = go.renderText(s, null);
    const letterRow = '   A B C D E F G H J';
    expect(empty.split('\n').filter((l) => l === letterRow)).toHaveLength(2);
    expect(empty).toContain('+'); // star points
    expect(empty).not.toContain('I'); // skipped column letter
    expect(empty).toContain('Black (p0) to move');

    s = play(s, 'p0', 'E5');
    const after = go.renderText(s, 'p1');
    expect(after).toContain('(X)'); // last move marked
    expect(after).toContain('Last move: Black E5');
    expect(after).toContain('You are White');
    expect(after).toContain('Captures: Black 0, White 0');

    s = play(s, 'p1', 'pass');
    s = play(s, 'p0', 'pass');
    expect(go.renderText(s, null)).toContain('Game over (two passes)');
  });

  it('renders a 19x19 board with letters through T on both edges', () => {
    const s = go.initialState(seed(), ['p0', 'p1'], { board_size: 19 });
    const text = go.renderText(s, null);
    const letterRow = '   A B C D E F G H J K L M N O P Q R S T';
    expect(text.split('\n').filter((l) => l === letterRow)).toHaveLength(2);
    expect(text).toContain('19');
  });
});
