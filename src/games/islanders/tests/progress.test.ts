import { describe, expect, it } from 'vitest';
import { isParseError } from '../../../kernel/types.ts';
import { parseMove } from '../notation.ts';
import { isTerminal, legalMoves, pathfinderMoves, type IslMove } from '../rules.ts';
import { craft, give, mustApply, mustReject, placeCity, placeRoad, placeVillage, seedForRoll } from './helpers.ts';

describe('islanders saga cards', () => {
  it('a bought card cannot be played the same turn, but an older copy can', () => {
    let s = craft(3);
    s.deck = ['warrior', 'landmark', 'tithe'];
    give(s, 'p0', { reed: 2, taro: 2, obsidian: 2 });
    s = mustApply(s, 'p0', { type: 'buy_progress' });
    expect(s.bought['p0']).toEqual(['warrior']);
    expect(s.progress['p0']).toEqual([]);
    expect(s.deck).toEqual(['landmark', 'tithe']);
    expect(s.hands['p0']).toEqual({ palm: 0, coral: 0, reed: 1, taro: 1, obsidian: 1 });
    // cannot play it this turn
    expect(mustReject(s, 'p0', { type: 'play_progress', card: 'warrior', hex: 'B', victim: '-' })).toBe(
      'bought_this_turn',
    );
    // an older copy in hand is playable even after buying another
    s.progress['p0'] = ['warrior'];
    const played = mustApply(s, 'p0', { type: 'play_progress', card: 'warrior', hex: 'B', victim: '-' });
    expect(played.progress['p0']).toEqual([]); // old copy consumed
    expect(played.bought['p0']).toEqual(['warrior']); // bought copy retained
    expect(played.warriors['p0']).toBe(1);
    expect(played.raider).toBe('B');
  });

  it('bought cards become playable after end_turn; only one card per turn', () => {
    let s = craft(3);
    s.deck = [];
    s.progress['p0'] = ['warrior', 'warrior'];
    s = mustApply(s, 'p0', { type: 'play_progress', card: 'warrior', hex: 'B', victim: '-' });
    expect(s.progressPlayed).toBe(true);
    expect(mustReject(s, 'p0', { type: 'play_progress', card: 'warrior', hex: 'C', victim: '-' })).toBe('one_per_turn');
    expect(legalMoves(s, 'p0').some((m) => m.type === 'play_progress')).toBe(false);
    // cycle a full round; p0 may play the second warrior next turn
    s = mustApply(s, 'p0', { type: 'end_turn' }, seedForRoll(2, (t) => t !== 7));
    s = mustApply(s, 'p1', { type: 'end_turn' }, seedForRoll(3, (t) => t !== 7));
    s = mustApply(s, 'p2', { type: 'end_turn' }, seedForRoll(4, (t) => t !== 7));
    expect(s.progressPlayed).toBe(false);
    s = mustApply(s, 'p0', { type: 'play_progress', card: 'warrior', hex: 'C', victim: '-' });
    expect(s.warriors['p0']).toBe(2);
  });

  it('end_turn moves bought cards into the playable pile', () => {
    let s = craft(3);
    s.deck = ['tithe'];
    give(s, 'p0', { reed: 1, taro: 1, obsidian: 1 });
    s = mustApply(s, 'p0', { type: 'buy_progress' });
    s = mustApply(s, 'p0', { type: 'end_turn' }, seedForRoll(2, (t) => t !== 7));
    expect(s.bought['p0']).toEqual([]);
    expect(s.progress['p0']).toEqual(['tithe']);
  });

  it('landmarks are never playable; they reveal themselves at the win check', () => {
    const s = craft(3);
    s.progress['p0'] = ['landmark'];
    const bogus = { type: 'play_progress', card: 'landmark' } as unknown as IslMove;
    expect(mustReject(s, 'p0', bogus)).toBe('bad_card');
    const parsed = parseMove('play_progress(landmark,B,-)', s, 'p0');
    expect(isParseError(parsed)).toBe(true);
    // 8 public VP + 2 hidden landmarks = win, revealed in the scores
    const w = craft(3);
    placeVillage(w, 'Aab', 'p0');
    placeVillage(w, 'Hgi', 'p0');
    placeVillage(w, 'Snr', 'p0');
    placeVillage(w, 'EFJ', 'p0');
    placeCity(w, 'JNO', 'p0');
    placeCity(w, 'MNQ', 'p0');
    w.progress['p0'] = ['landmark'];
    expect(isTerminal(w)).toBeNull(); // 9 VP
    w.progress['p0'] = ['landmark', 'landmark'];
    const result = isTerminal(w);
    expect(result?.winners).toEqual(['p0']);
    expect(result?.reason).toBe('points');
    expect(result?.scores?.['p0']).toBe(10);
    // a landmark bought this turn also counts toward the win
    w.progress['p0'] = ['landmark'];
    w.bought['p0'] = ['landmark'];
    expect(isTerminal(w)?.winners).toEqual(['p0']);
  });

  it('pathfinder lays two connected free roads (or one when two are impossible)', () => {
    const s = craft(3);
    s.progress['p0'] = ['pathfinder'];
    placeRoad(s, 'FJ', 'p0');
    const pairs = pathfinderMoves(s, 'p0');
    expect(pairs.every((m) => m.type === 'play_progress' && m.card === 'pathfinder' && m.edges.length === 2)).toBe(true);
    expect(mustReject(s, 'p0', { type: 'play_progress', card: 'pathfinder', edges: ['JK'] })).toBe('must_place_two');
    expect(mustReject(s, 'p0', { type: 'play_progress', card: 'pathfinder', edges: ['AB', 'BC'] })).toBe(
      'bad_placement', // not connected to p0's network
    );
    const played = mustApply(s, 'p0', { type: 'play_progress', card: 'pathfinder', edges: ['JK', 'JO'] });
    expect(played.roads['JK']).toBe('p0');
    expect(played.roads['JO']).toBe('p0');
    expect(played.hands['p0']).toEqual({ palm: 0, coral: 0, reed: 0, taro: 0, obsidian: 0 }); // free
    expect(played.supply['p0']!['roads']).toBe(12);
    // with one road left in supply, a single placement is allowed
    const one = craft(3);
    one.progress['p0'] = ['pathfinder'];
    placeRoad(one, 'FJ', 'p0');
    one.supply['p0']!['roads'] = 1;
    const single = mustApply(one, 'p0', { type: 'play_progress', card: 'pathfinder', edges: ['JK'] });
    expect(single.roads['JK']).toBe('p0');
  });

  it('bounty takes exactly two bank resources (one when the bank is almost empty)', () => {
    const s = craft(3);
    s.progress['p0'] = ['bounty'];
    const played = mustApply(s, 'p0', { type: 'play_progress', card: 'bounty', take: { palm: 1, obsidian: 1 } });
    expect(played.hands['p0']!['palm']).toBe(1);
    expect(played.hands['p0']!['obsidian']).toBe(1);
    expect(played.bank['palm']).toBe(18);
    expect(mustReject(s, 'p0', { type: 'play_progress', card: 'bounty', take: { palm: 1 } })).toBe('bad_move');
    expect(mustReject(s, 'p0', { type: 'play_progress', card: 'bounty', take: { palm: 3 } })).toBe('bad_move');
    // nearly-empty bank: only one card total left
    const empty = craft(3);
    empty.progress['p0'] = ['bounty'];
    for (const r of ['palm', 'coral', 'reed', 'taro', 'obsidian']) empty.bank[r] = 0;
    empty.bank['taro'] = 1;
    const one = mustApply(empty, 'p0', { type: 'play_progress', card: 'bounty', take: { taro: 1 } });
    expect(one.hands['p0']!['taro']).toBe(1);
    expect(one.bank['taro']).toBe(0);
  });

  it('tithe collects every card of one resource from all opponents', () => {
    const s = craft(4);
    s.progress['p0'] = ['tithe'];
    give(s, 'p1', { palm: 3, coral: 1 });
    give(s, 'p2', { palm: 2 });
    const bankBefore = s.bank['palm']!;
    const played = mustApply(s, 'p0', { type: 'play_progress', card: 'tithe', resource: 'palm' });
    expect(played.hands['p0']!['palm']).toBe(5);
    expect(played.hands['p1']!['palm']).toBe(0);
    expect(played.hands['p1']!['coral']).toBe(1); // untouched
    expect(played.hands['p2']!['palm']).toBe(0);
    expect(played.hands['p3']!['palm']).toBe(0);
    expect(played.bank['palm']).toBe(bankBefore); // bank not involved
  });

  it('cannot play a card you do not hold; buying needs the deck and the cost', () => {
    const s = craft(3);
    expect(mustReject(s, 'p0', { type: 'play_progress', card: 'tithe', resource: 'palm' })).toBe('not_held');
    expect(mustReject(s, 'p0', { type: 'buy_progress' })).toBe('cannot_pay');
    const broke = craft(3);
    broke.deck = [];
    give(broke, 'p0', { reed: 1, taro: 1, obsidian: 1 });
    expect(mustReject(broke, 'p0', { type: 'buy_progress' })).toBe('deck_empty');
  });
});
