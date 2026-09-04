/**
 * Dev-time probe (not part of the suite): how fast does the RoomCore snapshot
 * blob grow for landlord/islanders, and how many decisions until the ~2MB
 * SQLite per-value cap? Runs fully in-process (no wrangler).
 *   node --experimental-strip-types test/e2e/sizeprobe.ts landlord '{"turn_limit":75,"starting_cash":1000}'
 */

import { RoomCore, type RoomSeat } from '../../src/rooms/core.ts';
import { moveSignMessage } from '../../src/rooms/core.ts';
import { GAMES } from '../../src/games/index.ts';
import { generateKeypair, signEd25519 } from '../../src/crypto/ed25519.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { roundAt } from '../../src/crypto/drand.ts';
import type { Json, MoveSubmission, VariantConfig, ViewObject } from '../../src/kernel/types.ts';
import { decisionOf, landlordStrategy, islandersStrategy, randomStrategy, updateFlags, type MatchFlags, type Strategy } from './match.ts';

const gameId = 'probe_1';
const gameName = process.argv[2] ?? 'landlord';
const variant = (process.argv[3] ? JSON.parse(process.argv[3]) : {}) as VariantConfig;
const players = Number(process.argv[4] ?? 3);
const game = GAMES[gameName]!;

const keys = Array.from({ length: players }, () => generateKeypair());
const seats: RoomSeat[] = keys.map((k, i) => ({
  player: `p${i}`,
  agent_id: `a_${i}`,
  handle: `probe-${i}`,
  pubkey_ed25519: k.publicKeyHex,
}));

const core = RoomCore.create(Date.now(), {
  gameId,
  game,
  variant,
  seats,
  division: 'open',
  rulesetVersion: '1.0.0',
  secretHex: sha256Hex('probe-secret'),
  // Must be at or after the commitment time (spec randomness[1], enforced by RoomCore.create).
  drandRound: roundAt(Date.now()) + 100,
  drandRandomnessHex: sha256Hex('probe-drand'),
  perMoveMs: 60_000,
});

const strategies: Record<string, Strategy> = { landlord: landlordStrategy, islanders: islandersStrategy };
const strategy = strategies[gameName] ?? randomStrategy;
const seed = createSeedStream(sha256Hex('probe-picks'));
const flags: MatchFlags = { auction: false, auctionWon: false, trade: false, steal: false, bankruptcy: false };

let decisions = 0;
let lastEv = 0;
const t0 = Date.now();
while (core.status === 'running' && decisions < 5000) {
  const movers = core.playersToMoveNow();
  if (movers.length === 0) break;
  for (const player of movers) {
    if (core.status !== 'running') break;
    const seatIx = Number(player.slice(1));
    const view = core.viewFor(player, Date.now()) as ViewObject;
    if (view.legal_moves.length === 0) continue;
    const pick = strategy(view, { flags, seed, decision: decisions });
    const decision = decisionOf(pick);
    const sub: MoveSubmission = { game_id: gameId, turn_index: view.turn_index, move: decision.move };
    if (decision.utterance !== undefined) sub.utterance = decision.utterance;
    const msg = moveSignMessage(gameId, sub.turn_index, sub);
    const res = core.submitMove(Date.now(), `a_${seatIx}`, sub, signEd25519(keys[seatIx]!.secretKeyHex, msg));
    if (!res.ok) {
      console.log(`reject at decision ${decisions}: ${res.code} ${res.message}`);
      continue;
    }
    decisions++;
    const fresh = core.eventsSince(lastEv);
    for (const ev of fresh) lastEv = Math.max(lastEv, ev.seq);
    updateFlags(flags, fresh.map((ev) => ({ seq: ev.seq, type: ev.type, data: ev.data })));
    if (decisions % 100 === 0) {
      const size = JSON.stringify(core.snapshot()).length;
      const pub = core.publicStateSummary() as { [k: string]: Json };
      console.log(`decisions=${decisions} snapshot=${(size / 1024).toFixed(0)}KB turn=${pub.turn_index} phase=${pub.phase} flags=${JSON.stringify(flags)}`);
    }
  }
}
const size = JSON.stringify(core.snapshot()).length;
console.log(
  `DONE game=${gameName} decisions=${decisions} status=${core.status} snapshot=${(size / 1024).toFixed(0)}KB ` +
    `result=${JSON.stringify(core.status === 'ended' ? (core.replayFile()?.result ?? null) : null)} flags=${JSON.stringify(flags)} in ${Date.now() - t0}ms`,
);
