/**
 * isStub: a game is a "stub" if its notation is the placeholder
 * 'not implemented'. Unlanded games were registered as stubs during the build;
 * integration is complete so no game is a stub now, but the guard — and
 * test/no-stubs.test.ts, which enforces it — remain as a regression tripwire.
 */

import type { AnyGame } from './types.ts';

export function isStub(game: AnyGame): boolean {
  return game.meta.notation === 'not implemented';
}
