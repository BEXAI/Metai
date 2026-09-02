import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../crypto/canonical.ts';
import { finalHashOfPlayout, runPlayouts } from '../../../kernel/playout.ts';
import { createSeedStream } from '../../../kernel/seed.ts';
import { isParseError, isRuleError, type Json } from '../../../kernel/types.ts';
import game from '../index.ts';

const SEED = sha256Hex('drop-test-seed');

function playSeq(moves: string[], assertRunningUntilLast = false): Json {
  const seed = createSeedStream(SEED);
  let state = game.initialState(seed, ['p0', 'p1'], {});
  for (let i = 0; i < moves.length; i++) {
    if (assertRunningUntilLast) expect(game.isTerminal(state)).toBeNull();
    const player = game.playersToMove(state)[0]!;
    const applied = game.apply(state, player, moves[i]!, seed);
    if (isRuleError(applied)) throw new Error(`${moves[i]!}: ${applied.message}`);
    state = applied.state;
  }
  return state;
}

describe('connect_drop rules', () => {
  it('offers all seven columns initially, X (p0) first', () => {
    const state = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    expect(game.playersToMove(state)).toEqual(['p0']);
    expect(game.legalMoves(state, 'p0')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(game.legalMoves(state, 'p1')).toEqual([]);
  });

  it('detects a vertical four', () => {
    const state = playSeq(['a', 'b', 'a', 'b', 'a', 'b', 'a'], true);
    expect(game.isTerminal(state)).toEqual({ winners: ['p0'], draw: false, reason: 'four_in_a_row' });
  });

  it('detects a horizontal four', () => {
    const state = playSeq(['a', 'a', 'b', 'b', 'c', 'c', 'd'], true);
    expect(game.isTerminal(state)).toEqual({ winners: ['p0'], draw: false, reason: 'four_in_a_row' });
  });

  it('detects a diagonal four', () => {
    const state = playSeq(
      ['d', 'c', 'c', 'b', 'b', 'g', 'b', 'g', 'a', 'a', 'a', 'g', 'a'],
      true,
    );
    expect(game.isTerminal(state)).toEqual({ winners: ['p0'], draw: false, reason: 'four_in_a_row' });
  });

  it('excludes and rejects drops into a full column', () => {
    const seed = createSeedStream(SEED);
    const state = playSeq(['a', 'a', 'a', 'a', 'a', 'a']);
    expect(game.isTerminal(state)).toBeNull();
    expect(game.legalMoves(state, 'p0')).toEqual(['b', 'c', 'd', 'e', 'f', 'g']);
    const full = game.apply(state, 'p0', 'a', seed);
    expect(isRuleError(full) && full.code).toBe('column_full');
  });

  it('draws on a full board with no four in a row', () => {
    const state = game.decodeState('XXOOXX/OOXXOO/XXOOXX/OOXXOO/XXOOXX/OOXXOO/XOXOXO 0 42 g');
    expect(game.isTerminal(state)).toEqual({ winners: [], draw: true, reason: 'board_full' });
  });

  it('parses only column letters a..g', () => {
    const state = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    expect(game.parseMove('d', state, 'p0')).toBe('d');
    expect(game.parseMove(' E ', state, 'p0')).toBe('e');
    expect(isParseError(game.parseMove('h', state, 'p0'))).toBe(true);
    expect(isParseError(game.parseMove('a1', state, 'p0'))).toBe(true);
    for (const m of game.legalMoves(state, 'p0')) {
      expect(game.parseMove(game.moveToNotation(m, state), state, 'p0')).toEqual(m);
    }
  });

  it('encodeState/decodeState round-trips exactly', () => {
    const initial = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    expect(game.decodeState(game.encodeState(initial))).toEqual(initial);
    const mid = playSeq(['d', 'd', 'c', 'e']);
    expect(game.decodeState(game.encodeState(mid))).toEqual(mid);
  });

  it('renders the board with coordinates and status', () => {
    const state = playSeq(['d', 'd']);
    const text = game.renderText(state, null);
    expect(text).toContain('a b c d e f g');
    expect(text).toContain('Last move: d');
    expect(text).toContain('X (p0) to move');
  });
});

describe('connect_drop playouts', () => {
  it('survives 200 random playouts', { timeout: 600_000 }, () => {
    const stats = runPlayouts(game, { games: 200, seedPrefix: 'drop-colo' });
    expect(stats.games).toBe(200);
    expect(stats.maxMoves).toBeLessThanOrEqual(42);
    const finished = stats.draws + Object.values(stats.winsBySeat).reduce((a, b) => a + b, 0);
    expect(finished).toBe(200);
  });

  it('is deterministic for identical seeds (gate A2 local half)', () => {
    const a = finalHashOfPlayout(game, sha256Hex('drop-d1'), sha256Hex('drop-d2'), 2);
    const b = finalHashOfPlayout(game, sha256Hex('drop-d1'), sha256Hex('drop-d2'), 2);
    expect(a).toEqual(b);
  });
});
