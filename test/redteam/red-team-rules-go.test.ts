/**
 * RED TEAM red-team-rules — go (spec games.M2_large_boards_and_multiplayer.go,
 * acceptance A4). Attacks: positional superko across ARBITRARY distance (the
 * state carries the full position-hash history — a recreation from long ago
 * must still be barred), suicide variants, Tromp-Taylor stand-as-they-are
 * scoring, and robustness. Board composition uses the documented codec
 * (13 pipe fields; hashes 'auto' seeds history with just the given board).
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { isRuleError } from '../../src/kernel/types.ts';
import go from '../../src/games/go/index.ts';
import { boardHash, decodeGo, type GoState } from '../../src/games/go/rules.ts';

const seed = () => createSeedStream(sha256Hex('redteam-rules-go'));

/** Compose a 9x9 state from row strings (row 9 first, i.e. top-down), toMove, hashes field. */
function compose(rowsTopDown: string[], toMove: 'B' | 'W', hashesField = 'auto', extra: Partial<{ suicide: boolean; passes: number; ended: boolean; komi: number }> = {}): GoState {
  if (rowsTopDown.length !== 9) throw new Error('need 9 rows');
  // codec board index = row*size+col with row 0 = BOTTOM, so reverse.
  const board = [...rowsTopDown].reverse().join('');
  if (board.length !== 81) throw new Error('bad rows');
  const enc = [
    'go1', '9', String(extra.komi ?? 7.5), extra.suicide ? '1' : '0', toMove,
    String(extra.passes ?? 0), '0', '0', board, '-', hashesField, '-', extra.ended ? '1' : '0',
  ].join('|');
  return decodeGo(enc);
}

const at = (st: GoState, col: number, row: number): string => st.board[row * 9 + col]!;

describe('positional superko across arbitrary distance', () => {
  // Single black stone would appear at A1 (col 0, row 0). Craft the history so
  // that the resulting position "happened" long ago: the play must be barred
  // even though it is not a simple-ko recapture.
  it('a play recreating a position from the deep past is rejected (superko)', () => {
    const empty = compose(['.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9)], 'B', 'auto');
    const after = empty.board.split('');
    after[0] = 'X';
    const forbiddenHash = boardHash(after.join(''));
    const st: GoState = { ...empty, hashes: [boardHash(empty.board), 'deadbeefdeadbeef', forbiddenHash] };
    const legal = go.legalMoves(st, 'p0') as { pass: boolean; col?: number; row?: number }[];
    expect(legal.some((m) => !m.pass && m.col === 0 && m.row === 0)).toBe(false);
    const r = go.apply(st, 'p0', { pass: false, col: 0, row: 0 }, seed());
    expect(isRuleError(r)).toBe(true);
    if (isRuleError(r)) expect(r.code).toBe('superko');
    // control: with a fresh history the same play is legal
    const fresh = compose(['.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9)], 'B', 'auto');
    expect(isRuleError(go.apply(fresh, 'p0', { pass: false, col: 0, row: 0 }, seed()))).toBe(false);
  });

  it('superko is POSITIONAL: the bar ignores whose turn it was when the position first arose', () => {
    // Same forbidden hash, but now it is WHITE to move and White's play at A1
    // would recreate... a position containing a BLACK stone cannot be created
    // by White; instead check the inverse: White recreating a White-stone
    // position recorded during a Black-to-move era.
    const empty = compose(['.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9)], 'W', 'auto');
    const after = empty.board.split('');
    after[0] = 'O';
    const st: GoState = { ...empty, hashes: [boardHash(empty.board), boardHash(after.join(''))] };
    const r = go.apply(st, 'p1', { pass: false, col: 0, row: 0 }, seed());
    expect(isRuleError(r)).toBe(true);
    if (isRuleError(r)) expect(r.code).toBe('superko');
  });

  it('the LONG ko cycle: after threat exchanges and a legal retake, the counter-retake is barred', () => {
    // Standard ko shape: B D5,E4,E6; W E5,F4,F6,G5 (module fixture geometry).
    // (col,row) 0-based: D5=(3,4) E4=(4,3) E6=(4,5) E5=(4,4) F4=(5,3)
    // F6=(5,5) G5=(6,4) F5=(5,4).
    const rows = Array.from({ length: 9 }, () => '.'.repeat(9).split(''));
    const put = (col: number, row: number, ch: string): void => {
      rows[8 - row]![col] = ch; // rows array is top-down
    };
    put(3, 4, 'X'); put(4, 3, 'X'); put(4, 5, 'X');
    put(4, 4, 'O'); put(5, 3, 'O'); put(5, 5, 'O'); put(6, 4, 'O');
    let st = compose(rows.map((r) => r.join('')), 'B', 'auto');
    const play = (p: string, col: number, row: number): void => {
      const r = go.apply(st, p, { pass: false, col, row }, seed());
      if (isRuleError(r)) throw new Error(`${p} (${col},${row}): ${r.code} ${r.message}`);
      st = r.state as GoState;
    };
    play('p0', 5, 4); // Black takes the ko (captures E5)
    // immediate retake barred
    const retake = go.apply(st, 'p1', { pass: false, col: 4, row: 4 }, seed());
    expect(isRuleError(retake) && retake.code === 'superko').toBe(true);
    play('p1', 0, 0); // W threat elsewhere
    play('p0', 0, 8); // B answers
    play('p1', 4, 4); // W retakes legally (board now differs by A1/A9)
    // ... and BLACK's immediate counter-retake would recreate the post-threat
    // position from 2 plies ago — the full history must catch it.
    const counter = go.apply(st, 'p0', { pass: false, col: 5, row: 4 }, seed());
    expect(isRuleError(counter)).toBe(true);
    if (isRuleError(counter)) expect(counter.code).toBe('superko');
    const legalNow = go.legalMoves(st, 'p0') as { pass: boolean; col?: number; row?: number }[];
    expect(legalNow.some((m) => !m.pass && m.col === 5 && m.row === 4)).toBe(false);
  });
});

describe('suicide rules', () => {
  it('multi-stone suicide is illegal by default and legal only under allow_suicide', () => {
    // White group of two in the corner with black wall; White fills its own
    // last liberty at A1: (0,0). W stones at (1,0) b1 and (0,1) a2? that does
    // not die by playing A1. Instead: W at a2(0,1), b1(1,0) — playing a1
    // joins them into a 3-stone group; liberties: b2(1,1), a3(0,2), c1(2,0)
    // must all be black.
    const rows = [
      '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9),
      'X........', // row 3: X a3
      'OX.......', // row 2: O a2, X b2
      '.OX......', // row 1: O b1, X c1
    ];
    const def = compose(rows, 'W', 'auto');
    const r1 = go.apply(def, 'p1', { pass: false, col: 0, row: 0 }, seed());
    expect(isRuleError(r1)).toBe(true);
    if (isRuleError(r1)) expect(r1.code).toBe('suicide');

    const allowed = compose(rows, 'W', 'auto', { suicide: true });
    const r2 = go.apply(allowed, 'p1', { pass: false, col: 0, row: 0 }, seed());
    expect(isRuleError(r2)).toBe(false);
    if (!isRuleError(r2)) {
      const st = r2.state as GoState;
      // all three white stones are gone; black wall intact
      expect(at(st, 0, 0)).toBe('.');
      expect(at(st, 0, 1)).toBe('.');
      expect(at(st, 1, 0)).toBe('.');
      expect(at(st, 1, 1)).toBe('X');
    }
  });

  it('single-stone suicide stays illegal even under allow_suicide (recreates the position)', () => {
    // A1 with black on b1 and a2: playing there dies immediately, board
    // unchanged -> positional superko must bar it.
    const rows = [
      '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9),
      'X........', // row 2: X a2
      '.X.......', // row 1: X b1
    ];
    const st = compose(rows, 'W', 'auto', { suicide: true });
    const r = go.apply(st, 'p1', { pass: false, col: 0, row: 0 }, seed());
    expect(isRuleError(r)).toBe(true);
  });
});

describe('Tromp-Taylor scoring: stones stand as they are', () => {
  it('an obviously dead invader still counts for its color; its region is neutral', () => {
    // Black holds the whole board shape; a lone White stone sits inside
    // black's area. Empty region reaches both colors -> neutral. White = 1
    // (the stone) + komi; Black = stones only + regions touching only black.
    const rows = [
      '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9), '.'.repeat(9),
      'XXXXXXXXX', // row 3 wall
      '....O....', // row 2: white invader at e2
      '.........', // row 1
    ];
    const st = compose(rows, 'B', 'auto', { passes: 2, ended: true, komi: 7.5 });
    const t = go.isTerminal(st);
    expect(t).not.toBeNull();
    // Black: 9 stones + rows 4..9 empty region (54 points) = 63.
    // Rows 1-2 empty points touch the white stone AND the black wall -> neutral.
    expect(t!.scores).toEqual({ p0: 63, p1: 8.5 });
    expect(t!.winners).toEqual(['p0']);
  });

  it('two passes end the game; play after the end is rejected; a play between passes resets', () => {
    const st0 = go.initialState(seed(), ['p0', 'p1'], {}) as GoState;
    const p1 = go.apply(st0, 'p0', { pass: true }, seed());
    if (isRuleError(p1)) throw new Error(p1.message);
    const mid = go.apply(p1.state as GoState, 'p1', { pass: false, col: 4, row: 4 }, seed());
    if (isRuleError(mid)) throw new Error(mid.message);
    expect((mid.state as GoState).passes).toBe(0); // reset
    const p2 = go.apply(mid.state as GoState, 'p0', { pass: true }, seed());
    if (isRuleError(p2)) throw new Error(p2.message);
    const p3 = go.apply(p2.state as GoState, 'p1', { pass: true }, seed());
    if (isRuleError(p3)) throw new Error(p3.message);
    const ended = p3.state as GoState;
    expect(go.isTerminal(ended)).not.toBeNull();
    expect(go.playersToMove(ended)).toEqual([]);
    expect(isRuleError(go.apply(ended, 'p0', { pass: true }, seed()))).toBe(true);
  });
});

describe('apply robustness', () => {
  it('malformed moves return RuleError, never throw', () => {
    const st = go.initialState(seed(), ['p0', 'p1'], {}) as GoState;
    for (const bad of [
      { pass: false, col: 9, row: 0 },
      { pass: false, col: -1, row: 3 },
      { pass: false, col: 2.5, row: 3 },
      { pass: false, col: Number.NaN, row: 0 },
    ]) {
      let out: unknown;
      expect(() => {
        out = go.apply(st, 'p0', bad as never, seed());
      }).not.toThrow();
      expect(isRuleError(out)).toBe(true);
    }
    // out-of-turn
    expect(isRuleError(go.apply(st, 'p1', { pass: true }, seed()))).toBe(true);
  });
});
