import { describe, expect, it } from 'vitest';
import { legalMovesFor, toMove } from '../rules.ts';
import { findRollSeed, fresh, grant, play } from './helpers.ts';

describe('landlord turn flows', () => {
  it('passing Launch Pier pays the salary; buy takes the property at list price', () => {
    const s = findRollSeed((a, b) => a + b === 3 && a !== b);
    let st = fresh(2);
    st.pos['p0'] = 38;
    st = play(st, 'p0', 'roll', s).state;
    expect(st.pos['p0']).toBe(1);
    expect(st.cash['p0']).toBe(1700); // +200 salary
    expect(st.phase).toBe('buy_or_auction');
    st = play(st, 'p0', 'buy').state;
    expect(st.props['cinder']?.owner).toBe('p0');
    expect(st.cash['p0']).toBe(1640);
    expect(st.phase).toBe('manage');
  });

  it('a double grants a re-roll after end_turn; the round does not advance', () => {
    const s = findRollSeed((a, b) => a === b && a + b === 4);
    let st = fresh(2);
    st = play(st, 'p0', 'roll', s).state; // (2,2) -> Assessment Levy, pays 200
    expect(st.cash['p0']).toBe(1300);
    expect(st.phase).toBe('manage');
    expect(st.doubles).toBe(1);
    st = play(st, 'p0', 'end_turn').state;
    expect(st.current).toBe('p0'); // same player rolls again
    expect(st.phase).toBe('roll');
    expect(st.round).toBe(1);
  });

  it('landing on your own property or on Rest Green moves nothing', () => {
    const s = findRollSeed((a, b) => a + b === 3 && a !== b);
    let st = fresh(2);
    st.pos['p0'] = 11;
    grant(st, 'p0', 'saltworks');
    st = play(st, 'p0', 'roll', s).state;
    expect(st.pos['p0']).toBe(14);
    expect(st.cash['p0']).toBe(1500);
    expect(st.phase).toBe('manage');

    const s2 = findRollSeed((a, b) => a + b === 3 && a !== b);
    let st2 = fresh(2);
    st2.pos['p0'] = 17;
    st2 = play(st2, 'p0', 'roll', s2).state;
    expect(st2.pos['p0']).toBe(20); // Rest Green: no money on the free space
    expect(st2.cash['p0']).toBe(1500);
    expect(st2.phase).toBe('manage');
  });

  it('Elected Pier Warden pays each other player 50', () => {
    const s = findRollSeed((a, b) => a + b === 4 && a !== b);
    let st = fresh(3);
    st.pos['p0'] = 3;
    st.deckA = ['evA13', ...st.deckA.filter((id) => id !== 'evA13')];
    st = play(st, 'p0', 'roll', s).state;
    expect(st.cash['p0']).toBe(1400);
    expect(st.cash['p1']).toBe(1550);
    expect(st.cash['p2']).toBe(1550);
    expect(st.phase).toBe('manage');
  });

  it('Founding Day collects 10 from each player, sending paupers through debt to bankruptcy', () => {
    const s = findRollSeed((a, b) => a === 1 && b === 1);
    let st = fresh(3);
    st.pos['p0'] = 0; // lands on Town Ledger (2)
    st.deckB = ['evB13', ...st.deckB.filter((id) => id !== 'evB13')];
    st.cash['p1'] = 5; // cannot pay and owns nothing
    st = play(st, 'p0', 'roll', s).state;
    expect(st.phase).toBe('debt');
    expect(toMove(st)).toEqual(['p1']);
    expect(legalMovesFor(st, 'p1')).toEqual([{ t: 'declare_bankruptcy' }]);
    st = play(st, 'p1', 'declare_bankruptcy').state;
    expect(st.bankrupt['p1']).toBe(true);
    // p2 paid its 10 as the pipeline resumed; p1's remaining 5 cash went to p0 as creditor.
    expect(st.cash['p2']).toBe(1490);
    expect(st.cash['p0']).toBe(1515);
    expect(st.phase).toBe('manage');
    expect(st.current).toBe('p0');
  });

  it('Priority Freight advances to the nearest transit line and doubles the fare', () => {
    const s = findRollSeed((a, b) => a + b === 4 && a !== b);
    let st = fresh(2);
    st.pos['p0'] = 3;
    st.deckA = ['evA03', ...st.deckA.filter((id) => id !== 'evA03')];
    grant(st, 'p1', 'east_quay'); // one line owned: fare 25, doubled to 50
    st = play(st, 'p0', 'roll', s).state;
    expect(st.pos['p0']).toBe(15);
    expect(st.cash['p0']).toBe(1450);
    expect(st.cash['p1']).toBe(1550);
  });

  it('Works Inspection advances to the nearest utility and charges 10x a fresh roll', () => {
    const s = findRollSeed((a, b) => a + b === 4 && a !== b);
    let st = fresh(2);
    st.pos['p0'] = 3;
    st.deckA = ['evA04', ...st.deckA.filter((id) => id !== 'evA04')];
    grant(st, 'p1', 'dynamo');
    st = play(st, 'p0', 'roll', s).state;
    expect(st.pos['p0']).toBe(12);
    const paid = 1500 - st.cash['p0']!;
    expect(paid).toBeGreaterThanOrEqual(20); // 10 x (2..12)
    expect(paid).toBeLessThanOrEqual(120);
    expect(paid % 10).toBe(0);
    expect(st.cash['p1']).toBe(1500 + paid);
  });

  it('Back Three Berths from a Dispatches space can chain into a Town Ledger draw', () => {
    const s = findRollSeed((a, b) => a + b === 4 && a !== b);
    let st = fresh(2);
    st.pos['p0'] = 32; // 32 + 4 = 36, Dispatches; back 3 -> 33, Town Ledger
    st.deckA = ['evA07', ...st.deckA.filter((id) => id !== 'evA07')];
    st.deckB = ['evB01', ...st.deckB.filter((id) => id !== 'evB01')]; // Municipal Grant +200
    st = play(st, 'p0', 'roll', s).state;
    expect(st.pos['p0']).toBe(33);
    expect(st.cash['p0']).toBe(1700);
    expect(st.phase).toBe('manage');
  });
});
