/**
 * Unit tests for buildView + legalMoveEntries (spec §llm_player_protocol.view_object),
 * including the >5000-legal-moves guard.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../crypto/canonical.ts';
import { createSeedStream } from '../seed.ts';
import { CONTENT_BOUNDARY, type AnyGame, type HistoryEntry, type Json } from '../types.ts';
import { buildView, legalMoveEntries, type BuildViewOptions } from '../view.ts';
import { fixtureGame, type NimState } from './fixture-game.ts';

function freshState(): NimState {
  const seed = createSeedStream(sha256Hex('view-test-seed'));
  return fixtureGame.initialState(seed, ['p0', 'p1'], { total: 4 });
}

function opts(extra?: Partial<BuildViewOptions>): BuildViewOptions {
  return {
    gameId: 'g_view_0001',
    turnIndex: 3,
    phase: 'main',
    deadlineUtc: '2026-01-01T00:01:00.000Z',
    history: [],
    rulesCard: 'Take 1-3 tokens per turn; whoever takes the last token wins.',
    ...extra,
  };
}

describe('legalMoveEntries', () => {
  it('returns { index, move, notation, summary } in canonical order', () => {
    const state = freshState();
    const player = fixtureGame.playersToMove(state)[0]!;
    const entries = legalMoveEntries(fixtureGame as AnyGame, state, player);
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(entries.map((e) => e.move)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.notation)).toEqual(['take1', 'take2', 'take3']);
    expect(entries[0]!.summary).toBe('takes 1, leaving 3');
  });

  it('returns [] for a player who is not to move', () => {
    const state = freshState();
    const mover = fixtureGame.playersToMove(state)[0]!;
    const other = mover === 'p0' ? 'p1' : 'p0';
    expect(legalMoveEntries(fixtureGame as AnyGame, state, other)).toEqual([]);
  });
});

describe('buildView', () => {
  it('assembles every ViewObject field from the game and options', () => {
    const state = freshState();
    const player = fixtureGame.playersToMove(state)[0]!;
    const view = buildView(fixtureGame as AnyGame, state, player, opts());

    expect(view.game_id).toBe('g_view_0001');
    expect(view.you).toEqual({ player, seat: Number(player.slice(1)) });
    expect(view.turn_index).toBe(3);
    expect(view.phase).toBe('main');
    expect(view.deadline_utc).toBe('2026-01-01T00:01:00.000Z');
    expect(view.board_text).toBe(fixtureGame.renderText(state, player));
    expect(view.board_text).toContain(`viewer=${player}`);
    expect(view.state_string).toBe(fixtureGame.encodeState(state));
    expect(view.public).toEqual(state);
    expect(view.private).toEqual(state);
    expect(view.legal_moves).toHaveLength(3);
    expect(view.legal_moves[2]).toMatchObject({ index: 2, move: 3, notation: 'take3' });
    expect(view.rules_card).toContain('last token wins');
    expect(view.boundary).toBe(CONTENT_BOUNDARY);
  });

  it('ships only the last 20 history entries', () => {
    const state = freshState();
    const player = fixtureGame.playersToMove(state)[0]!;
    const history: HistoryEntry[] = Array.from({ length: 25 }, (_, i) => ({
      turnIndex: i,
      player: i % 2 === 0 ? 'p0' : 'p1',
      notation: `take${(i % 3) + 1}`,
      commentary: `untrusted note ${i}`,
    }));
    const view = buildView(fixtureGame as AnyGame, state, player, opts({ history }));
    expect(view.history).toHaveLength(20);
    expect(view.history[0]!.turnIndex).toBe(5); // oldest 5 dropped
    expect(view.history[19]!.turnIndex).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// >5000-moves guard
// ---------------------------------------------------------------------------

function makeWideGame(nMoves: number, paged: boolean): AnyGame {
  const boom = (): never => {
    throw new Error('not used by buildView');
  };
  const moves = Array.from({ length: nMoves }, (_, i) => i as Json);
  const game: AnyGame = {
    meta: {
      id: 'wide_fixture',
      name: 'Wide Fixture',
      players: { min: 2, max: 2 },
      information: 'perfect',
      randomness: 'none',
      variants: {},
      notation: 'mN',
      boardText: 'none',
      listed: false,
    },
    initialState: boom,
    playersToMove: () => ['p0'],
    legalMoves: () => moves,
    apply: boom,
    isTerminal: () => null,
    publicView: () => null,
    privateView: () => null,
    renderText: () => 'wide',
    encodeState: () => 'wide',
    decodeState: boom,
    parseMove: boom,
    moveToNotation: (move) => `m${String(move)}`,
  };
  if (paged) {
    game.legalMovesPaged = (_state, _player, page) => ({
      moves: moves.slice(page * 1000, (page + 1) * 1000),
      total: nMoves,
      pageSize: 1000,
    });
  }
  return game;
}

describe('buildView large-move-set guard', () => {
  it('throws when legal moves exceed 5000 and legalMovesPaged is missing', () => {
    const wide = makeWideGame(5001, false);
    expect(() => buildView(wide, null, 'p0', opts())).toThrowError(/legalMovesPaged/);
  });

  it('does not throw at exactly 5000 moves', () => {
    const wide = makeWideGame(5000, false);
    const view = buildView(wide, null, 'p0', opts());
    expect(view.legal_moves).toHaveLength(5000);
  });

  it('truncates to the cap when legalMovesPaged exists', () => {
    const wide = makeWideGame(6000, true);
    const view = buildView(wide, null, 'p0', opts());
    expect(view.legal_moves).toHaveLength(5000);
    expect(view.legal_moves[4999]).toMatchObject({ index: 4999, move: 4999, notation: 'm4999' });
  });

  it('honors a custom maxMoves option', () => {
    const wide = makeWideGame(50, true);
    const view = buildView(wide, null, 'p0', opts({ maxMoves: 10 }));
    expect(view.legal_moves).toHaveLength(10);
    expect(() => buildView(makeWideGame(50, false), null, 'p0', opts({ maxMoves: 10 }))).toThrowError(
      /legalMovesPaged/,
    );
  });
});
