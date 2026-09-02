import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../crypto/canonical.ts';
import { runLeakageCheck } from '../../../kernel/leakage.ts';
import landlord, { secretProbes } from '../index.ts';
import { fresh } from './helpers.ts';
import type { LandlordState } from '../rules.ts';

describe('landlord leakage (gate A10 local slice)', () => {
  it('deck order never leaks into any view or render across 350 random states', { timeout: 600_000 }, () => {
    const res = runLeakageCheck(landlord, secretProbes, {
      states: 350,
      seedPrefix: 'landlord-leak',
      players: 3,
    });
    expect(res.statesChecked).toBe(350);
  });

  it('also holds for 2- and 4-player games', { timeout: 600_000 }, () => {
    expect(runLeakageCheck(landlord, secretProbes, { states: 120, seedPrefix: 'leak2', players: 2 }).statesChecked).toBe(120);
    expect(runLeakageCheck(landlord, secretProbes, { states: 120, seedPrefix: 'leak4', players: 4 }).statesChecked).toBe(120);
  });

  it('probes are real: a deliberately leaky view WOULD contain them', () => {
    const st = fresh(3, 'leak-selftest');
    const probes = secretProbes(st, 'p0');
    expect(probes.length).toBeGreaterThanOrEqual(2);
    const leakyView = canonicalJson({ decks: { a: st.deckA, b: st.deckB } });
    for (const probe of probes) {
      expect(leakyView).toContain(probe);
    }
  });

  it('public and private views expose counts, never deck arrays', () => {
    const st = fresh(3, 'leak-views');
    const pub = canonicalJson(landlord.publicView(st));
    const priv = canonicalJson(landlord.privateView(st, 'p1'));
    const spectator = landlord.renderText(st, null);
    for (const view of [pub, priv, spectator]) {
      for (const probe of secretProbes(st, 'p0')) {
        expect(view).not.toContain(probe);
      }
    }
    expect(pub).toContain('"deck_a_count":16');
    expect(spectator).toContain('order hidden until game end');
  });

  it('all cash and holdings are public (spec: hidden is deck order only)', () => {
    const st = fresh(3, 'leak-pub');
    st.props['quarry']!.owner = 'p1';
    st.writs['p1'] = ['evB05'];
    const pub = landlord.publicView(st) as { [k: string]: unknown };
    expect((pub['cash'] as { [p: string]: number })['p1']).toBe(1500);
    expect((pub['props'] as { [id: string]: { owner: string } })['quarry']!.owner).toBe('p1');
    expect((pub['writs_held'] as { [p: string]: string[] })['p1']).toEqual(['evB05']);
  });

  it('encode/decode round-trips the full state including hidden decks', () => {
    const st: LandlordState = fresh(4, 'codec');
    const rt = landlord.decodeState(landlord.encodeState(st));
    expect(canonicalJson(rt)).toBe(canonicalJson(st));
  });
});
