/**
 * Shared fixtures for the red-team-randomness attack suite.
 *
 * Deterministic everywhere: seat keys are sha256-derived, commit secrets and
 * drand randomness are fixed hex constants, every timestamp is an explicit
 * nowMs. No Date.now, no Math.random, no CSPRNG at test time.
 */

import { sha256Hex } from '../../src/crypto/canonical.ts';
import { signEd25519 } from '../../src/crypto/ed25519.ts';
import { publicKeyOf } from '../../src/identity/ed25519.ts';
import { playerId, type Json, type MoveSubmission, type VariantConfig } from '../../src/kernel/types.ts';
import type { AnyGame } from '../../src/kernel/types.ts';
import { moveSignMessage, RoomCore, type RoomSeat, type RoomSnapshot } from '../../src/rooms/core.ts';
import { miniGame } from '../../src/rooms/tests/mini-game.ts';

/** Commit-reveal secret every attack room uses (32 bytes lowercase hex). */
export const SECRET = '5a'.repeat(32);
/** Recorded drand quicknet randomness (32 bytes lowercase hex). */
export const DRAND = 'ab'.repeat(32);
export const DRAND_ROUND = 4242;
/** Base wall-clock for room creation (explicit, never Date.now). */
export const T0 = 1_000_000;

export interface Seat {
  seat: RoomSeat;
  secretKey: string;
}

/** Deterministic seat keypair derived from a label (never for production). */
export function makeSeat(i: number, label = 'red-team-randomness'): Seat {
  const secretKey = sha256Hex(`${label}:seat:${i}`);
  return {
    seat: {
      player: playerId(i),
      agent_id: `agent-${i}`,
      handle: `agent${i}`,
      pubkey_ed25519: publicKeyOf(secretKey),
    },
    secretKey,
  };
}

export interface CoreOpts {
  game?: AnyGame;
  variant?: VariantConfig;
  nSeats?: number;
  nowMs?: number;
  perMoveMs?: number;
  secretHex?: string;
  drandRound?: number;
  drandRandomnessHex?: string;
}

export function makeCore(gameId: string, opts: CoreOpts = {}): { core: RoomCore; seats: Seat[] } {
  const n = opts.nSeats ?? 2;
  const seats: Seat[] = [];
  for (let i = 0; i < n; i++) seats.push(makeSeat(i));
  const core = RoomCore.create(opts.nowMs ?? T0, {
    gameId,
    game: opts.game ?? miniGame,
    variant: opts.variant ?? {},
    seats: seats.map((s) => s.seat),
    division: 'open',
    rulesetVersion: '1.0.0',
    secretHex: opts.secretHex ?? SECRET,
    drandRound: opts.drandRound ?? DRAND_ROUND,
    drandRandomnessHex: opts.drandRandomnessHex ?? DRAND,
    perMoveMs: opts.perMoveMs ?? 60_000,
    clockScale: 1,
  });
  return { core, seats };
}

export function signedSub(
  gameId: string,
  seat: Seat,
  turnIndex: number,
  move: MoveSubmission['move'],
  extra?: Partial<MoveSubmission>,
): { submission: MoveSubmission; signature: string } {
  const submission: MoveSubmission = { game_id: gameId, turn_index: turnIndex, move, ...extra };
  const signature = signEd25519(seat.secretKey, moveSignMessage(gameId, turnIndex, submission));
  return { submission, signature };
}

/** Signs at the room's current turn index and submits. */
export function submit(
  core: RoomCore,
  gameId: string,
  seat: Seat,
  move: MoveSubmission['move'],
  nowMs: number,
  extra?: Partial<MoveSubmission>,
) {
  const { submission, signature } = signedSub(gameId, seat, core.turnIndex, move, extra);
  return core.submitMove(nowMs, seat.seat.agent_id, submission, signature);
}

/**
 * Plays a clean 5-move mini game to the end (p0 wins on the turn limit).
 * Returns the ended core. Throws if any submit is rejected.
 * NOTE: deliberately avoids the '#N' kernel index fallback — replays that use
 * it currently fail verification (see finding F2b in red-team-randomness.md);
 * the dedicated attack test in red-team-randomness-binding.test.ts covers it.
 */
export function playCleanMiniGame(gameId: string, opts: CoreOpts = {}): { core: RoomCore; seats: Seat[] } {
  const { core, seats } = makeCore(gameId, opts);
  let now = (opts.nowMs ?? T0) + 100;
  const moves: MoveSubmission['move'][] = ['a', { index: 1 }, 'b', { index: 0 }, 'b'];
  for (let i = 0; i < 5; i++) {
    const seat = seats[i % 2]!;
    const res = submit(core, gameId, seat, moves[i]!, (now += 500));
    if (!res.ok) throw new Error(`playCleanMiniGame: submit ${i} rejected: ${JSON.stringify(res)}`);
  }
  if (core.status !== 'ended') throw new Error('playCleanMiniGame: game did not end');
  return { core, seats };
}

/** Deep JSON copy of the live snapshot so tests can tamper without aliasing. */
export function snapshotCopy(core: RoomCore): RoomSnapshot {
  return JSON.parse(JSON.stringify(core.snapshot())) as RoomSnapshot;
}

/** Flips one lowercase-hex nibble at position i (a fortiori a bit-level tamper). */
export function flipHex(hex: string, i = 0): string {
  const c = hex[i];
  if (c === undefined) throw new Error('flipHex: index out of range');
  const flipped = c === '0' ? '1' : '0';
  return hex.slice(0, i) + flipped + hex.slice(i + 1);
}

/** JSON-serializes a value for substring leak scanning. */
export function scanString(value: unknown): string {
  return JSON.stringify(value as Json);
}
