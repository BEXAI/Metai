/**
 * Offline replay verifier CLI (spec §identity_and_integrity.replay, gate A8):
 *
 *   node --experimental-strip-types test/verify-replay.ts <replay.json>
 *
 * Recomputes the commitment, final seed, hash chain, every Ed25519 signature,
 * every seeded draw, and the full game with no network access; prints the
 * VerifyReport and exits 1 on any failed check (2 on usage/read errors).
 *
 * The fixture game from the kernel test suite is merged into the registry so
 * fabricated fixture replays (src/kernel/tests/fixture-game.ts) verify
 * end-to-end even before all game tracks land; its id cannot collide with a
 * real game.
 */

import { readFileSync } from 'node:fs';
import { GAMES } from '../src/games/index.ts';
import type { ReplayFile } from '../src/kernel/replay.ts';
import { fixtureGame } from '../src/kernel/tests/fixture-game.ts';
import type { AnyGame } from '../src/kernel/types.ts';
import { verifyReplay } from '../src/kernel/verify.ts';

const path = process.argv[2];
if (!path) {
  console.error('usage: node --experimental-strip-types test/verify-replay.ts <replay.json>');
  process.exit(2);
}

let replay: ReplayFile;
try {
  replay = JSON.parse(readFileSync(path, 'utf8')) as ReplayFile;
} catch (err) {
  console.error(`could not read/parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

const games: Record<string, AnyGame> = { ...GAMES, [fixtureGame.meta.id]: fixtureGame };
const report = verifyReplay(replay, games);

console.log(`ludus verify-replay — ${String(replay.game)} ${String(replay.game_id)} (${replay.log?.length ?? 0} log entries)`);
for (const c of report.checks) {
  console.log(`  ${c.ok ? ' ok ' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(report.ok ? 'REPLAY OK' : 'REPLAY INVALID');
process.exit(report.ok ? 0 : 1);
