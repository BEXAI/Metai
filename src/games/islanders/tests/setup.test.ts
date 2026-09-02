import { describe, expect, it } from 'vitest';
import { isRuleError } from '../../../kernel/types.ts';
import {
  applyMove,
  createInitialState,
  handTotal,
  legalMoves,
  playersToMove,
  type IslState,
} from '../rules.ts';
import { freshSeed, mustApply, mustReject, seatPlayers, seedForRoll } from './helpers.ts';

/** Scripted 3-player setup: spread-out spots with known adjacent terrain. */
function runSetup(): { beforeLastRoad: IslState; final: IslState } {
  let s = createInitialState(freshSeed('setup-fixture'), seatPlayers(3), {});
  const steps: [string, { v: string; r: string }][] = [
    ['p0', { v: 'Aab', r: 'Ab' }],
    ['p1', { v: 'Hgi', r: 'Hi' }],
    ['p2', { v: 'Snr', r: 'Sr' }],
    ['p2', { v: 'EFJ', r: 'FJ' }], // second pass starts: pays E (coral) + F (reed)
    ['p1', { v: 'JNO', r: 'JN' }], // pays N (taro) + O (coral)
    ['p0', { v: 'MNQ', r: 'MQ' }], // pays M (palm) + N (taro) + Q (obsidian)
  ];
  let beforeLastRoad: IslState | null = null;
  for (const [p, { v, r }] of steps) {
    expect(playersToMove(s)).toEqual([p]);
    s = mustApply(s, p, { type: 'build_village', vertex: v });
    expect(playersToMove(s)).toEqual([p]);
    const last = s.setupMoves === 11;
    if (last) beforeLastRoad = s;
    const seed = last ? seedForRoll(1, (t) => t !== 7) : freshSeed('setup-road');
    s = mustApply(s, p, { type: 'build_road', edge: r }, seed);
  }
  return { beforeLastRoad: beforeLastRoad!, final: s };
}

describe('islanders setup', () => {
  it('follows snake order p0..p2,p2..p0 and pays only for the second village', () => {
    const { beforeLastRoad, final: s } = runSetup();
    // first-pass villages paid nothing; second-pass paid adjacent producing hexes
    // (checked before the last road triggers the first production roll)
    expect(beforeLastRoad.hands['p0']).toEqual({ palm: 1, coral: 0, reed: 0, taro: 1, obsidian: 1 });
    expect(beforeLastRoad.hands['p1']).toEqual({ palm: 0, coral: 1, reed: 0, taro: 1, obsidian: 0 });
    expect(beforeLastRoad.hands['p2']).toEqual({ palm: 0, coral: 1, reed: 1, taro: 0, obsidian: 0 });
    // bank debited accordingly
    expect(beforeLastRoad.bank['coral']).toBe(19 - 2);
    // setup complete: turn 1 rolled (non-7 seed), main phase, p0 to act
    expect(s.phase).toBe('main');
    expect(s.turn).toBe(1);
    expect(playersToMove(s)).toEqual(['p0']);
    expect(s.lastRoll).toBeGreaterThanOrEqual(2);
    expect(s.lastRoll).not.toBe(7);
    // supplies decremented
    expect(s.supply['p0']!['villages']).toBe(3);
    expect(s.supply['p0']!['roads']).toBe(13);
  });

  it('enforces the distance rule during setup and rejects detached setup roads', () => {
    let s = createInitialState(freshSeed('setup-distance'), seatPlayers(3), {});
    s = mustApply(s, 'p0', { type: 'build_village', vertex: 'EFJ' });
    s = mustApply(s, 'p0', { type: 'build_road', edge: 'EF' });
    // p1 may not build on EFJ (occupied) or an adjacent vertex
    expect(mustReject(s, 'p1', { type: 'build_village', vertex: 'EFJ' })).toBe('distance_rule');
    expect(mustReject(s, 'p1', { type: 'build_village', vertex: 'FJK' })).toBe('distance_rule'); // adjacent via FJ
    const spots = legalMoves(s, 'p1').map((m) => (m.type === 'build_village' ? m.vertex : ''));
    expect(spots).not.toContain('EFJ');
    expect(spots).not.toContain('FJK');
    expect(spots).not.toContain('EIJ'); // adjacent via EJ
    // a legal distant village, then a road that does not touch it is rejected
    s = mustApply(s, 'p1', { type: 'build_village', vertex: 'JNO' });
    expect(mustReject(s, 'p1', { type: 'build_road', edge: 'AB' })).toBe('bad_setup_road');
    expect(mustReject(s, 'p1', { type: 'build_road', edge: 'EF' })).toBe('bad_setup_road');
  });

  it('rejects wrong move kinds and wrong players during setup', () => {
    const s = createInitialState(freshSeed('setup-order'), seatPlayers(4), {});
    expect(playersToMove(s)).toEqual(['p0']);
    expect(legalMoves(s, 'p1')).toEqual([]);
    const res = applyMove(s, 'p1', { type: 'build_village', vertex: 'EFJ' }, freshSeed('x'));
    expect(isRuleError(res) && res.code).toBe('not_your_turn');
    expect(mustReject(s, 'p0', { type: 'build_road', edge: 'EF' })).toBe('bad_phase');
    expect(mustReject(s, 'p0', { type: 'end_turn' })).toBe('bad_phase');
  });

  it('4-player snake order is p0..p3 then p3..p0', () => {
    let s = createInitialState(freshSeed('setup-4p'), seatPlayers(4), {});
    const order: string[] = [];
    while (s.phase === 'setup') {
      const p = playersToMove(s)[0]!;
      const moves = legalMoves(s, p);
      order.push(p);
      s = mustApply(s, p, moves[0]!, s.setupMoves === 15 ? seedForRoll(1, (t) => t !== 7) : undefined);
    }
    const seats = order.filter((_, i) => i % 2 === 0); // village steps only
    expect(seats).toEqual(['p0', 'p1', 'p2', 'p3', 'p3', 'p2', 'p1', 'p0']);
  });
});
