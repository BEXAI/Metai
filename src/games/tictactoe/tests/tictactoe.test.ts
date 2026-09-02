import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../crypto/canonical.ts';
import { finalHashOfPlayout, runPlayouts } from '../../../kernel/playout.ts';
import { createSeedStream } from '../../../kernel/seed.ts';
import { isParseError, isRuleError, type Json } from '../../../kernel/types.ts';
import game from '../index.ts';

const SEED = sha256Hex('ttt-test-seed');

function playSeq(moves: string[]): Json {
  const seed = createSeedStream(SEED);
  let state = game.initialState(seed, ['p0', 'p1'], {});
  for (const notation of moves) {
    const player = game.playersToMove(state)[0]!;
    const move = game.parseMove(notation, state, player);
    if (isParseError(move)) throw new Error(move.message);
    const applied = game.apply(state, player, move, seed);
    if (isRuleError(applied)) throw new Error(`${notation}: ${applied.message}`);
    state = applied.state;
  }
  return state;
}

describe('tictactoe rules', () => {
  it('has 9 opening moves in canonical order and X (p0) moves first', () => {
    const state = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    expect(game.playersToMove(state)).toEqual(['p0']);
    expect(game.legalMoves(state, 'p0')).toEqual([
      'a1', 'b1', 'c1', 'a2', 'b2', 'c2', 'a3', 'b3', 'c3',
    ]);
    expect(game.legalMoves(state, 'p1')).toEqual([]);
  });

  it('X wins on the a1-b2-c3 diagonal', () => {
    const state = playSeq(['a1', 'b1', 'b2', 'c1', 'c3']);
    expect(game.isTerminal(state)).toEqual({
      winners: ['p0'],
      draw: false,
      reason: 'three_in_a_row',
    });
    expect(game.playersToMove(state)).toEqual([]);
    expect(game.legalMoves(state, 'p1')).toEqual([]);
  });

  it('a full board without a line is a draw', () => {
    const state = playSeq(['b2', 'a1', 'c3', 'c1', 'a3', 'b3', 'b1', 'a2', 'c2']);
    expect(game.isTerminal(state)).toEqual({ winners: [], draw: true, reason: 'board_full' });
  });

  it('rejects occupied cells and out-of-turn moves', () => {
    const seed = createSeedStream(SEED);
    let state = game.initialState(seed, ['p0', 'p1'], {});
    const applied = game.apply(state, 'p0', 'b2', seed);
    if (isRuleError(applied)) throw new Error(applied.message);
    state = applied.state;
    const occupied = game.apply(state, 'p1', 'b2', seed);
    expect(isRuleError(occupied) && occupied.code).toBe('occupied');
    const wrongTurn = game.apply(state, 'p0', 'a1', seed);
    expect(isRuleError(wrongTurn) && wrongTurn.code).toBe('not_your_turn');
  });

  it('parses only a1..c3 and round-trips notation', () => {
    const state = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    expect(game.parseMove('b2', state, 'p0')).toBe('b2');
    expect(isParseError(game.parseMove('d4', state, 'p0'))).toBe(true);
    expect(isParseError(game.parseMove('a0', state, 'p0'))).toBe(true);
    expect(isParseError(game.parseMove('#3', state, 'p0'))).toBe(true);
    for (const m of game.legalMoves(state, 'p0')) {
      expect(game.parseMove(game.moveToNotation(m, state), state, 'p0')).toEqual(m);
    }
  });

  it('encodeState/decodeState round-trips exactly', () => {
    const state = playSeq(['b2', 'a1', 'c3']);
    expect(game.decodeState(game.encodeState(state))).toEqual(state);
  });

  it('renders the board with coordinates and status', () => {
    const state = playSeq(['b2', 'a1']);
    const text = game.renderText(state, null);
    expect(text).toContain('a b c');
    expect(text).toContain('Last move: a1');
    expect(text).toContain('X (p0) to move');
  });
});

describe('tictactoe playouts', () => {
  it('survives 200 random playouts', { timeout: 600_000 }, () => {
    const stats = runPlayouts(game, { games: 200, seedPrefix: 'ttt-colo' });
    expect(stats.games).toBe(200);
    expect(stats.maxMoves).toBeLessThanOrEqual(9);
    const finished = stats.draws + Object.values(stats.winsBySeat).reduce((a, b) => a + b, 0);
    expect(finished).toBe(200);
  });

  it('is deterministic for identical seeds (gate A2 local half)', () => {
    const a = finalHashOfPlayout(game, sha256Hex('ttt-d1'), sha256Hex('ttt-d2'), 2);
    const b = finalHashOfPlayout(game, sha256Hex('ttt-d1'), sha256Hex('ttt-d2'), 2);
    expect(a).toEqual(b);
  });
});
