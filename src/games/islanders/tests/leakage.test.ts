import { describe, expect, it } from 'vitest';
import { runLeakageCheck } from '../../../kernel/leakage.ts';
import type { AnyGame, Json, PlayerId } from '../../../kernel/types.ts';
import islanders, { secretProbes } from '../index.ts';
import { type IslState } from '../rules.ts';
import { craft, give } from './helpers.ts';

const game = islanders as unknown as AnyGame;
const probes = (state: Json, player: PlayerId): string[] => secretProbes(state as IslState, player);

describe('islanders hidden information (gate A10 local)', () => {
  it('no view or render leaks another player hand or saga cards over 300+ states (3p)', { timeout: 600_000 }, () => {
    const res = runLeakageCheck(game, probes, { states: 300, seedPrefix: 'isl-leak-3', players: 3 });
    expect(res.statesChecked).toBe(300);
  });

  it('no leak over 150 states at 4 players', { timeout: 600_000 }, () => {
    const res = runLeakageCheck(game, probes, { states: 150, seedPrefix: 'isl-leak-4', players: 4 });
    expect(res.statesChecked).toBe(150);
  });

  it('the probes themselves would catch a raw-state leak', () => {
    const s = craft(3);
    give(s, 'p0', { palm: 2, taro: 1 });
    s.progress['p0'] = ['warrior', 'landmark'];
    const p0probes = secretProbes(s, 'p0');
    expect(p0probes.length).toBeGreaterThanOrEqual(4);
    // a naive view that dumped state.hands / state.progress would be caught
    const rawHands = JSON.stringify(
      Object.fromEntries(Object.entries(s.hands).map(([p, h]) => [p, Object.fromEntries(Object.entries(h).sort())])),
    );
    const rawProgress = JSON.stringify(s.progress);
    expect(p0probes.some((probe) => rawHands.includes(probe))).toBe(true);
    expect(p0probes.some((probe) => rawProgress.includes(probe))).toBe(true);
    // and a render that printed p0's secret lines to someone else would be caught
    const leakyRender = game.renderText(s as unknown as Json, 'p0');
    expect(p0probes.some((probe) => leakyRender.includes(probe))).toBe(true);
  });
});
