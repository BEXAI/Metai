import { describe, expect, it } from 'vitest';
import { isRuleError } from '../../../kernel/types.ts';
import landlord from '../index.ts';
import { mortgageValue, unmortgageCost } from '../board.ts';
import { legalMovesFor, netWorth, terminalResult, toMove } from '../rules.ts';
import { findRollSeed, fresh, grant, play, playErr, seed } from './helpers.ts';

describe('landlord auctions', () => {
  it('runs a declined purchase through a full auction; later equal bid is rejected (tie to earlier bid)', () => {
    let st = fresh(4);
    st.phase = 'buy_or_auction';
    st.pendingProp = 'quarry';

    st = play(st, 'p0', 'decline').state;
    expect(st.phase).toBe('auction');
    expect(st.auction?.order).toEqual(['p0', 'p1', 'p2', 'p3']);

    st = play(st, 'p0', 'auction_bid(10)').state;
    st = play(st, 'p1', 'auction_bid(20)').state;
    expect(playErr(st, 'p2', 'auction_bid(20)').code).toBe('bad_bid'); // tie goes to the earlier bidder
    st = play(st, 'p2', 'decline').state;
    st = play(st, 'p3', 'auction_bid(30)').state;
    expect(st.auction?.round).toBe(2);

    for (const p of ['p0', 'p1', 'p2', 'p3']) st = play(st, p, 'decline').state;
    expect(st.auction).toBeNull();
    expect(st.props['quarry']?.owner).toBe('p3');
    expect(st.cash['p3']).toBe(1470);
    expect(st.phase).toBe('manage');
    expect(st.current).toBe('p0');
  });

  it('ends after 3 rounds max even while bids keep coming', () => {
    let st = fresh(4);
    st.phase = 'buy_or_auction';
    st.pendingProp = 'cinder';
    st = play(st, 'p0', 'decline').state;
    let amt = 10;
    for (let round = 0; round < 3; round++) {
      for (const p of ['p0', 'p1', 'p2', 'p3']) {
        st = play(st, p, `auction_bid(${amt})`).state;
        amt += 10;
      }
    }
    expect(st.auction).toBeNull(); // settled right after round 3 completed
    expect(st.props['cinder']?.owner).toBe('p3');
    expect(st.cash['p3']).toBe(1500 - 120);
  });

  it('a first round with no bids leaves the property unsold', () => {
    let st = fresh(4);
    st.phase = 'buy_or_auction';
    st.pendingProp = 'aurora';
    st = play(st, 'p0', 'decline').state;
    for (const p of ['p0', 'p1', 'p2', 'p3']) st = play(st, p, 'decline').state;
    expect(st.auction).toBeNull();
    expect(st.props['aurora']?.owner).toBeNull();
    expect(st.phase).toBe('manage');
  });

  it('bids are enumerated in steps of 10 up to the bidder cash', () => {
    const st = fresh(2);
    st.phase = 'auction';
    st.auction = { prop: 'cinder', order: ['p0', 'p1'], idx: 0, round: 1, high: 40, highBidder: 'p1', bidsInRound: 1 };
    st.cash['p0'] = 85;
    const moves = legalMovesFor(st, 'p0');
    const bids = moves.filter((m) => m.t === 'auction_bid').map((m) => (m.t === 'auction_bid' ? m.amount : 0));
    expect(bids).toEqual([50, 60, 70, 80]);
    expect(moves.at(-1)).toEqual({ t: 'decline' });
  });
});

describe('landlord building rules', () => {
  it('enforces even-build across the group and blocks building on mortgaged groups', () => {
    let st = fresh(2);
    st.phase = 'manage';
    grant(st, 'p0', 'cinder', 'mudlark');
    st = play(st, 'p0', 'build(cinder,1)').state;
    expect(st.props['cinder']?.houses).toBe(1);
    expect(st.cash['p0']).toBe(1450);
    expect(playErr(st, 'p0', 'build(cinder,1)').code).toBe('cannot_build'); // must even-build
    st = play(st, 'p0', 'build(mudlark,1)').state;
    st = play(st, 'p0', 'build(cinder,1)').state;
    expect(st.props['cinder']?.houses).toBe(2);

    const st2 = fresh(2);
    st2.phase = 'manage';
    grant(st2, 'p0', 'cinder', 'mudlark');
    st2.props['mudlark']!.mortgaged = true;
    expect(playErr(st2, 'p0', 'build(cinder,1)').code).toBe('cannot_build');
  });

  it('build requires the full group', () => {
    const st = fresh(2);
    st.phase = 'manage';
    grant(st, 'p0', 'foghorn', 'brine'); // gullwing missing
    expect(playErr(st, 'p0', 'build(foghorn,1)').code).toBe('cannot_build');
  });

  it('enforces even-sell: only the tallest street in the group may sell', () => {
    let st = fresh(2);
    st.phase = 'manage';
    grant(st, 'p0', 'cinder', 'mudlark');
    st.props['cinder']!.houses = 2;
    st.props['mudlark']!.houses = 1;
    st.housePool = 29;
    expect(playErr(st, 'p0', 'sell_buildings(mudlark,1)').code).toBe('cannot_sell');
    st = play(st, 'p0', 'sell_buildings(cinder,1)').state;
    expect(st.props['cinder']?.houses).toBe(1);
    expect(st.cash['p0']).toBe(1525); // half of the 50 build cost
    expect(st.housePool).toBe(30);
  });

  it('house supply exhaustion blocks building; hotels return four houses to the pool', () => {
    let st = fresh(2);
    st.phase = 'manage';
    grant(st, 'p0', 'cinder', 'mudlark');
    st.housePool = 0;
    expect(playErr(st, 'p0', 'build(cinder,1)').code).toBe('cannot_build');
    expect(legalMovesFor(st, 'p0').some((m) => m.t === 'build')).toBe(false);

    st.props['cinder']!.houses = 4;
    st.props['mudlark']!.houses = 4;
    st.housePool = 2;
    st = play(st, 'p0', 'build(cinder,1)').state; // upgrade to hotel
    expect(st.props['cinder']?.houses).toBe(5);
    expect(st.hotelPool).toBe(11);
    expect(st.housePool).toBe(6); // 2 + 4 returned
  });

  it('under house shortage a hotel must be sold whole (n=5)', () => {
    let st = fresh(2);
    st.phase = 'manage';
    grant(st, 'p0', 'cinder', 'mudlark');
    st.props['cinder']!.houses = 5;
    st.props['mudlark']!.houses = 5;
    st.housePool = 3;
    expect(playErr(st, 'p0', 'sell_buildings(cinder,1)').code).toBe('cannot_sell');
    const legal = legalMovesFor(st, 'p0');
    expect(legal).toContainEqual({ t: 'sell_buildings', prop: 'cinder', n: 5 });
    st = play(st, 'p0', 'sell_buildings(cinder,5)').state;
    expect(st.props['cinder']?.houses).toBe(0);
    expect(st.hotelPool).toBe(13);
    expect(st.cash['p0']).toBe(1500 + 125); // 5 x 25
  });
});

describe('landlord mortgage math', () => {
  it('mortgage pays half list; unmortgage costs mortgage value + 10% rounded up', () => {
    let st = fresh(2);
    st.phase = 'manage';
    grant(st, 'p0', 'zephyr'); // list 350
    expect(mortgageValue('zephyr')).toBe(175);
    expect(unmortgageCost('zephyr')).toBe(193); // 175 + ceil(17.5)
    st = play(st, 'p0', 'mortgage(zephyr)').state;
    expect(st.cash['p0']).toBe(1675);
    expect(st.props['zephyr']?.mortgaged).toBe(true);
    st = play(st, 'p0', 'unmortgage(zephyr)').state;
    expect(st.cash['p0']).toBe(1675 - 193);
    expect(st.props['zephyr']?.mortgaged).toBe(false);
  });

  it('cannot mortgage a street while its group has buildings', () => {
    const st = fresh(2);
    st.phase = 'manage';
    grant(st, 'p0', 'cinder', 'mudlark');
    st.props['cinder']!.houses = 1;
    expect(playErr(st, 'p0', 'mortgage(mudlark)').code).toBe('cannot_mortgage');
  });

  it('mortgaged property collects no rent; monopoly doubles unimproved rent', () => {
    // p0 sits on coopers(13) and rolls 3 to land on quarry(16), owned by p1.
    const s = findRollSeed((a, b) => a + b === 3 && a !== b);
    let st = fresh(2);
    st.pos['p0'] = 13;
    grant(st, 'p1', 'quarry');
    st = play(st, 'p0', 'roll', s).state;
    expect(st.cash['p0']).toBe(1500 - 14);
    expect(st.cash['p1']).toBe(1500 + 14);

    const s2 = findRollSeed((a, b) => a + b === 3 && a !== b);
    let st2 = fresh(2);
    st2.pos['p0'] = 13;
    grant(st2, 'p1', 'quarry', 'millrace', 'ironmonger'); // full amber group
    st2 = play(st2, 'p0', 'roll', s2).state;
    expect(st2.cash['p0']).toBe(1500 - 28); // doubled unimproved rent

    const s3 = findRollSeed((a, b) => a + b === 3 && a !== b);
    let st3 = fresh(2);
    st3.pos['p0'] = 13;
    grant(st3, 'p1', 'quarry');
    st3.props['quarry']!.mortgaged = true;
    st3 = play(st3, 'p0', 'roll', s3).state;
    expect(st3.cash['p0']).toBe(1500); // no rent on mortgaged property
  });

  it('transit rent scales with lines owned; utility rent is 4x dice', () => {
    const s = findRollSeed((a, b) => a + b === 3 && a !== b);
    let st = fresh(2);
    st.pos['p0'] = 12;
    grant(st, 'p1', 'east_quay', 'north_spur');
    st = play(st, 'p0', 'roll', s).state; // lands east_quay (15)
    expect(st.cash['p0']).toBe(1500 - 50);

    const s2 = findRollSeed((a, b) => a + b === 3 && a !== b);
    let st2 = fresh(2);
    st2.pos['p0'] = 9;
    grant(st2, 'p1', 'dynamo');
    st2 = play(st2, 'p0', 'roll', s2).state; // lands dynamo (12)
    expect(st2.cash['p0']).toBe(1500 - 3 * 4);
  });
});

describe('landlord detention', () => {
  it('a third consecutive double sends the player to the Detention Yard without moving', () => {
    const s = findRollSeed((a, b) => a === b);
    let st = fresh(2);
    st.doubles = 2;
    st = play(st, 'p0', 'roll', s).state;
    expect(st.detained['p0']).toBe(true);
    expect(st.pos['p0']).toBe(10);
    expect(st.phase).toBe('manage');
    expect(st.rolledDouble).toBe(false);
    st = play(st, 'p0', 'end_turn').state;
    expect(st.current).toBe('p1'); // no extra roll after being sent in
  });

  it('rolling doubles while detained releases and moves, with no re-roll', () => {
    const s = findRollSeed((a, b) => a === b && a + b !== 2); // avoid landing on dynamo(12) buy phase noise? keep general
    let st = fresh(2);
    st.detained['p0'] = true;
    st.pos['p0'] = 10;
    st = play(st, 'p0', 'roll', s).state;
    expect(st.detained['p0']).toBe(false);
    const dice = st.lastDice!;
    expect(st.pos['p0']).toBe(10 + dice[0]! + dice[1]!);
    expect(st.rolledDouble).toBe(false);
  });

  it('a failed attempt counts; the third failure forces the fine and the move', () => {
    const s = findRollSeed((a, b) => a !== b);
    let st = fresh(2);
    st.detained['p0'] = true;
    st.pos['p0'] = 10;
    st = play(st, 'p0', 'roll', s).state;
    expect(st.detained['p0']).toBe(true);
    expect(st.detTries['p0']).toBe(1);
    expect(st.phase).toBe('manage');

    const s2 = findRollSeed((a, b) => a !== b);
    let st2 = fresh(2);
    st2.detained['p0'] = true;
    st2.pos['p0'] = 10;
    st2.detTries['p0'] = 2;
    st2 = play(st2, 'p0', 'roll', s2).state;
    const dice = st2.lastDice!;
    expect(st2.detained['p0']).toBe(false);
    expect(st2.pos['p0']).toBe(10 + dice[0]! + dice[1]!);
    expect(st2.cash['p0']).toBeLessThanOrEqual(1450); // paid the 50 fine (rent may also have hit)
  });

  it('pay_detention releases before rolling; use_card returns the writ to the bottom of its deck', () => {
    let st = fresh(2);
    st.detained['p0'] = true;
    st.pos['p0'] = 10;
    st = play(st, 'p0', 'pay_detention').state;
    expect(st.cash['p0']).toBe(1450);
    expect(st.detained['p0']).toBe(false);
    expect(st.phase).toBe('roll');

    let st2 = fresh(2);
    st2.detained['p0'] = true;
    st2.pos['p0'] = 10;
    st2.deckA = st2.deckA.filter((id) => id !== 'evA06');
    st2.writs['p0'] = ['evA06'];
    st2 = play(st2, 'p0', 'use_card').state;
    expect(st2.detained['p0']).toBe(false);
    expect(st2.writs['p0']).toEqual([]);
    expect(st2.deckA.at(-1)).toBe('evA06');
    expect(st2.deckA).toHaveLength(16);
    expect(st2.phase).toBe('roll');
  });
});

describe('landlord event decks', () => {
  it('deck order is deterministic from the seed', () => {
    const a = fresh(2, 'decks');
    const b = fresh(2, 'decks');
    expect(a.deckA).toEqual(b.deckA);
    expect(a.deckB).toEqual(b.deckB);
    expect([...a.deckA].sort()).toEqual(Array.from({ length: 16 }, (_, i) => `evA${String(i + 1).padStart(2, '0')}`));
    const c = fresh(2, 'other-seed');
    expect(c.deckA).not.toEqual(a.deckA); // 16! orders; equality would be astonishing
  });

  it('cards are drawn from the front in order and rotate to the back', () => {
    const s = findRollSeed((a, b) => a + b === 4 && a !== b);
    let st = fresh(2);
    st.pos['p0'] = 3; // 3 + 4 = 7, a Dispatches (deck A) space
    st.deckA = ['evA05', ...st.deckA.filter((id) => id !== 'evA05')];
    const before = st.deckA.slice();
    st = play(st, 'p0', 'roll', s).state;
    expect(st.cash['p0']).toBe(1550); // Harbormaster's Bonus +50
    expect(st.deckA).toEqual([...before.slice(1), 'evA05']);
  });

  it('a drawn Release Writ leaves the deck until used', () => {
    const s = findRollSeed((a, b) => a + b === 4 && a !== b);
    let st = fresh(2);
    st.pos['p0'] = 3;
    st.deckA = ['evA06', ...st.deckA.filter((id) => id !== 'evA06')];
    st = play(st, 'p0', 'roll', s).state;
    expect(st.writs['p0']).toEqual(['evA06']);
    expect(st.deckA).toHaveLength(15);
    expect(st.deckA).not.toContain('evA06');
  });

  it("a Constable's Writ sends the drawer to detention", () => {
    const s = findRollSeed((a, b) => a === 1 && b === 1);
    let st = fresh(2);
    st.pos['p0'] = 0; // 0 + 2 = 2, a Town Ledger (deck B) space
    st.deckB = ['evB06', ...st.deckB.filter((id) => id !== 'evB06')];
    st = play(st, 'p0', 'roll', s).state;
    expect(st.detained['p0']).toBe(true);
    expect(st.pos['p0']).toBe(10);
    expect(st.rolledDouble).toBe(false); // detention cancels the doubles re-roll
  });
});

describe('landlord bankruptcy', () => {
  it('bankruptcy to a player transfers cash, properties, and the 10% mortgage fee', () => {
    let st = fresh(2);
    st.phase = 'debt';
    st.payments = [{ from: 'p0', to: 'p1', amount: 500, reason: 'rent:quarry' }];
    st.cash['p0'] = 10;
    grant(st, 'p0', 'cinder', 'mudlark');
    st.props['mudlark']!.mortgaged = true;
    expect(playErr(st, 'p0', 'pay_debt').code).toBe('poor');
    st = play(st, 'p0', 'declare_bankruptcy').state;
    expect(st.bankrupt['p0']).toBe(true);
    expect(st.props['cinder']?.owner).toBe('p1');
    expect(st.props['mudlark']?.owner).toBe('p1');
    expect(st.props['mudlark']?.mortgaged).toBe(true);
    expect(st.cash['p1']).toBe(1500 + 10 - 3); // debtor cash minus 10% fee on the 30 mortgage
    const result = landlord.isTerminal(st);
    expect(result?.winners).toEqual(['p1']);
    expect(result?.reason).toBe('last_standing');
  });

  it('declare_bankruptcy is illegal while selling or mortgaging could still cover the debt', () => {
    const st = fresh(2);
    st.phase = 'debt';
    st.payments = [{ from: 'p0', to: 'p1', amount: 100, reason: 'rent:quarry' }];
    st.cash['p0'] = 10;
    grant(st, 'p0', 'ironmonger'); // mortgage value 100 -> ceiling 110 >= 100
    expect(playErr(st, 'p0', 'declare_bankruptcy').code).toBe('solvent');
    expect(legalMovesFor(st, 'p0')).toContainEqual({ t: 'mortgage', prop: 'ironmonger' });
  });

  it('bankruptcy to the bank auctions every property to the survivors', () => {
    let st = fresh(3);
    st.phase = 'debt';
    st.payments = [{ from: 'p0', to: 'bank', amount: 500, reason: 'tax:4' }];
    st.cash['p0'] = 10;
    grant(st, 'p0', 'cinder', 'mudlark');
    st.props['mudlark']!.mortgaged = true;
    st = play(st, 'p0', 'declare_bankruptcy').state;
    expect(st.bankrupt['p0']).toBe(true);
    expect(st.phase).toBe('auction');
    expect(st.auction?.prop).toBe('cinder');
    expect(st.auction?.order).toEqual(['p1', 'p2']); // the bankrupt player is out

    st = play(st, 'p1', 'auction_bid(10)').state;
    st = play(st, 'p2', 'decline').state;
    st = play(st, 'p1', 'decline').state;
    st = play(st, 'p2', 'decline').state;
    expect(st.props['cinder']?.owner).toBe('p1');
    expect(st.cash['p1']).toBe(1490);

    expect(st.phase).toBe('auction');
    expect(st.auction?.prop).toBe('mudlark');
    expect(st.props['mudlark']?.mortgaged).toBe(false); // bank clears mortgages before auctioning
    st = play(st, 'p1', 'decline').state;
    st = play(st, 'p2', 'decline').state;
    expect(st.props['mudlark']?.owner).toBeNull();
    expect(st.phase).toBe('roll');
    expect(st.current).toBe('p1'); // the bankrupt current player's turn ended
  });

  it('debt phase: selling and mortgaging raise cash, then pay_debt settles', () => {
    let st = fresh(2);
    st.phase = 'debt';
    st.payments = [{ from: 'p0', to: 'p1', amount: 100, reason: 'rent:aurora' }];
    st.cash['p0'] = 20;
    grant(st, 'p0', 'ironmonger');
    expect(toMove(st)).toEqual(['p0']);
    st = play(st, 'p0', 'mortgage(ironmonger)').state; // +100
    expect(st.phase).toBe('debt'); // paying is an explicit move
    st = play(st, 'p0', 'pay_debt').state;
    expect(st.cash['p0']).toBe(20);
    expect(st.cash['p1']).toBe(1600);
    expect(st.phase).toBe('manage');
  });
});

describe('landlord end conditions', () => {
  it('after the round limit the highest net worth wins; ties are shared', () => {
    const st = fresh(2);
    st.round = 151;
    grant(st, 'p0', 'cinder');
    st.cash['p0'] = 1000;
    st.cash['p1'] = 1060;
    const r1 = terminalResult(st);
    expect(r1?.reason).toBe('turn_limit');
    expect(r1?.winners.sort()).toEqual(['p0', 'p1']); // both at 1060

    st.cash['p1'] = 1061;
    expect(terminalResult(st)?.winners).toEqual(['p1']);

    st.props['cinder']!.houses = 2; // buildings count at cost: +100
    expect(terminalResult(st)?.winners).toEqual(['p0']);
    expect(netWorth(st, 'p0')).toBe(1160);
  });

  it('round 150 is still playable; the limit only binds after it', () => {
    const st = fresh(2);
    st.round = 150;
    expect(terminalResult(st)).toBeNull();
  });

  it('mortgaged holdings count at mortgage value in net worth', () => {
    const st = fresh(2);
    grant(st, 'p0', 'zephyr');
    st.props['zephyr']!.mortgaged = true;
    st.cash['p0'] = 0;
    expect(netWorth(st, 'p0')).toBe(175);
  });
});

describe('landlord notation round-trips', () => {
  it('moveToNotation and parseMove are inverses over enumerated legal moves', () => {
    const st = fresh(4);
    st.phase = 'manage';
    grant(st, 'p0', 'quarry', 'zephyr');
    st.props['zephyr']!.mortgaged = true;
    grant(st, 'p1', 'cinder');
    for (const mv of legalMovesFor(st, 'p0')) {
      const notation = landlord.moveToNotation(mv, st);
      const parsed = landlord.parseMove(notation, st, 'p0');
      expect(parsed).toEqual(mv);
    }
  });

  it('roll applies from notation and legalMoves matches playersToMove', () => {
    const st = fresh(2);
    expect(landlord.playersToMove(st)).toEqual(['p0']);
    expect(legalMovesFor(st, 'p1')).toEqual([]);
    const applied = play(st, 'p0', 'roll', seed('roll'));
    expect(isRuleError(applied)).toBe(false);
    expect(applied.state.lastDice).toHaveLength(2);
  });
});
