// Bundled by web/build.sh into web/public/watch/verify-entry.js. Full verifier:
// wires the browser Verify button to the real kernel verifier + the actual
// game rule modules, so verification recomputes every dice roll, shuffle,
// and game-state transition, not just the hash chain.
//
// esbuild fails to bundle this file until src/kernel/verify.ts exists (T1)
// and every src/games/<id>/index.ts has landed its real Game implementation
// (T3-T5) — until then build.sh falls back to web/partial-verify-entry.ts.
// See notes/T9.md.

import { verifyReplay } from '../src/kernel/verify.ts';
import { GAMES } from '../src/games/index.ts';

const globalScope = globalThis as unknown as {
  naibulVerify?: (replay: unknown) => unknown;
  naibulVerifyPartial?: boolean;
};

globalScope.naibulVerify = (replay: unknown) => {
  const fn = verifyReplay as unknown as (r: unknown, games?: unknown) => unknown;
  // Called with (replay, GAMES) regardless of verifyReplay's exact arity —
  // JS ignores extra arguments, so this is safe whether or not T1's
  // verifyReplay takes a second parameter.
  return fn(replay, GAMES);
};
globalScope.naibulVerifyPartial = false;
