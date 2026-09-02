import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../crypto/canonical.ts';
import { finalHashOfPlayout, runPlayouts } from '../../../kernel/playout.ts';
import { createSeedStream } from '../../../kernel/seed.ts';
import { isParseError, isRuleError, type Json, type VariantConfig } from '../../../kernel/types.ts';
import game from '../index.ts';
import { squareCount, type CheckersState, type CheckersVariant } from '../rules.ts';

const SEED = sha256Hex('checkers-test-seed');

/**
 * Builds a state from square->piece assignments (hand-verified fixtures).
 * Square numbering: 1..32 (english) / 1..50 (international), left to right,
 * top to bottom; black on low numbers moving down, white moving up.
 */
function stateWith(
  variant: CheckersVariant,
  pieces: Record<number, string>,
  toMove: 'b' | 'w',
  extra: Partial<Pick<CheckersState, 'quietClock' | 'rep'>> = {},
): CheckersState {
  const cells = Array.from({ length: squareCount(variant) }, () => '.');
  for (const [sq, ch] of Object.entries(pieces)) cells[Number(sq) - 1] = ch;
  const board = cells.join('');
  return {
    variant,
    board,
    toMove,
    quietClock: extra.quietClock ?? 0,
    moveCount: 0,
    lastMove: null,
    rep: extra.rep ?? { [board + toMove]: 1 },
  };
}

function legalPaths(state: Json, player: string): number[][] {
  return game.legalMoves(state, player) as number[][];
}

function apply(state: Json, player: string, path: number[]): Json {
  const applied = game.apply(state, player, path, createSeedStream(SEED));
  if (isRuleError(applied)) throw new Error(`${path.join('x')}: ${applied.message}`);
  return applied.state;
}

function pieceAt(state: Json, sq: number): string {
  return (state as CheckersState).board[sq - 1]!;
}

describe('checkers english rules', () => {
  it('opens with the seven standard Black moves in canonical order', () => {
    const state = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    expect(game.playersToMove(state)).toEqual(['p0']); // Black moves first
    expect(legalPaths(state, 'p0')).toEqual([
      [9, 13], [9, 14], [10, 14], [10, 15], [11, 15], [11, 16], [12, 16],
    ]);
    expect(game.legalMoves(state, 'p1')).toEqual([]);
  });

  it('fixture 1: a single capture is mandatory and quiet moves are rejected', () => {
    // Black man 14, White man 18: 14x23 (over 18) is the only legal move.
    const state = stateWith('english', { 14: 'b', 18: 'w' }, 'b');
    expect(legalPaths(state, 'p0')).toEqual([[14, 23]]);
    const quiet = game.apply(state, 'p0', [14, 17], createSeedStream(SEED));
    expect(isRuleError(quiet) && quiet.code).toBe('capture_mandatory');
    const next = apply(state, 'p0', [14, 23]);
    expect(pieceAt(next, 23)).toBe('b');
    expect(pieceAt(next, 18)).toBe('.');
    expect(pieceAt(next, 14)).toBe('.');
    // White has no pieces left -> White cannot move -> Black wins.
    expect(game.isTerminal(next)).toEqual({ winners: ['p0'], draw: false, reason: 'no_moves' });
  });

  it('fixture 2: other pieces may not move quietly while any capture exists', () => {
    const state = stateWith('english', { 14: 'b', 18: 'w', 5: 'b' }, 'b');
    expect(legalPaths(state, 'p0')).toEqual([[14, 23]]); // man on 5 is frozen
  });

  it('fixture 3: a double jump is one move and crowning ends it', () => {
    // Black man 13 jumps 17 and 26: 13x22x31, crowned on 31.
    const state = stateWith('english', { 13: 'b', 17: 'w', 26: 'w' }, 'b');
    expect(legalPaths(state, 'p0')).toEqual([[13, 22, 31]]);
    const next = apply(state, 'p0', [13, 22, 31]);
    expect(pieceAt(next, 31)).toBe('B'); // crowned
    for (const sq of [13, 17, 22, 26]) expect(pieceAt(next, sq)).toBe('.');
  });

  it('fixture 4: a triple jump chain is enumerated as one complete move', () => {
    // Black man 6 jumps 10, 19, 27: 6x15x24x31.
    const state = stateWith('english', { 6: 'b', 10: 'w', 19: 'w', 27: 'w' }, 'b');
    expect(legalPaths(state, 'p0')).toEqual([[6, 15, 24, 31]]);
    expect(game.moveToNotation([6, 15, 24, 31], state)).toBe('6x15x24x31');
    const next = apply(state, 'p0', [6, 15, 24, 31]);
    expect(pieceAt(next, 31)).toBe('B');
    for (const sq of [6, 10, 15, 19, 24, 27]) expect(pieceAt(next, sq)).toBe('.');
  });

  it('fixture 5: kings move and capture both ways', () => {
    // Quiet: black king on 18 has all four diagonal steps.
    const quiet = stateWith('english', { 18: 'B', 5: 'W' }, 'b');
    expect(legalPaths(quiet, 'p0')).toEqual([[18, 14], [18, 15], [18, 22], [18, 23]]);
    // Capture: black king on 23 jumps backward (up the board) over 19.
    const jump = stateWith('english', { 23: 'B', 19: 'w', 1: 'W' }, 'b');
    expect(legalPaths(jump, 'p0')).toEqual([[23, 16]]);
    const next = apply(jump, 'p0', [23, 16]);
    expect(pieceAt(next, 16)).toBe('B');
    expect(pieceAt(next, 19)).toBe('.');
  });

  it('fixture 6: english offers every maximal chain (no majority rule)', () => {
    // Black man 10: 10x17x26 (two pieces) and 10x19 (one piece) both legal.
    const state = stateWith('english', { 10: 'b', 14: 'w', 15: 'w', 22: 'w' }, 'b');
    expect(legalPaths(state, 'p0')).toEqual([[10, 17, 26], [10, 19]]);
  });

  it('fixture 7: a man crowning by capture stops even when a king-jump would continue', () => {
    // White man 11 jumps 7 and crowns on 2; the would-be continuation 2x9
    // (over 6) must NOT be part of the move.
    const state = stateWith('english', { 11: 'w', 7: 'b', 6: 'b' }, 'w');
    expect(legalPaths(state, 'p1')).toEqual([[11, 2]]);
    const next = apply(state, 'p1', [11, 2]);
    expect(pieceAt(next, 2)).toBe('W'); // crowned, move over
    expect(pieceAt(next, 7)).toBe('.');
    expect(pieceAt(next, 6)).toBe('b'); // survived
  });

  it('draws by threefold repetition of position-with-side-to-move', () => {
    let state: Json = stateWith('english', { 5: 'B', 28: 'W' }, 'b');
    const cycle: [string, number[]][] = [
      ['p0', [5, 1]], ['p1', [28, 32]], ['p0', [1, 5]], ['p1', [32, 28]],
    ];
    for (let round = 0; round < 2; round++) {
      for (const [player, path] of cycle) {
        expect(game.isTerminal(state)).toBeNull();
        state = apply(state, player, path);
      }
    }
    expect(game.isTerminal(state)).toEqual({
      winners: [],
      draw: true,
      reason: 'threefold_repetition',
    });
  });

  it('draws after 80 quiet plies (40 moves by each side)', () => {
    const state = stateWith('english', { 5: 'B', 28: 'W' }, 'b', { quietClock: 79 });
    expect(game.isTerminal(state)).toBeNull();
    const next = apply(state, 'p0', [5, 1]);
    expect(game.isTerminal(next)).toEqual({ winners: [], draw: true, reason: 'forty_move_rule' });
  });

  it('resets the quiet clock on captures and man moves', () => {
    const capture = stateWith('english', { 14: 'b', 18: 'w', 30: 'w' }, 'b', { quietClock: 50 });
    expect((apply(capture, 'p0', [14, 23]) as CheckersState).quietClock).toBe(0);
    const manMove = stateWith('english', { 9: 'b', 30: 'W' }, 'b', { quietClock: 50 });
    expect((apply(manMove, 'p0', [9, 13]) as CheckersState).quietClock).toBe(0);
    const kingMove = stateWith('english', { 5: 'B', 28: 'W' }, 'b', { quietClock: 50 });
    expect((apply(kingMove, 'p0', [5, 1]) as CheckersState).quietClock).toBe(51);
  });
});

describe('checkers international rules', () => {
  const VAR = { ruleset: 'international' };

  it('opens with White (p0) and nine forward man moves', () => {
    const state = game.initialState(createSeedStream(SEED), ['p0', 'p1'], VAR);
    expect(game.playersToMove(state)).toEqual(['p0']); // White moves first
    const paths = legalPaths(state, 'p0');
    expect(paths).toHaveLength(9);
    expect(paths[0]).toEqual([31, 26]);
    expect(paths[8]).toEqual([35, 30]);
  });

  it('fixture 8: a flying king captures at distance with every landing square offered', () => {
    // White king 46, black man 37 on the long diagonal: land on 32..5.
    const state = stateWith('international', { 46: 'W', 37: 'b' }, 'w');
    expect(legalPaths(state, 'p0')).toEqual([
      [46, 5], [46, 10], [46, 14], [46, 19], [46, 23], [46, 28], [46, 32],
    ]);
    const next = apply(state, 'p0', [46, 19]);
    expect(pieceAt(next, 19)).toBe('W');
    expect(pieceAt(next, 37)).toBe('.');
  });

  it('fixture 9: majority rule keeps only the maximum-capture chain', () => {
    // White man 28: 28x17 captures one, 28x19x10 captures two -> only the latter.
    const state = stateWith('international', { 28: 'w', 22: 'b', 23: 'b', 14: 'b' }, 'w');
    expect(legalPaths(state, 'p0')).toEqual([[28, 19, 10]]);
    const minor = game.apply(state, 'p0', [28, 17], createSeedStream(SEED));
    expect(isRuleError(minor) && minor.code).toBe('not_maximal_capture');
  });

  it('fixture 10: men capture backward', () => {
    // White man 28 jumps down the board over 32, landing on 37.
    const state = stateWith('international', { 28: 'w', 32: 'b' }, 'w');
    expect(legalPaths(state, 'p0')).toEqual([[28, 37]]);
    const next = apply(state, 'p0', [28, 37]);
    expect(pieceAt(next, 37)).toBe('w'); // still a man
  });

  it('fixture 11: a man passing through the crowning row mid-chain is not crowned', () => {
    // White man 11 jumps 7 (landing on crowning square 2), must continue over
    // 8 to 13, and stays a man because the move did not END on row 0.
    const state = stateWith('international', { 11: 'w', 7: 'b', 8: 'b' }, 'w');
    expect(legalPaths(state, 'p0')).toEqual([[11, 2, 13]]);
    const next = apply(state, 'p0', [11, 2, 13]);
    expect(pieceAt(next, 13)).toBe('w'); // NOT crowned
    expect(pieceAt(next, 2)).toBe('.');
    expect(pieceAt(next, 7)).toBe('.');
    expect(pieceAt(next, 8)).toBe('.');
  });

  it('fixture 12: a flying king slides any distance on quiet moves', () => {
    const state = stateWith('international', { 46: 'W', 5: 'b' }, 'w');
    const paths = legalPaths(state, 'p0');
    // Long diagonal 46-41-37-32-28-23-19-14-10 (5 is occupied by the enemy).
    expect(paths).toContainEqual([46, 41]);
    expect(paths).toContainEqual([46, 10]);
    expect(paths).not.toContainEqual([46, 5]);
    expect(paths).toHaveLength(8);
  });
});

describe('checkers notation and codec', () => {
  it('parses quiet moves and jump chains, rejecting malformed input', () => {
    const english = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    expect(game.parseMove('11-15', english, 'p0')).toEqual([11, 15]);
    expect(game.parseMove('11x18x25', english, 'p0')).toEqual([11, 18, 25]);
    expect(isParseError(game.parseMove('11-15-19', english, 'p0'))).toBe(true); // quiet = 2 squares
    expect(isParseError(game.parseMove('11x18-25', english, 'p0'))).toBe(true); // mixed separators
    expect(isParseError(game.parseMove('0-4', english, 'p0'))).toBe(true);
    expect(isParseError(game.parseMove('33-29', english, 'p0'))).toBe(true); // out of range on 8x8
    expect(isParseError(game.parseMove('e4', english, 'p0'))).toBe(true);
    const intl = game.initialState(createSeedStream(SEED), ['p0', 'p1'], { ruleset: 'international' });
    expect(game.parseMove('33-29', intl, 'p0')).toEqual([33, 29]); // in range on 10x10
    expect(isParseError(game.parseMove('51-46', intl, 'p0'))).toBe(true);
  });

  it('round-trips every legal move through notation in fixture positions', () => {
    const states: Json[] = [
      game.initialState(createSeedStream(SEED), ['p0', 'p1'], {}),
      stateWith('english', { 10: 'b', 14: 'w', 15: 'w', 22: 'w' }, 'b'),
      stateWith('international', { 46: 'W', 37: 'b' }, 'w'),
    ];
    for (const state of states) {
      const player = game.playersToMove(state)[0]!;
      for (const move of game.legalMoves(state, player)) {
        const notation = game.moveToNotation(move, state);
        expect(game.parseMove(notation, state, player)).toEqual(move);
      }
    }
  });

  it('uses x for jumps and - for quiet moves', () => {
    const jump = stateWith('english', { 14: 'b', 18: 'w' }, 'b');
    expect(game.moveToNotation([14, 23], jump)).toBe('14x23');
    const quiet = stateWith('english', { 9: 'b', 30: 'W' }, 'b');
    expect(game.moveToNotation([9, 13], quiet)).toBe('9-13');
    // International flying-king capture at distance is still an x-move.
    const fly = stateWith('international', { 46: 'W', 37: 'b' }, 'w');
    expect(game.moveToNotation([46, 19], fly)).toBe('46x19');
    // ...while a long quiet slide is a - move.
    const slide = stateWith('international', { 46: 'W', 5: 'b' }, 'w');
    expect(game.moveToNotation([46, 10], slide)).toBe('46-10');
  });

  it('encodeState/decodeState round-trips exactly, including the repetition table', () => {
    const variants: VariantConfig[] = [{}, { ruleset: 'international' }];
    for (const variant of variants) {
      let state = game.initialState(createSeedStream(SEED), ['p0', 'p1'], variant);
      expect(game.decodeState(game.encodeState(state))).toEqual(state);
      const player = game.playersToMove(state)[0]!;
      state = apply(state, player, legalPaths(state, player)[0]!);
      expect(game.decodeState(game.encodeState(state))).toEqual(state);
    }
    // A state with an accumulated repetition table.
    let cyc: Json = stateWith('english', { 5: 'B', 28: 'W' }, 'b');
    cyc = apply(cyc, 'p0', [5, 1]);
    cyc = apply(cyc, 'p1', [28, 32]);
    expect(game.decodeState(game.encodeState(cyc))).toEqual(cyc);
  });

  it('renders the numbered board with legend and status', () => {
    const state = game.initialState(createSeedStream(SEED), ['p0', 'p1'], {});
    const text = game.renderText(state, null);
    expect(text).toContain('b1');
    expect(text).toContain('w32');
    expect(text).toContain('.16');
    expect(text).toContain('Black (b, p0) to move');
  });
});

describe('checkers playouts', () => {
  it('survives 200 random english playouts', { timeout: 600_000 }, () => {
    const stats = runPlayouts(game, { games: 200, seedPrefix: 'checkers-colo' });
    expect(stats.games).toBe(200);
    const finished = stats.draws + Object.values(stats.winsBySeat).reduce((a, b) => a + b, 0);
    expect(finished).toBe(200);
  });

  it('survives 100 random international playouts', { timeout: 600_000 }, () => {
    const stats = runPlayouts(game, {
      games: 100,
      seedPrefix: 'checkers-intl-colo',
      variant: { ruleset: 'international' },
    });
    expect(stats.games).toBe(100);
    const finished = stats.draws + Object.values(stats.winsBySeat).reduce((a, b) => a + b, 0);
    expect(finished).toBe(100);
  });

  it('is deterministic for identical seeds (gate A2 local half)', { timeout: 600_000 }, () => {
    const a = finalHashOfPlayout(game, sha256Hex('chk-d1'), sha256Hex('chk-d2'), 2);
    const b = finalHashOfPlayout(game, sha256Hex('chk-d1'), sha256Hex('chk-d2'), 2);
    expect(a).toEqual(b);
    const c = finalHashOfPlayout(game, sha256Hex('chk-i1'), sha256Hex('chk-i2'), 2, {
      ruleset: 'international',
    });
    const d = finalHashOfPlayout(game, sha256Hex('chk-i1'), sha256Hex('chk-i2'), 2, {
      ruleset: 'international',
    });
    expect(c).toEqual(d);
  });
});
