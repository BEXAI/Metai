import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../crypto/canonical.ts';
import { hashState } from '../../../kernel/hash.ts';
import { createSeedStream } from '../../../kernel/seed.ts';
import type { GameEvent, Json } from '../../../kernel/types.ts';
import {
  applyMove,
  discardCombos,
  legalMoves,
  playersToMove,
  produce,
  type IslState,
} from '../rules.ts';
import { craft, give, mustApply, mustReject, placeCity, placeVillage, seedForRoll } from './helpers.ts';

describe('islanders production', () => {
  // hex B: token 2 (the only 2), marsh -> reed. Vertices ABb and BCc are on B.
  function productionBoard(): IslState {
    const s = craft(3);
    placeVillage(s, 'ABb', 'p1');
    placeCity(s, 'BCc', 'p2');
    return s;
  }

  it('pays villages 1 and cities 2, to all players including non-movers', () => {
    const s = productionBoard();
    const events: GameEvent[] = [];
    produce(s, 2, events);
    expect(s.hands['p1']!['reed']).toBe(1);
    expect(s.hands['p2']!['reed']).toBe(2);
    expect(s.hands['p0']!['reed']).toBe(0);
    expect(s.bank['reed']).toBe(19 - 3);
  });

  it('the raider blocks production on its hex', () => {
    const s = productionBoard();
    s.raider = 'B';
    const events: GameEvent[] = [];
    produce(s, 2, events);
    expect(s.hands['p1']!['reed']).toBe(0);
    expect(s.hands['p2']!['reed']).toBe(0);
  });

  it('bank shortage: several claimants get nothing, a lone claimant gets the rest', () => {
    const s = productionBoard();
    s.bank['reed'] = 2; // owed 3 across two players -> nobody paid
    const events: GameEvent[] = [];
    produce(s, 2, events);
    expect(s.hands['p1']!['reed']).toBe(0);
    expect(s.hands['p2']!['reed']).toBe(0);
    expect(s.bank['reed']).toBe(2);
    expect(events.some((e) => e.type === 'production_shortage')).toBe(true);

    const s2 = craft(3);
    placeCity(s2, 'BCc', 'p2'); // only claimant, owed 2
    s2.bank['reed'] = 1;
    produce(s2, 2, []);
    expect(s2.hands['p2']!['reed']).toBe(1); // takes what remains
    expect(s2.bank['reed']).toBe(0);
  });

  it('end_turn rolls the seeded dice and distributes production', () => {
    const s = productionBoard();
    const next = mustApply(s, 'p0', { type: 'end_turn' }, seedForRoll(2, (t) => t === 2));
    expect(next.turn).toBe(2);
    expect(next.lastRoll).toBe(2);
    expect(next.phase).toBe('main');
    expect(playersToMove(next)).toEqual(['p1']);
    expect(next.hands['p1']!['reed']).toBe(1);
    expect(next.hands['p2']!['reed']).toBe(2);
  });
});

describe('islanders seven: discard-half then raider', () => {
  function sevenState(): IslState {
    const s = craft(3);
    give(s, 'p0', { palm: 4, coral: 4 }); // 8 cards -> discards floor(8/2) = 4
    give(s, 'p1', { reed: 5, taro: 4 }); // 9 cards -> discards floor(9/2) = 4
    give(s, 'p2', { palm: 2 }); // 2 cards -> exempt
    placeVillage(s, 'ABb', 'p0');
    return mustApply(s, 'p0', { type: 'end_turn' }, seedForRoll(2, (t) => t === 7));
  }

  it('a 7 puts every player over 7 cards into one simultaneous discard phase', () => {
    const s = sevenState();
    expect(s.lastRoll).toBe(7);
    expect(s.phase).toBe('discard');
    expect(s.discardDue).toEqual({ p0: 4, p1: 4 });
    expect(playersToMove(s)).toEqual(['p0', 'p1']); // simultaneous
    expect(legalMoves(s, 'p2')).toEqual([]);
    // discard move lists are complete: 4 palm/coral split 5 ways for p0
    const p0moves = legalMoves(s, 'p0');
    expect(p0moves.length).toBe(5);
    expect(discardCombos(s.hands['p0']!, 4).length).toBe(5);
  });

  it('the raider cannot move until every discard is in; dues are exact and from the hand', () => {
    let s = sevenState();
    expect(mustReject(s, 'p1', { type: 'move_bandit', hex: 'B', victim: 'p0' })).toBe('bad_phase');
    expect(mustReject(s, 'p0', { type: 'discard', cards: { palm: 3 } })).toBe('wrong_count');
    expect(mustReject(s, 'p0', { type: 'discard', cards: { reed: 4 } })).toBe('not_held');
    expect(mustReject(s, 'p2', { type: 'discard', cards: { palm: 2 } })).toBe('not_your_turn');
    s = mustApply(s, 'p0', { type: 'discard', cards: { palm: 2, coral: 2 } });
    expect(s.phase).toBe('discard');
    expect(playersToMove(s)).toEqual(['p1']);
    expect(s.hands['p0']).toEqual({ palm: 2, coral: 2, reed: 0, taro: 0, obsidian: 0 });
    s = mustApply(s, 'p1', { type: 'discard', cards: { reed: 2, taro: 2 } });
    expect(s.phase).toBe('raider');
    expect(playersToMove(s)).toEqual(['p1']); // turn 2 roller
    expect(s.bank['palm']).toBe(19 - 4 - 2 + 2); // 4 to p0, 2 to p2, 2 discarded back
  });

  it('a 7 with nobody over 7 cards goes straight to the raider', () => {
    const s = craft(3);
    give(s, 'p0', { palm: 7 });
    const next = mustApply(s, 'p0', { type: 'end_turn' }, seedForRoll(2, (t) => t === 7));
    expect(next.phase).toBe('raider');
    expect(next.discardDue).toEqual({});
  });
});

describe('islanders raider and the seeded steal', () => {
  function raiderState(): IslState {
    const s = craft(3, { phase: 'raider', turn: 2, currentSeat: 1 });
    placeVillage(s, 'ABb', 'p0');
    give(s, 'p0', { palm: 2, coral: 2 });
    return s;
  }

  it('victim rules: must name an eligible victim, or - when there is none', () => {
    const s = raiderState();
    expect(mustReject(s, 'p1', { type: 'move_bandit', hex: 'J', victim: 'x' })).toBe('bad_hex'); // J is raider hex
    expect(mustReject(s, 'p1', { type: 'move_bandit', hex: 'B', victim: '-' })).toBe('bad_victim'); // p0 is there
    expect(mustReject(s, 'p1', { type: 'move_bandit', hex: 'B', victim: 'p2' })).toBe('bad_victim');
    expect(mustReject(s, 'p1', { type: 'move_bandit', hex: 'Q', victim: 'p0' })).toBe('bad_victim'); // nobody at Q
    const moved = mustApply(s, 'p1', { type: 'move_bandit', hex: 'Q', victim: '-' });
    expect(moved.raider).toBe('Q');
    expect(moved.phase).toBe('main');
  });

  it('the stolen card comes from the seed (purpose steal:turn:N) and is deterministic', () => {
    const s = raiderState();
    const seedHex = sha256Hex('steal-fixture');
    const applied = applyMove(s, 'p1', { type: 'move_bandit', hex: 'B', victim: 'p0' }, createSeedStream(seedHex));
    if ('error' in applied) throw new Error(applied.message);
    const next = applied.state;
    // recompute the draw: p0's hand flattens to [palm,palm,coral,coral]
    const idx = createSeedStream(seedHex).int('steal:turn:2', 4);
    const expected = idx < 2 ? 'palm' : 'coral';
    expect(next.hands['p1']![expected]).toBe(1);
    expect(next.hands['p0']![expected]).toBe(expected === 'palm' ? 1 : 1);
    expect(next.hands['p0']!['palm']! + next.hands['p0']!['coral']!).toBe(3);
    // determinism: identical pre-state + seed -> identical post-state hash
    const applied2 = applyMove(s, 'p1', { type: 'move_bandit', hex: 'B', victim: 'p0' }, createSeedStream(seedHex));
    if ('error' in applied2) throw new Error(applied2.message);
    expect(hashState(next as unknown as Json)).toBe(hashState(applied2.state as unknown as Json));
    // the steal is logged privately to thief and victim only
    const priv = applied.events.find((e) => e.type === 'stolen_card');
    expect(priv?.visibility).toBe('private');
    expect(priv?.to?.sort()).toEqual(['p0', 'p1']);
  });
});
