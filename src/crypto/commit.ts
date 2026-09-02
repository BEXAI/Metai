/**
 * Commit–reveal randomness (spec §identity_and_integrity.randomness, gate A8).
 *
 * Before a game starts the Worker draws a 32-byte secret s and publishes
 *   C = sha256('ludus.commit.v1:' + game_id + ':' + hex(s))
 * The final seed mixes in a drand quicknet round at or after commitment time:
 *   final_seed = sha256('ludus.seed.v1:' + game_id + ':' + hex(s) + ':' + drand_randomness)
 * After the game ends s is revealed; every dice roll, shuffle, layout, and
 * steal is recomputable from final_seed by purpose tag (src/kernel/seed.ts).
 *
 * The prefix strings are frozen in src/kernel/replay.ts and imported from
 * there — rooms, API, and both verifiers all agree by construction.
 */

import { randomBytes } from '@noble/hashes/utils';
import { bytesToHex } from '@noble/hashes/utils';
import { COMMIT_PREFIX, SEED_PREFIX } from '../kernel/replay.ts';
import { sha256Hex } from './canonical.ts';

const HEX32_RE = /^[0-9a-f]{64}$/;

function assertGameId(gameId: string): void {
  if (typeof gameId !== 'string' || gameId.length === 0) {
    throw new Error('commit: gameId must be a non-empty string');
  }
}

function assertHex32(name: string, value: string): void {
  if (typeof value !== 'string' || !HEX32_RE.test(value)) {
    throw new Error(`commit: ${name} must be 32 bytes of lowercase hex`);
  }
}

/** Draws a fresh 32-byte secret s as lowercase hex (Worker side, one per game). */
export function generateSecretHex(): string {
  return bytesToHex(randomBytes(32));
}

/** C = sha256('ludus.commit.v1:' + gameId + ':' + secretHex). Logged before the first move. */
export function makeCommitment(gameId: string, secretHex: string): string {
  assertGameId(gameId);
  assertHex32('secret', secretHex);
  return sha256Hex(`${COMMIT_PREFIX}:${gameId}:${secretHex}`);
}

/**
 * final_seed = sha256('ludus.seed.v1:' + gameId + ':' + secretHex + ':' + drandRandomnessHex).
 * Feed the result straight into createSeedStream().
 */
export function deriveFinalSeed(gameId: string, secretHex: string, drandRandomnessHex: string): string {
  assertGameId(gameId);
  assertHex32('secret', secretHex);
  assertHex32('drand randomness', drandRandomnessHex);
  return sha256Hex(`${SEED_PREFIX}:${gameId}:${secretHex}:${drandRandomnessHex}`);
}

/**
 * Recomputes the commitment from the revealed secret and compares. Returns
 * false — never throws — on malformed input, so verifiers can call it on
 * untrusted replay data. One changed byte anywhere fails (gate A8).
 */
export function verifyCommitment(gameId: string, secretHex: string, commitment: string): boolean {
  try {
    return makeCommitment(gameId, secretHex) === commitment;
  } catch {
    return false;
  }
}
