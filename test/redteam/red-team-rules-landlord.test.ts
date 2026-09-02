/**
 * RED TEAM red-team-rules — landlord (spec
 * games.M3_hidden_information_and_trading.landlord, acceptance A6).
 * Attacks: malformed structured offers (apply must return RuleError, never
 * throw — a thrown TypeError can kill a room/verifier), non-string notes,
 * auction tie/step/cap rules and the zero-eligible-bidder auction, even-build
 * leapfrogging with prev-state immutability, detention exit rules including
 * the forced-fine bankruptcy, and the 150-round net-worth tiebreak.
 */

import { describe, expect, it } from 'vitest';
import { hashJson, sha256Hex } from '../../src/crypto/canonical.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { isRuleError, type Json } from '../../src/kernel/types.ts';
import landlord from '../../src/games/landlord/index.ts';
import {
  applyMove,
  legalMovesFor,
  makeInitialState,
  netWorth,
  terminalResult,
  toMove,
  type LandlordMove,
  type LandlordState,
} from '../../src/games/landlord/rules.ts';
import { findRollSeed, grant } from '../../src/games/landlord/tests/helpers.ts';

const seed = (tag = 'redteam-rules-landlord') => createSeedStream(sha256Hex(tag));

function fresh(n = 2, tag = 'rt-landlord'): LandlordState {
  const st = makeInitialState(seed(tag), Array.from({ length: n }, (_, i) => `p${i}`), {});
  st.current = 'p0';
  return st;
}

function manage(n = 2): LandlordState {
  const st = fresh(n);
  st.phase = 'manage';
  return st;
}

describe('malformed structured offers MUST be RuleErrors, never exceptions (spec: only structured offers)', () => {
  it('an offer without give/get bundles is rejected structurally', () => {
    const st = manage();
    let out: unknown;
    expect(() => {
      out = applyMove(st, 'p0', { t: 'offer', to: 'p1' } as unknown as LandlordMove, seed());
    }).not.toThrow();
    expect(isRuleError(out)).toBe(true);
  });

  it('bundles of the wrong JSON shape are rejected structurally', () => {
    const st = manage();
    const bads: unknown[] = [
      { t: 'offer', to: 'p1', give: null, get: { cash: 0, props: [], writs: 0 } },
      { t: 'offer', to: 'p1', give: { cash: '10', props: [], writs: 0 }, get: { cash: 0, props: [], writs: 0 } },
      { t: 'offer', to: 'p1', give: { cash: 10, props: 'cinder', writs: 0 }, get: { cash: 0, props: [], writs: 0 } },
      { t: 'offer', to: 'p1', give: 7, get: [] },
      { t: 'counter', id: 1, give: null, get: null },
    ];
    for (const bad of bads) {
      let out: unknown;
      expect(() => {
        out = applyMove(st, 'p0', bad as LandlordMove, seed());
      }).not.toThrow();
      expect(isRuleError(out)).toBe(true);
    }
  });

  it('a non-string note is rejected (the 280-char cap must not be bypassed by type confusion)', () => {
    const st = manage();
    const r = applyMove(
      st,
      'p0',
      { t: 'offer', to: 'p1', give: { cash: 10, props: [], writs: 0 }, get: { cash: 0, props: [], writs: 0 }, note: 12345 } as unknown as LandlordMove,
      seed(),
    );
    expect(isRuleError(r)).toBe(true);
  });

  it('an overlong note is rejected', () => {
    const st = manage();
    const r = applyMove(
      st,
      'p0',
      { t: 'offer', to: 'p1', give: { cash: 10, props: [], writs: 0 }, get: { cash: 0, props: [], writs: 0 }, note: 'x'.repeat(281) },
      seed(),
    );
    expect(isRuleError(r)).toBe(true);
  });
});

describe('auction rules (structured ascending, ties to the earlier bid, 3 rounds max)', () => {
  function auctionState(cash: Record<string, number> = {}): LandlordState {
    const st = fresh(3);
    st.phase = 'buy_or_auction';
    st.pendingProp = 'cinder';
    for (const [p, c] of Object.entries(cash)) st.cash[p] = c;
    return st;
  }

  it('an equal bid is illegal — the earlier bidder keeps the high', () => {
    let st = auctionState();
    const dec = applyMove(st, 'p0', { t: 'decline' }, seed());
    if (isRuleError(dec)) throw new Error(dec.message);
    st = dec.state;
    expect(st.phase).toBe('auction');
    const b1 = applyMove(st, 'p0', { t: 'auction_bid', amount: 50 }, seed());
    if (isRuleError(b1)) throw new Error(b1.message);
    st = b1.state;
    const tie = applyMove(st, 'p1', { t: 'auction_bid', amount: 50 }, seed());
    expect(isRuleError(tie)).toBe(true);
    const low = applyMove(st, 'p1', { t: 'auction_bid', amount: 40 }, seed());
    expect(isRuleError(low)).toBe(true);
    const offStep = applyMove(st, 'p1', { t: 'auction_bid', amount: 55 }, seed());
    expect(isRuleError(offStep)).toBe(true);
    const rich = applyMove(st, 'p1', { t: 'auction_bid', amount: 2000 }, seed());
    expect(isRuleError(rich)).toBe(true); // over cash
  });

  it('zero eligible bidders (everyone broke) cannot deadlock: all decline, unsold, play continues', () => {
    let st = auctionState({ p0: 5, p1: 5, p2: 5 });
    const dec = applyMove(st, 'p0', { t: 'decline' }, seed());
    if (isRuleError(dec)) throw new Error(dec.message);
    st = dec.state;
    // every bidder's ONLY legal move is decline
    for (let guard = 0; guard < 10 && st.phase === 'auction'; guard++) {
      const mover = toMove(st)[0]!;
      const legal = legalMovesFor(st, mover);
      expect(legal).toEqual([{ t: 'decline' }]);
      const r = applyMove(st, mover, { t: 'decline' }, seed());
      if (isRuleError(r)) throw new Error(r.message);
      st = r.state;
    }
    expect(st.phase).toBe('manage');
    expect(st.props['cinder']!.owner).toBeNull();
    expect(terminalResult(st)).toBeNull();
    expect(toMove(st).length).toBeGreaterThan(0);
  });

  it('the decliner may bid; the auction settles after 3 full rounds even with endless bids', () => {
    let st = auctionState();
    const dec = applyMove(st, 'p0', { t: 'decline' }, seed());
    if (isRuleError(dec)) throw new Error(dec.message);
    st = dec.state;
    let amount = 10;
    let rounds = 0;
    while (st.phase === 'auction' && rounds < 100) {
      const mover = toMove(st)[0]!;
      const r = applyMove(st, mover, { t: 'auction_bid', amount }, seed());
      if (isRuleError(r)) throw new Error(`${mover} bid ${amount}: ${r.message}`);
      st = r.state;
      amount += 10;
      rounds++;
    }
    expect(st.phase).not.toBe('auction'); // settled — never endless
    expect(rounds).toBeLessThanOrEqual(9); // 3 players x 3 rounds max
    const owner = st.props['cinder']!.owner;
    expect(owner).not.toBeNull();
  });
});

describe('even-build / even-sell and error immutability', () => {
  it('leapfrog building is rejected atomically and the PREVIOUS state is untouched', () => {
    const st = manage();
    grant(st, 'p0', 'cinder', 'mudlark');
    st.cash['p0'] = 2000;
    const before = hashJson(st as unknown as Json);
    // n=2 on one street while the sibling is at 0 must fail (second house breaks even-build)
    const r = applyMove(st, 'p0', { t: 'build', prop: 'cinder', n: 2 }, seed());
    expect(isRuleError(r)).toBe(true);
    expect(hashJson(st as unknown as Json)).toBe(before); // no partial mutation leaked
    // and the legal path: one on each street alternating
    const b1 = applyMove(st, 'p0', { t: 'build', prop: 'cinder', n: 1 }, seed());
    if (isRuleError(b1)) throw new Error(b1.message);
    const b2 = applyMove(b1.state, 'p0', { t: 'build', prop: 'cinder', n: 1 }, seed());
    expect(isRuleError(b2)).toBe(true); // still uneven
    const b3 = applyMove(b1.state, 'p0', { t: 'build', prop: 'mudlark', n: 1 }, seed());
    expect(isRuleError(b3)).toBe(false);
  });

  it('building without the full group or on a mortgaged group is rejected', () => {
    const st = manage();
    grant(st, 'p0', 'cinder');
    st.cash['p0'] = 2000;
    expect(isRuleError(applyMove(st, 'p0', { t: 'build', prop: 'cinder', n: 1 }, seed()))).toBe(true);
    grant(st, 'p0', 'mudlark');
    st.props['mudlark']!.mortgaged = true;
    expect(isRuleError(applyMove(st, 'p0', { t: 'build', prop: 'cinder', n: 1 }, seed()))).toBe(true);
  });

  it('even-sell: only the tallest street may sell; the middle one is rejected', () => {
    const st = manage();
    grant(st, 'p0', 'foghorn', 'brine', 'gullwing');
    st.props['foghorn']!.houses = 2;
    st.props['brine']!.houses = 1;
    st.props['gullwing']!.houses = 2;
    const r = applyMove(st, 'p0', { t: 'sell_buildings', prop: 'brine', n: 1 }, seed());
    expect(isRuleError(r)).toBe(true);
    const ok = applyMove(st, 'p0', { t: 'sell_buildings', prop: 'foghorn', n: 1 }, seed());
    expect(isRuleError(ok)).toBe(false);
  });
});

describe('detention exit rules', () => {
  it('the third failed doubles attempt forces the fine and the move — through debt to bankruptcy when broke', () => {
    const st = fresh(2);
    st.detained['p0'] = true;
    st.detTries['p0'] = 2;
    st.pos['p0'] = 10;
    st.cash['p0'] = 0; // cannot pay the 50 fine
    const s = findRollSeed((d1, d2) => d1 !== d2);
    const r = applyMove(st, 'p0', { t: 'roll' }, s);
    if (isRuleError(r)) throw new Error(r.message);
    const after = r.state;
    expect(after.phase).toBe('debt');
    const legal = legalMovesFor(after, 'p0');
    expect(legal).toEqual([{ t: 'declare_bankruptcy' }]);
    const bk = applyMove(after, 'p0', { t: 'declare_bankruptcy' }, seed());
    if (isRuleError(bk)) throw new Error(bk.message);
    expect(bk.state.bankrupt['p0']).toBe(true);
    const t = terminalResult(bk.state);
    expect(t?.winners).toEqual(['p1']);
    expect(t?.reason).toBe('last_standing');
  });

  it('pay_detention needs the cash; use_card needs a writ; both reject otherwise', () => {
    const st = fresh(2);
    st.detained['p0'] = true;
    st.cash['p0'] = 10;
    expect(isRuleError(applyMove(st, 'p0', { t: 'pay_detention' }, seed()))).toBe(true);
    expect(isRuleError(applyMove(st, 'p0', { t: 'use_card' }, seed()))).toBe(true);
    // and neither appears in the legal list
    const legal = legalMovesFor(st, 'p0');
    expect(legal).toEqual([{ t: 'roll' }]);
  });

  it('a detained player cannot roll-move out without doubles; failed attempts keep the turn structure sound', () => {
    const st = fresh(2);
    st.detained['p0'] = true;
    st.detTries['p0'] = 0;
    st.pos['p0'] = 10;
    const s = findRollSeed((d1, d2) => d1 !== d2);
    const r = applyMove(st, 'p0', { t: 'roll' }, s);
    if (isRuleError(r)) throw new Error(r.message);
    expect(r.state.pos['p0']).toBe(10); // did not move
    expect(r.state.detained['p0']).toBe(true);
    expect(r.state.detTries['p0']).toBe(1);
    expect(r.state.phase).toBe('manage'); // may still manage and trade
  });
});

describe('the 150-round net-worth tiebreak (attack family 2)', () => {
  it('net worth = cash + list (unmortgaged) + half list (mortgaged) + building cost, hotel = 5x', () => {
    const st = fresh(3);
    st.round = 151;
    // p0: 100 cash + zephyr mortgaged (350/2=175) => 275
    grant(st, 'p0', 'zephyr');
    st.props['zephyr']!.mortgaged = true;
    st.cash['p0'] = 100;
    // p1: 0 cash + cinder (60) + hotel (5 x 50 = 250) => 310
    grant(st, 'p1', 'cinder');
    st.props['cinder']!.houses = 5;
    st.cash['p1'] = 0;
    // p2: plain 300 cash
    st.cash['p2'] = 300;
    expect(netWorth(st, 'p0')).toBe(275);
    expect(netWorth(st, 'p1')).toBe(310);
    expect(netWorth(st, 'p2')).toBe(300);
    const t = terminalResult(st);
    expect(t?.reason).toBe('turn_limit');
    expect(t?.winners).toEqual(['p1']);
    expect(t?.scores).toEqual({ p0: 275, p1: 310, p2: 300 });
  });

  it('ties at the top are shared; bankrupt players score 0 and cannot win', () => {
    const st = fresh(3);
    st.round = 151;
    st.cash['p0'] = 500;
    st.cash['p1'] = 500;
    st.cash['p2'] = 5000;
    st.bankrupt['p2'] = true;
    const t = terminalResult(st);
    expect(t?.winners).toEqual(['p0', 'p1']);
    expect(t?.scores?.['p2']).toBe(0);
  });

  it('round 150 still plays; the limit binds only after the last seat of round 150 ends', () => {
    const st = fresh(2);
    st.round = 150;
    expect(terminalResult(st)).toBeNull();
    st.round = 151;
    expect(terminalResult(st)).not.toBeNull();
  });
});

describe('offer lifecycle discipline', () => {
  function withOffer(): { st: LandlordState } {
    const st = manage();
    grant(st, 'p0', 'cinder');
    const r = applyMove(
      st,
      'p0',
      { t: 'offer', to: 'p1', give: { cash: 0, props: ['cinder'], writs: 0 }, get: { cash: 60, props: [], writs: 0 }, note: null },
      seed(),
    );
    if (isRuleError(r)) throw new Error(r.message);
    return { st: r.state };
  }

  it('while an offer is pending the board is frozen: the offerer cannot act, the responder must answer', () => {
    const { st } = withOffer();
    expect(toMove(st)).toEqual(['p1']);
    expect(isRuleError(applyMove(st, 'p0', { t: 'end_turn' }, seed()))).toBe(true);
    expect(isRuleError(applyMove(st, 'p0', { t: 'mortgage', prop: 'cinder' }, seed()))).toBe(true);
    expect(isRuleError(applyMove(st, 'p1', { t: 'mortgage', prop: 'cinder' }, seed()))).toBe(true);
    // stale/wrong offer ids rejected
    expect(isRuleError(applyMove(st, 'p1', { t: 'accept', id: 999 }, seed()))).toBe(true);
    const rej = applyMove(st, 'p1', { t: 'reject', id: st.offer!.id }, seed());
    expect(isRuleError(rej)).toBe(false);
  });

  it('a counter may be countered only once, and accepting re-validates affordability at accept time', () => {
    const { st } = withOffer();
    const c1 = applyMove(st, 'p1', { t: 'counter', id: st.offer!.id, give: { cash: 40, props: [], writs: 0 }, get: { cash: 0, props: ['cinder'], writs: 0 }, note: null }, seed());
    if (isRuleError(c1)) throw new Error(c1.message);
    const st2 = c1.state;
    expect(toMove(st2)).toEqual(['p0']);
    const c2 = applyMove(st2, 'p0', { t: 'counter', id: st2.offer!.id, give: { cash: 0, props: ['cinder'], writs: 0 }, get: { cash: 50, props: [], writs: 0 }, note: null }, seed());
    expect(isRuleError(c2)).toBe(true);
    // drain p1's cash below the countered give -> accept must now fail
    st2.cash['p1'] = 10;
    const acc = applyMove(st2, 'p0', { t: 'accept', id: st2.offer!.id }, seed());
    expect(isRuleError(acc)).toBe(true);
  });

  it('at most 3 offers per turn; the responder can never initiate while an offer of theirs is open', () => {
    let st = manage();
    grant(st, 'p0', 'cinder', 'foghorn', 'brine', 'gullwing');
    for (let i = 0; i < 3; i++) {
      const prop = ['cinder', 'foghorn', 'brine'][i]!;
      const mk = applyMove(st, 'p0', { t: 'offer', to: 'p1', give: { cash: 0, props: [prop], writs: 0 }, get: { cash: 10, props: [], writs: 0 }, note: null }, seed());
      if (isRuleError(mk)) throw new Error(mk.message);
      st = mk.state;
      const rj = applyMove(st, 'p1', { t: 'reject', id: st.offer!.id }, seed());
      if (isRuleError(rj)) throw new Error(rj.message);
      st = rj.state;
    }
    const fourth = applyMove(st, 'p0', { t: 'offer', to: 'p1', give: { cash: 0, props: ['gullwing'], writs: 0 }, get: { cash: 10, props: [], writs: 0 }, note: null }, seed());
    expect(isRuleError(fourth)).toBe(true);
    // end_turn always remains available: no deadlock after the cap
    expect(legalMovesFor(st, 'p0')).toContainEqual({ t: 'end_turn' });
  });
});

describe('phase guards', () => {
  it('buy with insufficient cash is rejected and not offered; double-buy is impossible', () => {
    const st = fresh(2);
    st.phase = 'buy_or_auction';
    st.pendingProp = 'aurora';
    st.cash['p0'] = 100; // aurora costs 400
    const legal = legalMovesFor(st, 'p0');
    expect(legal).toEqual([{ t: 'decline' }]);
    expect(isRuleError(applyMove(st, 'p0', { t: 'buy' }, seed()))).toBe(true);

    const rich = fresh(2);
    rich.phase = 'buy_or_auction';
    rich.pendingProp = 'cinder';
    const b = applyMove(rich, 'p0', { t: 'buy' }, seed());
    if (isRuleError(b)) throw new Error(b.message);
    expect(b.state.props['cinder']!.owner).toBe('p0');
    expect(isRuleError(applyMove(b.state, 'p0', { t: 'buy' }, seed()))).toBe(true);
  });

  it('rolling twice in one turn is rejected; end_turn from the roll phase is rejected', () => {
    const st = fresh(2);
    const s = findRollSeed((d1, d2) => d1 !== d2 && ![1, 3, 6, 8, 11].includes(d1 + d2));
    const r = applyMove(st, 'p0', { t: 'roll' }, s);
    if (isRuleError(r)) throw new Error(r.message);
    if (r.state.phase === 'manage') {
      expect(isRuleError(applyMove(r.state, 'p0', { t: 'roll' }, seed()))).toBe(true);
    }
    expect(isRuleError(applyMove(st, 'p0', { t: 'end_turn' }, seed()))).toBe(true);
  });
});

describe('landlord defaultMove and views stay consistent under attack states', () => {
  it('defaultMove always returns a member of the legal list', () => {
    const st = manage();
    const legal = landlord.legalMoves(st, 'p0');
    const d = landlord.defaultMove!(st, 'p0', legal);
    expect(legal).toContainEqual(d);
  });
});
