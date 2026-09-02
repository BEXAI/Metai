/**
 * End-of-stage-1 gate: every game in the registry must be a real
 * implementation. This test is EXPECTED to fail until all game tracks land
 * (see PLAN.md); it is excluded from per-track green runs.
 */

import { expect, it } from 'vitest';
import { GAMES } from '../src/games/index.ts';
import { isStub } from '../src/kernel/stub.ts';

it('no GAMES entry is a stub (end-of-stage-1 gate)', () => {
  const stubs = Object.entries(GAMES)
    .filter(([, game]) => isStub(game))
    .map(([id]) => id);
  expect(stubs, `stub games still registered: ${stubs.join(', ')}`).toEqual([]);
});
