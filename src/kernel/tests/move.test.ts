/**
 * Unit tests for the shared move resolver (src/kernel/move.ts). It is the one
 * implementation behind rooms/core.ts#resolveMove and kernel/verify.ts#resolveMove,
 * so these tests pin the ladder, the DISCRIMINATED failure shape both callers
 * format their own (differing) messages from, and the bindUtterance step.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../crypto/canonical.ts';
import { resolveSubmittedMove } from '../move.ts';
import { createSeedStream } from '../seed.ts';
import { type AnyGame, type Json } from '../types.ts';
import { fixtureGame, type NimState } from './fixture-game.ts';

function nim(): { game: AnyGame; state: Json; player: string } {
  const seed = createSeedStream(sha256Hex('move-test-seed'));
  const state = fixtureGame.initialState(seed, ['p0', 'p1'], { total: 4 }) as NimState;
  return {
    game: fixtureGame as AnyGame,
    state: state as unknown as Json,
    player: fixtureGame.playersToMove(state)[0]!,
  };
}

describe('resolveSubmittedMove ladder', () => {
  it('resolves { index } against legalMoves', () => {
    const { game, state, player } = nim();
    expect(resolveSubmittedMove(game, state, player, { move: { index: 2 } })).toEqual({ ok: true, move: 3 });
  });

  it("resolves the '#n' notation fallback", () => {
    const { game, state, player } = nim();
    expect(resolveSubmittedMove(game, state, player, { move: '#0' })).toEqual({ ok: true, move: 1 });
    expect(resolveSubmittedMove(game, state, player, { move: '  #1  ' })).toEqual({ ok: true, move: 2 });
  });

  it('resolves notation through the game parser', () => {
    const { game, state, player } = nim();
    expect(resolveSubmittedMove(game, state, player, { move: 'take3' })).toEqual({ ok: true, move: 3 });
  });
});

describe('resolveSubmittedMove failures', () => {
  it("rejects a non-integer or negative index as 'bad_index_type'", () => {
    const { game, state, player } = nim();
    for (const index of [1.5, -1, '2', null, undefined]) {
      expect(resolveSubmittedMove(game, state, player, { move: { index } as unknown as Json })).toEqual({
        ok: false,
        reason: 'bad_index_type',
        via: 'index',
      });
    }
  });

  it('reports index_out_of_range with the operands each caller formats', () => {
    const { game, state, player } = nim();
    expect(resolveSubmittedMove(game, state, player, { move: { index: 9 } })).toEqual({
      ok: false,
      reason: 'index_out_of_range',
      via: 'index',
      index: 9,
      legalCount: 3,
    });
    // via distinguishes the two: verify.ts words the hash form 'index #9'.
    expect(resolveSubmittedMove(game, state, player, { move: '#9' })).toEqual({
      ok: false,
      reason: 'index_out_of_range',
      via: 'hash',
      index: 9,
      legalCount: 3,
    });
  });

  it("rejects a non-string, non-object move as 'bad_move_shape'", () => {
    const { game, state, player } = nim();
    for (const move of [null, 42, true, undefined]) {
      expect(resolveSubmittedMove(game, state, player, { move })).toEqual({
        ok: false,
        reason: 'bad_move_shape',
      });
    }
  });

  it("treats an array move as a bad index, matching rooms/core.ts's branch order", () => {
    const { game, state, player } = nim();
    expect(resolveSubmittedMove(game, state, player, { move: [1, 2] })).toEqual({
      ok: false,
      reason: 'bad_index_type',
      via: 'index',
    });
  });

  it('carries the notation and the parser message on a parse failure', () => {
    const { game, state, player } = nim();
    const out = resolveSubmittedMove(game, state, player, { move: 'take9' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('parse_error');
    expect(out.notation).toBe('take9');
    expect(out.parseMessage).toContain('take9');
  });
});

// ---------------------------------------------------------------------------
// bindUtterance. Speech games only; absent hook => byte-identical resolution.
// ---------------------------------------------------------------------------

type SpeechMove = { t: string; text: string };

function speechGame(): AnyGame {
  const boom = (): never => {
    throw new Error('not used by resolveSubmittedMove');
  };
  const moves: Json[] = [
    { t: 'say', text: '' },
    { t: 'accuse', text: '' },
  ];
  return {
    meta: {
      id: 'speech_fixture',
      name: 'Speech Fixture',
      players: { min: 2, max: 2 },
      information: 'hidden',
      randomness: 'none',
      variants: {},
      notation: 'say | accuse',
      boardText: 'none',
      listed: false,
      speechLimit: 20,
    },
    initialState: boom,
    playersToMove: () => ['p0'],
    legalMoves: () => moves,
    apply: boom,
    isTerminal: () => null,
    publicView: () => null,
    privateView: () => null,
    renderText: () => 'speech',
    encodeState: () => 'speech',
    decodeState: boom,
    parseMove: (input) => (input === 'accuse' ? { t: 'accuse', text: '' } : { t: 'say', text: '' }),
    moveToNotation: (move) => (move as SpeechMove).t,
    // Inline text wins; an utterance fills only an empty slot, and is capped.
    bindUtterance: (move, utterance) => {
      const m = move as SpeechMove;
      if (m.text !== '') return m;
      return { ...m, text: utterance.slice(0, 20) };
    },
  };
}

describe('resolveSubmittedMove bindUtterance', () => {
  it('binds on all three ladder paths', () => {
    const game = speechGame();
    const utterance = 'p3 has been quiet';
    expect(resolveSubmittedMove(game, null, 'p0', { move: { index: 1 }, utterance })).toEqual({
      ok: true,
      move: { t: 'accuse', text: utterance },
    });
    expect(resolveSubmittedMove(game, null, 'p0', { move: '#1', utterance })).toEqual({
      ok: true,
      move: { t: 'accuse', text: utterance },
    });
    expect(resolveSubmittedMove(game, null, 'p0', { move: 'accuse', utterance })).toEqual({
      ok: true,
      move: { t: 'accuse', text: utterance },
    });
  });

  it('does not bind an absent, empty or non-string utterance', () => {
    const game = speechGame();
    const silent = { ok: true, move: { t: 'say', text: '' } };
    expect(resolveSubmittedMove(game, null, 'p0', { move: { index: 0 } })).toEqual(silent);
    expect(resolveSubmittedMove(game, null, 'p0', { move: { index: 0 }, utterance: '' })).toEqual(silent);
    expect(resolveSubmittedMove(game, null, 'p0', { move: { index: 0 }, utterance: 12 })).toEqual(silent);
  });

  it('ignores an utterance entirely when the game has no binder', () => {
    const { game, state, player } = nim();
    expect(resolveSubmittedMove(game, state, player, { move: { index: 0 }, utterance: 'hello' })).toEqual({
      ok: true,
      move: 1,
    });
  });
});
