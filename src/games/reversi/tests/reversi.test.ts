import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../crypto/canonical.ts';
import { finalHashOfPlayout, runPlayouts } from '../../../kernel/playout.ts';
import { createSeedStream } from '../../../kernel/seed.ts';
import { isParseError, isRuleError, type Json } from '../../../kernel/types.ts';
import game from '../index.ts';
import type { ReversiState } from '../rules.ts';

const SEED = sha256Hex('reversi-test-seed');

/** Builds a state from cell->disc assignments ('d4' -> 'W'), row 1 at the top. */
function stateWith(
  discs: Record<string, 'B' | 'W'>,
  toMove: number,
  passes = 0,
): ReversiState {
  const cells = Array.from({ length: 64 }, () => '.');
  for (const [cell, ch] of Object.entries(discs)) {
    const col = cell.charCodeAt(0) - 97;
    const row = cell.charCodeAt(1) - 49;
    cells[row * 8 + col] = ch;
  }
  return { board: cells.join(''), toMove, passes, moveCount: 0, lastMove: null };
}

function apply(state: Json, player: string, move: string): Json {
  const applied = game.apply(state, player, move, createSeedStream(SEED));
  if (isRuleError(applied)) throw new Error(`${move}: ${applied.message}`);
  return applied.state;
}

function boardOf(state: Json): string {
  return (state as { board: string }).board;
}

function cellAt(board: string, cell: string): string {
  const col = cell.charCodeAt(0) - 97;
  const row = cell.charCodeAt(1) - 49;
  return board[row * 8 + col]!;
}

describe('reversi rules', () => {
  it('opens with the four classic Black moves in canonical order', () => {
    const state = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    expect(game.playersToMove(state)).toEqual(['p0']);
    expect(game.legalMoves(state, 'p0')).toEqual(['d3', 'c4', 'f5', 'e6']);
    expect(game.legalMoves(state, 'p1')).toEqual([]);
  });

  it('flips the flanked disc and gives White the three classic replies', () => {
    const initial = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    const state = apply(initial, 'p0', 'd3');
    const board = boardOf(state);
    expect(cellAt(board, 'd3')).toBe('B');
    expect(cellAt(board, 'd4')).toBe('B'); // flipped
    expect(cellAt(board, 'e5')).toBe('W');
    expect(game.legalMoves(state, 'p1')).toEqual(['c3', 'e3', 'c5']);
  });

  it('flips a whole line of three', () => {
    const state = stateWith({ a1: 'B', b1: 'W', c1: 'W', d1: 'W' }, 0);
    const next = apply(state, 'p0', 'e1');
    const board = boardOf(next);
    for (const cell of ['a1', 'b1', 'c1', 'd1', 'e1']) expect(cellAt(board, cell)).toBe('B');
  });

  it('forces pass when no flanking move exists, and passing resets on a real move', () => {
    // Black a1, White a2, Black a3: Black cannot flank anywhere -> must pass;
    // White then flanks a3 by playing a4.
    const state = stateWith({ a1: 'B', a2: 'W', a3: 'B' }, 0);
    expect(game.legalMoves(state, 'p0')).toEqual(['pass']);
    const afterPass = apply(state, 'p0', 'pass');
    expect((afterPass as { passes: number }).passes).toBe(1);
    expect(game.isTerminal(afterPass)).toBeNull();
    expect(game.legalMoves(afterPass, 'p1')).toContain('a4');
    const afterMove = apply(afterPass, 'p1', 'a4');
    expect((afterMove as { passes: number }).passes).toBe(0);
    expect(cellAt(boardOf(afterMove), 'a3')).toBe('W');
  });

  it('rejects pass while a flanking move exists', () => {
    const initial = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    const rejected = game.apply(initial, 'p0', 'pass', createSeedStream(SEED));
    expect(isRuleError(rejected) && rejected.code).toBe('pass_illegal');
  });

  it('rejects non-flanking placements and occupied cells', () => {
    const initial = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    const noFlank = game.apply(initial, 'p0', 'a1', createSeedStream(SEED));
    expect(isRuleError(noFlank) && noFlank.code).toBe('no_flank');
    const occupied = game.apply(initial, 'p0', 'd4', createSeedStream(SEED));
    expect(isRuleError(occupied) && occupied.code).toBe('occupied');
  });

  it('ends after two consecutive passes and scores the discs', () => {
    // Isolated discs: neither side can ever flank.
    const state = stateWith({ a1: 'B', h8: 'W' }, 0);
    const p1 = apply(state, 'p0', 'pass');
    expect(game.isTerminal(p1)).toBeNull();
    const p2 = apply(p1, 'p1', 'pass');
    expect(game.isTerminal(p2)).toEqual({
      winners: [],
      draw: true,
      scores: { p0: 1, p1: 1 },
      reason: 'most_discs',
    });
  });

  it('ends immediately on a full board with the disc majority winning', () => {
    const board = 'B'.repeat(40) + 'W'.repeat(24);
    const state: ReversiState = { board, toMove: 1, passes: 0, moveCount: 60, lastMove: 'h8' };
    expect(game.isTerminal(state)).toEqual({
      winners: ['p0'],
      draw: false,
      scores: { p0: 40, p1: 24 },
      reason: 'most_discs',
    });
    expect(game.playersToMove(state)).toEqual([]);
  });

  it("parses only a1..h8 and 'pass'", () => {
    const state = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    expect(game.parseMove('d3', state, 'p0')).toBe('d3');
    expect(game.parseMove('PASS', state, 'p0')).toBe('pass');
    expect(isParseError(game.parseMove('i5', state, 'p0'))).toBe(true);
    expect(isParseError(game.parseMove('a9', state, 'p0'))).toBe(true);
    expect(isParseError(game.parseMove('3d', state, 'p0'))).toBe(true);
    for (const m of game.legalMoves(state, 'p0')) {
      expect(game.parseMove(game.moveToNotation(m, state), state, 'p0')).toEqual(m);
    }
  });

  it('encodeState/decodeState round-trips exactly', () => {
    const initial = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    expect(game.decodeState(game.encodeState(initial))).toEqual(initial);
    const mid = apply(initial, 'p0', 'd3');
    expect(game.decodeState(game.encodeState(mid))).toEqual(mid);
    const passed = apply(stateWith({ a1: 'B', a2: 'W', a3: 'B' }, 0), 'p0', 'pass');
    expect(game.decodeState(game.encodeState(passed))).toEqual(passed);
  });

  it('renders the board with coordinates, disc counts, and status', () => {
    const initial = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    const text = game.renderText(initial, null);
    expect(text).toContain('a b c d e f g h');
    expect(text).toContain('Discs: B 2 — W 2');
    expect(text).toContain('B (p0) to move');
  });
});

describe('reversi playouts', () => {
  it('survives 200 random playouts', { timeout: 600_000 }, () => {
    const stats = runPlayouts(game, { games: 200, seedPrefix: 'reversi-colo' });
    expect(stats.games).toBe(200);
    const finished = stats.draws + Object.values(stats.winsBySeat).reduce((a, b) => a + b, 0);
    expect(finished).toBe(200);
    expect(stats.reasons['most_discs']).toBe(200);
  });

  it('is deterministic for identical seeds (gate A2 local half)', () => {
    const a = finalHashOfPlayout(game, sha256Hex('rev-d1'), sha256Hex('rev-d2'), 2);
    const b = finalHashOfPlayout(game, sha256Hex('rev-d1'), sha256Hex('rev-d2'), 2);
    expect(a).toEqual(b);
  });
});
