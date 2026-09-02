import { describe, it, expect } from 'vitest';
import { applyGoMove, scoreArea, type Board } from '../b.ts';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build a board from strings: '.' empty, 'X' black (1), 'O' white (2). */
function b(...rows: string[]): Board {
  return rows.map((row) => [...row].map((ch) => (ch === 'X' ? 1 : ch === 'O' ? 2 : 0)));
}

function keyOf(board: Board): string {
  return board.map((row) => row.join('')).join('/');
}

type Ok = { board: Board; captured: number; positionKey: string };

function ok(res: ReturnType<typeof applyGoMove>): Ok {
  if ('error' in res) throw new Error(`expected legal move, got error: ${res.error}`);
  return res;
}

function err(res: ReturnType<typeof applyGoMove>): string {
  if (!('error' in res)) throw new Error('expected an error, move was accepted');
  return res.error;
}

function countStones(board: Board): { black: number; white: number } {
  let black = 0;
  let white = 0;
  for (const row of board) {
    for (const v of row) {
      if (v === 1) black++;
      else if (v === 2) white++;
    }
  }
  return { black, white };
}

/** Deterministic RNG (mulberry32) for playouts. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// captures
// ---------------------------------------------------------------------------

describe('captures', () => {
  it('captures a single stone on the edge', () => {
    const board = b('XOX', '...', '...');
    const res = ok(applyGoMove(board, 1, { row: 1, col: 1 }, [keyOf(board)], false));
    expect(res.captured).toBe(1);
    expect(res.board[0]![1]).toBe(0);
    expect(res.board[1]![1]).toBe(1);
  });

  it('captures a single stone in the corner', () => {
    const board = b('O..', 'X..', '...');
    const res = ok(applyGoMove(board, 1, { row: 0, col: 1 }, [keyOf(board)], false));
    expect(res.captured).toBe(1);
    expect(res.board[0]![0]).toBe(0);
  });

  it('captures a two-stone chain', () => {
    const board = b('.XX.', 'XOOX', '.X..');
    const res = ok(applyGoMove(board, 1, { row: 2, col: 2 }, [keyOf(board)], false));
    expect(res.captured).toBe(2);
    expect(res.board[1]![1]).toBe(0);
    expect(res.board[1]![2]).toBe(0);
  });

  it('captures two separate chains with one move', () => {
    const board = b('.XXX.', 'XO.OX', '.XXX.');
    const res = ok(applyGoMove(board, 1, { row: 1, col: 2 }, [keyOf(board)], false));
    expect(res.captured).toBe(2);
    expect(res.board[1]![1]).toBe(0);
    expect(res.board[1]![3]).toBe(0);
    expect(res.board[1]![2]).toBe(1);
  });

  it('white captures black in a 2x2 corner (small board shape)', () => {
    // Black corner stone at (0,0) has one liberty left, (1,0); white fills it.
    const board = b('XO', '.O');
    const res = ok(applyGoMove(board, 2, { row: 1, col: 0 }, [keyOf(board)], false));
    expect(res.captured).toBe(1);
    expect(res.board[0]![0]).toBe(0);
    expect(res.board[1]![0]).toBe(2);
  });

  it('a move with no empty neighbors is legal when it captures (not suicide)', () => {
    // Black plays into a point whose neighbors are all white, but the capture
    // opens liberties first (Tromp-Taylor order: capture, then suicide check).
    const board = b('.XO.', 'XO.O', '.XO.', '....');
    const res = ok(applyGoMove(board, 1, { row: 1, col: 2 }, [keyOf(board)], false));
    expect(res.captured).toBe(1);
    expect(res.board[1]![1]).toBe(0);
  });

  it('does not mutate the input board', () => {
    const board = b('XOX', '...', '...');
    const snapshot = JSON.stringify(board);
    ok(applyGoMove(board, 1, { row: 1, col: 1 }, [], false));
    expect(JSON.stringify(board)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// basic legality
// ---------------------------------------------------------------------------

describe('basic legality', () => {
  it('rejects a move on an occupied point', () => {
    const board = b('...', '.X.', '...');
    expect(err(applyGoMove(board, 2, { row: 1, col: 1 }, [], false))).toMatch(/occupied/);
  });

  it('rejects out-of-bounds moves', () => {
    const board = b('...', '...', '...');
    expect(err(applyGoMove(board, 1, { row: 3, col: 0 }, [], false))).toMatch(/out of bounds/);
    expect(err(applyGoMove(board, 1, { row: 0, col: 3 }, [], false))).toMatch(/out of bounds/);
    expect(err(applyGoMove(board, 1, { row: -1, col: 0 }, [], false))).toMatch(/out of bounds/);
  });

  it('pass is always legal, changes nothing, and is exempt from superko', () => {
    const board = b('.X.', 'XO.', '...');
    const k0 = keyOf(board);
    const res = ok(applyGoMove(board, 2, 'pass', [k0], false));
    expect(res.captured).toBe(0);
    expect(res.positionKey).toBe(k0);
    expect(res.board).not.toBe(board); // fresh copy
    expect(JSON.stringify(res.board)).toBe(JSON.stringify(board));
  });
});

// ---------------------------------------------------------------------------
// ko and positional superko
// ---------------------------------------------------------------------------

describe('ko and superko', () => {
  // Classic ko shape: black diamond around (1,1) holding a white stone,
  // white diamond around (1,2) with the gap at (1,2).
  const koBoard = b('.XO.', 'XO.O', '.XO.', '....');

  it('forbids immediate ko recapture (simple ko via positional superko)', () => {
    const k0 = keyOf(koBoard);
    const take = ok(applyGoMove(koBoard, 1, { row: 1, col: 2 }, [k0], false));
    expect(take.captured).toBe(1);
    const retake = applyGoMove(take.board, 2, { row: 1, col: 1 }, [k0, take.positionKey], false);
    expect(err(retake)).toMatch(/superko/);
  });

  it('allows the ko recapture when the prior position is not in history (positional, not shape-based)', () => {
    const k0 = keyOf(koBoard);
    const take = ok(applyGoMove(koBoard, 1, { row: 1, col: 2 }, [k0], false));
    // History deliberately omits k0: the "recapture" position is novel.
    const retake = ok(applyGoMove(take.board, 2, { row: 1, col: 1 }, [take.positionKey], false));
    expect(retake.captured).toBe(1);
    expect(retake.positionKey).toBe(k0);
  });

  it('rejects repetition over a six-move triple-ko cycle (long-cycle superko)', () => {
    // Three independent ko shapes stacked on a 9x9 board.
    // ko1 (rows 0-2) and ko3 (rows 6-8): black-capturable.
    // ko2 (rows 3-5): white-capturable (mirrored).
    const start = b(
      '.XO......',
      'XO.O.....',
      '.XO......',
      '.XO......',
      'X.XO.....',
      '.XO......',
      '.XO......',
      'XO.O.....',
      '.XO......',
    );
    const history: string[] = [keyOf(start)];
    const moves: Array<{ player: 1 | 2; row: number; col: number }> = [
      { player: 1, row: 1, col: 2 }, // B takes ko1
      { player: 2, row: 4, col: 1 }, // W takes ko2
      { player: 1, row: 7, col: 2 }, // B takes ko3
      { player: 2, row: 1, col: 1 }, // W retakes ko1
      { player: 1, row: 4, col: 2 }, // B retakes ko2
    ];
    let board = start;
    for (const m of moves) {
      const res = ok(applyGoMove(board, m.player, { row: m.row, col: m.col }, history, false));
      expect(res.captured).toBe(1);
      expect(history).not.toContain(res.positionKey); // every intermediate position is novel
      history.push(res.positionKey);
      board = res.board;
    }
    // Sixth move (W retakes ko3) would recreate the starting position.
    const sixth = applyGoMove(board, 2, { row: 7, col: 1 }, history, false);
    expect(err(sixth)).toMatch(/superko/);
  });

  it('allows snapback (immediate recapture at the same point, position differs)', () => {
    // White chain with exactly two liberties (0,2) and (0,3).
    const start = b('XO..OX', 'XOOOOX', '.XXXX.', '......', '......', '......');
    const history = [keyOf(start)];

    // 1) Black throws in at (0,2): self-atari, one liberty at (0,3).
    const throwIn = ok(applyGoMove(start, 1, { row: 0, col: 2 }, history, false));
    expect(throwIn.captured).toBe(0);
    history.push(throwIn.positionKey);

    // 2) White captures the throw-in at (0,3); now the white chain has one liberty.
    const capture = ok(applyGoMove(throwIn.board, 2, { row: 0, col: 3 }, history, false));
    expect(capture.captured).toBe(1);
    history.push(capture.positionKey);

    // 3) Black replays (0,2) immediately, capturing the whole 7-stone chain.
    //    Legal with full history: the resulting position never occurred before.
    const snap = ok(applyGoMove(capture.board, 1, { row: 0, col: 2 }, history, false));
    expect(snap.captured).toBe(7);
    expect(countStones(snap.board).white).toBe(0);
    expect(history).not.toContain(snap.positionKey);
  });
});

// ---------------------------------------------------------------------------
// suicide
// ---------------------------------------------------------------------------

describe('suicide', () => {
  const singleSuicideBoard = b('.O.', 'O.O', '.O.');

  it('rejects single-stone suicide by default', () => {
    const res = applyGoMove(singleSuicideBoard, 1, { row: 1, col: 1 }, [], false);
    expect(err(res)).toMatch(/suicide/);
  });

  it('allows single-stone suicide under the flag (board unchanged)', () => {
    const res = ok(applyGoMove(singleSuicideBoard, 1, { row: 1, col: 1 }, [], true));
    expect(res.captured).toBe(0);
    expect(JSON.stringify(res.board)).toBe(JSON.stringify(singleSuicideBoard));
    expect(res.positionKey).toBe(keyOf(singleSuicideBoard));
  });

  it('single-stone suicide still falls to superko when the position is in history', () => {
    // A single-stone suicide recreates the current position exactly, so under
    // positional superko it is illegal whenever that position is in history.
    const k0 = keyOf(singleSuicideBoard);
    const res = applyGoMove(singleSuicideBoard, 1, { row: 1, col: 1 }, [k0], true);
    expect(err(res)).toMatch(/superko/);
  });

  const multiSuicideBoard = b('.OO.', 'OX.O', '.OO.');

  it('rejects multi-stone suicide by default', () => {
    const k0 = keyOf(multiSuicideBoard);
    const res = applyGoMove(multiSuicideBoard, 1, { row: 1, col: 2 }, [k0], false);
    expect(err(res)).toMatch(/suicide/);
  });

  it('allows multi-stone suicide under the flag (own chain removed)', () => {
    const k0 = keyOf(multiSuicideBoard);
    const res = ok(applyGoMove(multiSuicideBoard, 1, { row: 1, col: 2 }, [k0], true));
    expect(res.captured).toBe(0); // no opponent stones captured
    expect(res.board[1]![1]).toBe(0); // pre-existing own stone removed too
    expect(res.board[1]![2]).toBe(0);
    expect(countStones(res.board).white).toBe(6); // whites untouched
    expect(res.positionKey).not.toBe(k0); // position genuinely changed
  });

  it('a capturing move is never suicide even with allowSuicide=false', () => {
    const board = b('.XO.', 'XO.O', '.XO.', '....');
    const res = ok(applyGoMove(board, 1, { row: 1, col: 2 }, [keyOf(board)], false));
    expect(res.captured).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tromp-Taylor area scoring
// ---------------------------------------------------------------------------

describe('scoreArea', () => {
  it('empty 9x9 board: 0 - 0 + komi (empty region reaches neither color)', () => {
    const board: Board = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => 0));
    expect(scoreArea(board, 7.5)).toEqual({ black: 0, white: 7.5, winner: 2 });
    expect(scoreArea(board, 0)).toEqual({ black: 0, white: 0, winner: 0 });
  });

  it('empty 19x19 board: 0 - 0 + komi', () => {
    const board: Board = Array.from({ length: 19 }, () => Array.from({ length: 19 }, () => 0));
    expect(scoreArea(board, 7.5)).toEqual({ black: 0, white: 7.5, winner: 2 });
  });

  it('5x5 wall fixture: stones + territory, komi handling and ties', () => {
    // cols 0-1 empty (black territory), col 2 black wall, col 3 white wall,
    // col 4 empty (white territory).
    const board = b('..XO.', '..XO.', '..XO.', '..XO.', '..XO.');
    // black = 5 stones + 10 territory = 15; white raw = 5 stones + 5 territory = 10.
    expect(scoreArea(board, 0)).toEqual({ black: 15, white: 10, winner: 1 });
    expect(scoreArea(board, 5)).toEqual({ black: 15, white: 15, winner: 0 });
    expect(scoreArea(board, 7.5)).toEqual({ black: 15, white: 17.5, winner: 2 });
  });

  it('5x5 dame fixture: the shared middle column counts for no one', () => {
    // col 0 black territory, col 1 black wall, col 2 dame (touches both),
    // col 3 white wall, col 4 white territory.
    const board = b('.X.O.', '.X.O.', '.X.O.', '.X.O.', '.X.O.');
    // black = 5 + 5 = 10; white raw = 5 + 5 = 10; 5 dame points to no one.
    expect(scoreArea(board, 0)).toEqual({ black: 10, white: 10, winner: 0 });
    expect(scoreArea(board, 7.5)).toEqual({ black: 10, white: 17.5, winner: 2 });
  });

  it('7x7 seki fixture: shared liberties are neutral, stones still count', () => {
    // Top edge seki: white pair (0,3),(0,4) and the surrounding black chain
    // share liberties (0,2) and (0,5); neither empty point may score.
    const board = b(
      'XX.OO.X',
      'XXXXXXX',
      'OOOOOOO',
      '.......',
      'OOOOOOO',
      '.......',
      'OOOOOOO',
    );
    // black: 10 stones, no exclusive territory -> 10.
    // white raw: 23 stones + rows 3 and 5 (14 territory) = 37.
    // (0,2) and (0,5) reach both colors -> neutral. 10 + 37 + 2 = 49 points.
    expect(scoreArea(board, 0)).toEqual({ black: 10, white: 37, winner: 2 });
    expect(scoreArea(board, 7.5)).toEqual({ black: 10, white: 44.5, winner: 2 });
  });

  it('19x19 wall fixture: exact area score at full size', () => {
    // cols 0-8 empty (black), col 9 black wall, col 10 white wall,
    // cols 11-18 empty (white).
    const row = '.........XO........';
    const board = b(...Array.from({ length: 19 }, () => row));
    // black = 19 + 171 = 190; white raw = 19 + 152 = 171. 190 + 171 = 361.
    expect(scoreArea(board, 0)).toEqual({ black: 190, white: 171, winner: 1 });
    expect(scoreArea(board, 7.5)).toEqual({ black: 190, white: 178.5, winner: 1 });
  });

  it('full board with no empty points scores stones only', () => {
    const board = b('XXO', 'XOO', 'XXO');
    expect(scoreArea(board, 0)).toEqual({ black: 5, white: 4, winner: 1 });
  });

  it('an empty region enclosed by one color scores for that color (eye)', () => {
    const board = b('.X...', 'X.X..', '.X...', '.....', '.....');
    // The single point (1,1) reaches only black; the outside region reaches
    // only black too (no white stones anywhere) -> all empties are black's.
    expect(scoreArea(board, 0)).toEqual({ black: 25, white: 0, winner: 1 });
  });
});

// ---------------------------------------------------------------------------
// randomized 9x9 playouts: invariants under full legality
// ---------------------------------------------------------------------------

describe('random 9x9 playouts', () => {
  it(
    'plays 30 seeded playouts with stone-count, novelty, and score invariants',
    () => {
      const SIZE = 9;
      for (let seed = 1; seed <= 30; seed++) {
        const rand = rng(seed * 2654435761);
        let board: Board = Array.from({ length: SIZE }, () =>
          Array.from({ length: SIZE }, () => 0),
        );
        const history: string[] = [keyOf(board)];
        let player: 1 | 2 = 1;
        let passes = 0;

        for (let ply = 0; ply < 160 && passes < 2; ply++) {
          // Collect empty points, shuffle, try until a legal move is found.
          const empties: Array<{ row: number; col: number }> = [];
          for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
              if (board[r]![c] === 0) empties.push({ row: r, col: c });
            }
          }
          for (let i = empties.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            const tmp = empties[i]!;
            empties[i] = empties[j]!;
            empties[j] = tmp;
          }

          let played = false;
          for (const point of empties) {
            const res = applyGoMove(board, player, point, history, false);
            if ('error' in res) continue;

            // Invariant: accepted position is novel under positional superko.
            expect(history).not.toContain(res.positionKey);
            // Invariant: stone accounting balances exactly.
            const before = countStones(board);
            const after = countStones(res.board);
            expect(after.black + after.white).toBe(
              before.black + before.white + 1 - res.captured,
            );
            expect(res.captured).toBeGreaterThanOrEqual(0);
            // Invariant: every cell stays in {0,1,2}.
            for (const rowArr of res.board) {
              for (const v of rowArr) expect([0, 1, 2]).toContain(v);
            }

            history.push(res.positionKey);
            board = res.board;
            passes = 0;
            played = true;
            break;
          }
          if (!played) passes++;
          player = player === 1 ? 2 : 1;
        }

        // Score sanity: totals never exceed the board, komi applied to white.
        const stones = countStones(board);
        const score = scoreArea(board, 7.5);
        expect(score.black).toBeGreaterThanOrEqual(stones.black);
        expect(score.white - 7.5).toBeGreaterThanOrEqual(stones.white);
        expect(score.black + (score.white - 7.5)).toBeLessThanOrEqual(SIZE * SIZE);
        expect([0, 1, 2]).toContain(score.winner);
      }
    },
    { timeout: 600_000 },
  );
});
