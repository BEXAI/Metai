import { describe, expect, it } from 'vitest';
import { bankRate, legalMoves, playersToMove, type IslMove, type IslState } from '../rules.ts';
import { craft, give, mustApply, mustReject, placeVillage, seedForRoll } from './helpers.ts';

describe('islanders bank trades and harbors', () => {
  it('base rate is 4:1', () => {
    const s = craft(3);
    give(s, 'p0', { palm: 8 });
    expect(bankRate(s, 'p0', 'palm')).toBe(4);
    const t = mustApply(s, 'p0', { type: 'trade_bank', give: 'palm', get: 'taro' });
    expect(t.hands['p0']!['palm']).toBe(4);
    expect(t.hands['p0']!['taro']).toBe(1);
    expect(t.bank['palm']).toBe(19 - 8 + 4);
    expect(t.bank['taro']).toBe(18);
  });

  it('a village on an any-harbor gives 3:1; on a resource harbor 2:1 for that resource', () => {
    const s = craft(3);
    placeVillage(s, 'Ccd', 'p0'); // Cc = 3:1 any harbor
    expect(bankRate(s, 'p0', 'palm')).toBe(3);
    expect(bankRate(s, 'p0', 'obsidian')).toBe(3);
    const s2 = craft(3);
    placeVillage(s2, 'Aab', 'p0'); // Aa = 2:1 palm harbor
    expect(bankRate(s2, 'p0', 'palm')).toBe(2);
    expect(bankRate(s2, 'p0', 'coral')).toBe(4); // resource harbor helps only its resource
    give(s2, 'p0', { palm: 2 });
    const t = mustApply(s2, 'p0', { type: 'trade_bank', give: 'palm', get: 'reed' });
    expect(t.hands['p0']).toEqual({ palm: 0, coral: 0, reed: 1, taro: 0, obsidian: 0 });
    // harbors belong to whoever holds the vertex — not to other players
    expect(bankRate(s2, 'p1', 'palm')).toBe(4);
  });

  it('legalMoves offers a trade only at the best affordable rate', () => {
    const s = craft(3);
    give(s, 'p0', { palm: 3 });
    expect(legalMoves(s, 'p0').filter((m) => m.type === 'trade_bank').length).toBe(0); // 3 < 4
    placeVillage(s, 'Ccd', 'p0'); // now 3:1
    const trades = legalMoves(s, 'p0').filter((m) => m.type === 'trade_bank');
    expect(trades.length).toBe(4); // palm for each other resource
  });

  it('rejects self-trades, unaffordable trades, and an empty bank', () => {
    const s = craft(3);
    give(s, 'p0', { palm: 4 });
    expect(mustReject(s, 'p0', { type: 'trade_bank', give: 'palm', get: 'palm' })).toBe('bad_move');
    expect(mustReject(s, 'p0', { type: 'trade_bank', give: 'coral', get: 'palm' })).toBe('cannot_pay');
    s.bank['taro'] = 0;
    expect(mustReject(s, 'p0', { type: 'trade_bank', give: 'palm', get: 'taro' })).toBe('bank_short');
  });
});

describe('islanders player-to-player offers', () => {
  function offerState(): IslState {
    const s = craft(3);
    give(s, 'p0', { palm: 2 });
    give(s, 'p2', { taro: 1 });
    return s;
  }

  it('offer then accept transfers both sides; only the recipient may answer', () => {
    let s = offerState();
    s = mustApply(s, 'p0', { type: 'offer', give: { palm: 2 }, get: { taro: 1 }, to: 'p2' });
    expect(playersToMove(s)).toEqual(['p2']);
    expect(legalMoves(s, 'p1')).toEqual([]);
    expect(legalMoves(s, 'p0')).toEqual([]);
    expect(mustReject(s, 'p1', { type: 'accept', id: 1 })).toBe('not_your_turn');
    s = mustApply(s, 'p2', { type: 'accept', id: 1 });
    expect(s.hands['p0']).toEqual({ palm: 0, coral: 0, reed: 0, taro: 1, obsidian: 0 });
    expect(s.hands['p2']).toEqual({ palm: 2, coral: 0, reed: 0, taro: 0, obsidian: 0 });
    expect(s.offer).toBeNull();
    expect(playersToMove(s)).toEqual(['p0']);
  });

  it('accept is only legal when the recipient can pay', () => {
    let s = craft(3);
    give(s, 'p0', { palm: 1 });
    s = mustApply(s, 'p0', { type: 'offer', give: { palm: 1 }, get: { obsidian: 2 }, to: 'p1' });
    const p1moves = legalMoves(s, 'p1');
    expect(p1moves.some((m) => m.type === 'accept')).toBe(false);
    expect(p1moves.some((m) => m.type === 'reject')).toBe(true);
    expect(mustReject(s, 'p1', { type: 'accept', id: 1 })).toBe('not_held');
  });

  it('reject leaves hands unchanged and returns the turn to the offerer', () => {
    let s = offerState();
    s = mustApply(s, 'p0', { type: 'offer', give: { palm: 2 }, get: { taro: 1 }, to: 'p2' });
    s = mustApply(s, 'p2', { type: 'reject', id: 1 });
    expect(s.hands['p0']!['palm']).toBe(2);
    expect(s.hands['p2']!['taro']).toBe(1);
    expect(s.offer).toBeNull();
    expect(playersToMove(s)).toEqual(['p0']);
  });

  it('one counter is allowed, then the original offerer accepts or rejects', () => {
    let s = offerState();
    s = mustApply(s, 'p0', { type: 'offer', give: { palm: 1 }, get: { taro: 1 }, to: 'p2' });
    s = mustApply(s, 'p2', { type: 'counter', id: 1, give: { taro: 1 }, get: { palm: 2 } });
    expect(playersToMove(s)).toEqual(['p0']);
    // no second counter, from either side
    expect(mustReject(s, 'p0', { type: 'counter', id: 1, give: { palm: 1 }, get: { taro: 1 } })).toBe('counter_once');
    expect(mustReject(s, 'p2', { type: 'counter', id: 1, give: { taro: 1 }, get: { palm: 1 } })).toBe('not_your_turn');
    s = mustApply(s, 'p0', { type: 'accept', id: 1 });
    // countered terms: p2 gives 1 taro, receives 2 palm
    expect(s.hands['p0']).toEqual({ palm: 0, coral: 0, reed: 0, taro: 1, obsidian: 0 });
    expect(s.hands['p2']).toEqual({ palm: 2, coral: 0, reed: 0, taro: 0, obsidian: 0 });
  });

  it('a player may initiate at most 3 offers per turn; the count resets at end_turn', () => {
    let s = craft(3);
    give(s, 'p0', { palm: 6 });
    for (let i = 0; i < 3; i++) {
      s = mustApply(s, 'p0', { type: 'offer', give: { palm: 1 }, get: { taro: 1 }, to: 'p1' });
      s = mustApply(s, 'p1', { type: 'reject', id: i + 1 });
    }
    expect(s.offersMade).toBe(3);
    expect(mustReject(s, 'p0', { type: 'offer', give: { palm: 1 }, get: { taro: 1 }, to: 'p1' })).toBe('offer_limit');
    expect(legalMoves(s, 'p0').some((m) => m.type === 'offer')).toBe(false);
    s = mustApply(s, 'p0', { type: 'end_turn' }, seedForRoll(2, (t) => t !== 7));
    expect(s.offersMade).toBe(0);
  });

  it('offers are structured and bounded: totals 1-2 per side, at most 3 combined, no shared resource', () => {
    const s = craft(3);
    give(s, 'p0', { palm: 4, coral: 4 });
    const bad = (give_: Record<string, number>, get: Record<string, number>): string =>
      mustReject(s, 'p0', { type: 'offer', give: give_, get, to: 'p1' } as IslMove);
    expect(bad({ palm: 2 }, { taro: 2 })).toBe('bad_offer'); // 2:2 not offered
    expect(bad({ palm: 3 }, { taro: 1 })).toBe('bad_offer');
    expect(bad({ palm: 1 }, { palm: 1 })).toBe('bad_offer'); // shared resource
    expect(bad({}, { taro: 1 })).toBe('bad_offer');
    expect(mustReject(s, 'p0', { type: 'offer', give: { obsidian: 1 }, get: { taro: 1 }, to: 'p1' })).toBe('not_held');
    expect(mustReject(s, 'p0', { type: 'offer', give: { palm: 1 }, get: { taro: 1 }, to: 'p0' })).toBe('bad_move');
    // enumerated offer list matches the documented shapes
    const offers = legalMoves(s, 'p0').filter((m) => m.type === 'offer');
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      if (o.type !== 'offer') continue;
      const gt = Object.values(o.give).reduce((a, b) => a + b, 0);
      const wt = Object.values(o.get).reduce((a, b) => a + b, 0);
      expect(gt).toBeGreaterThanOrEqual(1);
      expect(gt).toBeLessThanOrEqual(2);
      expect(wt).toBeGreaterThanOrEqual(1);
      expect(wt).toBeLessThanOrEqual(2);
      expect(gt + wt).toBeLessThanOrEqual(3);
      for (const k of Object.keys(o.give)) expect(o.get[k] ?? 0).toBe(0);
    }
  });

  it('a counter must be affordable for the responder', () => {
    let s = offerState();
    s = mustApply(s, 'p0', { type: 'offer', give: { palm: 1 }, get: { taro: 1 }, to: 'p2' });
    expect(mustReject(s, 'p2', { type: 'counter', id: 1, give: { obsidian: 1 }, get: { palm: 1 } })).toBe('not_held');
  });
});
