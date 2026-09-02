import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../crypto/canonical.ts';
import { hashState } from '../../../kernel/hash.ts';
import { isParseError, type Json } from '../../../kernel/types.ts';
import islanders from '../index.ts';
import { moveSummary, parseMove } from '../notation.ts';
import { legalMoves, moveToNotation, playersToMove, type IslState } from '../rules.ts';
import { craft, give, mustApply, placeVillage, seedForRoll } from './helpers.ts';

describe('islanders views', () => {
  function busyState(): IslState {
    const s = craft(3);
    give(s, 'p0', { palm: 2, taro: 1 });
    s.progress['p0'] = ['warrior', 'landmark'];
    give(s, 'p1', { reed: 3 });
    placeVillage(s, 'ABb', 'p0');
    return s;
  }

  it('public view exposes counts, never hand contents, cards, or the deck order', () => {
    const s = busyState();
    const pub = islanders.publicView(s) as Record<string, Json>;
    expect(pub['handCounts']).toEqual({ p0: 3, p1: 3, p2: 0 });
    expect(pub['progressCounts']).toEqual({ p0: 2, p1: 0, p2: 0 });
    expect(pub['deckCount']).toBe(25);
    const raw = canonicalJson(pub as Json);
    expect(raw).not.toContain('"hand"');
    expect(raw).not.toContain('"deck"');
    expect(raw).not.toContain('warrior"'); // no card names
    expect(raw).not.toContain('landmark');
  });

  it('private view adds only the viewer own hidden information', () => {
    const s = busyState();
    const mine = islanders.privateView(s, 'p0') as Record<string, Json>;
    expect(mine['hand']).toEqual({ palm: 2, coral: 0, reed: 0, taro: 1, obsidian: 0 });
    expect(mine['progressCards']).toEqual(['warrior', 'landmark']);
    const theirs = islanders.privateView(s, 'p1') as Record<string, Json>;
    expect(theirs['hand']).toEqual({ palm: 0, coral: 0, reed: 3, taro: 0, obsidian: 0 });
    expect(theirs['progressCards']).toEqual([]);
    // p0's card names never appear in p1's view (note: the public "warriors"
    // counter key legitimately contains the substring 'warrior')
    expect(canonicalJson(theirs as Json)).not.toContain('"warrior"');
    expect(canonicalJson(theirs as Json)).not.toContain('landmark');
  });

  it('renderText shows the board to everyone and secrets only to their owner', () => {
    const s = busyState();
    const spec = islanders.renderText(s, null);
    expect(spec).toContain('A:VOL-10');
    expect(spec).toContain('J:DUN---*'); // raider on the dunes
    expect(spec).toContain('Harbors:');
    expect(spec).not.toContain('Hand (');
    const mine = islanders.renderText(s, 'p0');
    expect(mine).toContain('Hand (p0): 2 palm, 1 taro');
    expect(mine).toContain('Saga cards (p0): warrior, landmark');
    const other = islanders.renderText(s, 'p1');
    expect(other).not.toContain('Hand (p0)');
    expect(other).not.toContain('Saga cards (p0)');
    expect(other).not.toContain('warrior,'); // p0's card list never rendered for p1
  });

  it('encodeState/decodeState round-trips the exact state hash', () => {
    let s = busyState();
    expect(hashState(islanders.decodeState(islanders.encodeState(s)) as unknown as Json)).toBe(
      hashState(s as unknown as Json),
    );
    s = mustApply(s, 'p0', { type: 'end_turn' }, seedForRoll(2, (t) => t !== 7));
    expect(hashState(islanders.decodeState(islanders.encodeState(s)) as unknown as Json)).toBe(
      hashState(s as unknown as Json),
    );
    expect(() => islanders.decodeState('42')).toThrow();
  });
});

describe('islanders notation', () => {
  it('parseMove is the exact inverse of moveToNotation for every legal move', () => {
    // sample several phases
    const states: IslState[] = [];
    const main = craft(3);
    give(main, 'p0', { palm: 4, coral: 3, reed: 2, taro: 2, obsidian: 3 });
    main.progress['p0'] = ['warrior', 'pathfinder', 'bounty', 'tithe'];
    placeVillage(main, 'ABb', 'p1');
    main.roads['FJ'] = 'p0';
    states.push(main);
    states.push(craft(3, { phase: 'raider', turn: 2, currentSeat: 1 }));
    const discard = craft(3, { phase: 'discard', discardDue: { p0: 4 } });
    give(discard, 'p0', { palm: 4, coral: 4 });
    states.push(discard);
    const offered = mustApply(main, 'p0', { type: 'offer', give: { palm: 1 }, get: { taro: 1 }, to: 'p1' });
    states.push(offered);
    let checked = 0;
    for (const s of states) {
      for (const p of playersToMove(s)) {
        for (const m of legalMoves(s, p)) {
          const notation = moveToNotation(m);
          const parsed = parseMove(notation, s, p);
          expect(parsed).toEqual(m);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('rejects garbage and near-misses with a parse error', () => {
    const s = craft(3);
    for (const bad of [
      '',
      'castle',
      'build_road', // missing arg
      'build_road(ZZ)',
      'build_village(AB)', // edge, not vertex
      'play_progress(dragon,B,-)',
      'play_progress(warrior,B)', // missing victim
      'trade_bank(palm)',
      'trade_bank(palm,gold)',
      'offer(palm,taro)', // missing recipient
      'offer(palm,taro,p9)',
      'accept(x)',
      'discard(palm+gold)',
      'end_turn(now)',
      'move_bandit(J)',
      '#4', // index fallback is kernel-level, not game-level
    ]) {
      expect(isParseError(parseMove(bad, s, 'p0')), `should reject: ${bad}`).toBe(true);
    }
  });

  it('gives human move summaries', () => {
    const s = craft(3);
    expect(moveSummary({ type: 'build_village', vertex: 'EFJ' }, s)).toContain('village at EFJ');
    expect(moveSummary({ type: 'offer', give: { palm: 2 }, get: { taro: 1 }, to: 'p2' }, s)).toBe(
      'offers palm + palm for taro to p2',
    );
    expect(moveSummary({ type: 'move_bandit', hex: 'B', victim: 'p1' }, s)).toBe(
      'moves the raider to B and robs p1',
    );
    expect(moveSummary({ type: 'play_progress', card: 'tithe', resource: 'reed' }, s)).toContain('collecting every reed');
  });
});
