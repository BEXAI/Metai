/**
 * House-agent identity: the roster, the handle convention, and the ONE
 * deterministic Ed25519 derivation the seeding script, the pairer and the room
 * all share (plan §8.2 "Keys: one Worker secret, HOUSE_SK_SEED").
 *
 *   sk = sha256Hex('ludus.house-key.v1:' + seed + ':' + handle)
 *
 * sha256Hex is exactly 64 lowercase hex characters, which is what signEd25519
 * and publicKeyOf require (src/crypto/ed25519.ts:38-51), so the derivation is
 * total: every handle maps to a valid key with no per-agent secret to store,
 * distribute or rotate, and `agents.pubkey_ed25519`'s unique index is satisfied
 * by construction because the handles are distinct.
 *
 * IT DEGRADES TO OFF, NEVER TO A DEFAULT KEY. When HOUSE_SK_SEED is absent (it
 * is not configured in production today) every entry point here returns null
 * and house backfill is simply DISABLED — the pairer drops the rostered pool,
 * so no table forms that the room could not then drive, and nothing throws at
 * request time. A hardcoded fallback seed would be strictly worse than no house
 * agents at all: the keys would be in the repo and every "house" signature in
 * every replay would be forgeable by anyone who cloned it.
 *
 * ATTESTATION, STATED OPENLY (plan D-10). Once the room signs for these seats,
 * a house seat's signature attests only "the room wrote this" — not "an
 * independent operator did". HOUSE_SK_SEED is a single secret whose compromise
 * forges all 24 identities. That is an accepted trade, and the price of
 * accepting it is that a house seat must be VISIBLY marked everywhere a
 * spectator can see it: `isHouseHandle` is the one predicate for that, and
 * `houseSeatMarks` is the shape the replay and /watch publish.
 */

import { sha256Hex } from '../crypto/canonical.ts';
import { publicKeyOf, signEd25519 } from '../crypto/ed25519.ts';
import type { PlayerId } from '../kernel/types.ts';

// ---------------------------------------------------------------------------
// Handles and rosters
// ---------------------------------------------------------------------------

/** The public convention. `loadHouseAgents` and getLeaderboards both key on it. */
export const HOUSE_HANDLE_PREFIX = 'house-';

/** Frozen: it is mixed into every derived key, so changing it rotates all 24. */
export const HOUSE_KEY_PURPOSE = 'ludus.house-key.v1';

/**
 * A seed shorter than this is treated as NOT CONFIGURED. 32 hex/base64
 * characters is the smallest thing an operator could plausibly have meant as a
 * secret; a 4-character typo in a deployment script must not silently become
 * the identity of 24 agents that then sign into permanent replays.
 */
export const HOUSE_SEED_MIN_CHARS = 32;

/**
 * game -> roster key. THE POINT OF THIS MAP IS WHAT IT DOES NOT CONTAIN
 * (plan §8.2 bug 1, D-5).
 *
 * `loadHouseAgents` is game-agnostic and `houseKindOf` keys on a substring, so
 * `house-ww-mock-03` is kind `mock` and would pass any {mock, anthropic} filter
 * for chess, go, islanders and landlord. Today the pool is empty so nothing
 * happens; the moment 24 rows exist, every 2-seat queue that has waited two
 * sweeps would start forming house-backfilled games in every game type, driven
 * by an adapter with no policy for them, and eating the concurrency budget
 * werewolf's sizing depends on.
 *
 * So eligibility is by ROSTER, not by kind:
 *   - a game WITH a roster key accepts only house agents carrying that key;
 *   - a game WITHOUT one accepts only house agents carrying NO roster key,
 *     i.e. exactly the general-purpose pool that exists today.
 * Whether the other queues should start backfilling is a separate product
 * decision, and this file must not make it by accident.
 */
export const HOUSE_ROSTER_BY_GAME: Readonly<Record<string, string>> = {
  werewolf: 'ww',
};

const ROSTER_KEYS: ReadonlySet<string> = new Set(Object.values(HOUSE_ROSTER_BY_GAME));

/** The roster key this game draws from, or null when it has no roster. */
export function houseRosterFor(game: string): string | null {
  return HOUSE_ROSTER_BY_GAME[game] ?? null;
}

export function isHouseHandle(handle: string): boolean {
  return typeof handle === 'string' && handle.startsWith(HOUSE_HANDLE_PREFIX);
}

/**
 * The roster segment of a house handle, or null for a general-purpose house
 * agent. `house-ww-mock-01` -> 'ww'; `house-random-1` -> null, because 'random'
 * is not a declared roster key. Closed by construction: an unknown segment is
 * never mistaken for a roster.
 */
export function houseRosterOfHandle(handle: string): string | null {
  if (!isHouseHandle(handle)) return null;
  const segment = handle.slice(HOUSE_HANDLE_PREFIX.length).split('-')[0] ?? '';
  return ROSTER_KEYS.has(segment) ? segment : null;
}

/** The eligibility rule in one place: roster of the handle === roster of the game. */
export function houseHandleServesGame(handle: string, game: string): boolean {
  if (!isHouseHandle(handle)) return false;
  return houseRosterOfHandle(handle) === houseRosterFor(game);
}

// ---------------------------------------------------------------------------
// The werewolf roster (plan §8.2 "Ship 24 agents, houseConcurrency = 2")
// ---------------------------------------------------------------------------

function series(prefix: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= count; i++) out.push(`${prefix}${String(i).padStart(2, '0')}`);
  return out;
}

/**
 * 24 handles: 6 `anthropic` + 18 `mock` by `houseKindOf` (pairing.ts).
 *
 * Sizing: agents = ceil(tables x (seats - 1) / houseConcurrency) with slack.
 * 18 x 2 = 36 mock slots is a comfortable 5 concurrent lone-entrant tables
 * (7 house seats each). The six `anthropic` handles are registered now and
 * INERT until an API key reaches this layer — `loadHouseAgents` drops the
 * anthropic kind because ApiEnv carries no ANTHROPIC_API_KEY — so the sizing
 * above is deliberately computed from the 18 alone.
 */
export const WEREWOLF_HOUSE_ROSTER: readonly string[] = [
  ...series('house-ww-anthropic-', 6),
  ...series('house-ww-mock-', 18),
];

/** Every handle the hall registers for this game (empty when it has no roster). */
export function houseRosterHandles(game: string): readonly string[] {
  return houseRosterFor(game) === 'ww' ? WEREWOLF_HOUSE_ROSTER : [];
}

/**
 * Which werewolf house policy a handle plays. `silent` is the deliberate floor
 * whose purpose is to make the spread measurable (plan §7.7); it is supported
 * and selectable but is not on the shipped roster, so every seeded handle plays
 * `basic` today.
 */
export function houseTierOfHandle(handle: string): 'silent' | 'basic' {
  return handle.includes('-silent-') ? 'silent' : 'basic';
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Read structurally rather than through a declared field because
 * `Secrets` (src/api/env.ts) does not carry `house_sk_seed` yet — that
 * declaration, and populating it from the HOUSE_SK_SEED binding at the adapter
 * boundary in src/index.ts, is the one wiring change this module needs from
 * outside. Until then the lookup is simply absent and backfill stays off, which
 * is exactly the behaviour production wants today.
 */
export function houseSeedOf(secrets: object): string | undefined {
  const value = (secrets as Record<string, unknown>).house_sk_seed;
  return typeof value === 'string' ? value : undefined;
}

export interface HouseKeyEnv {
  secrets: object;
}

export interface HouseKeyring {
  /** 64 lowercase hex characters. Never logged, never returned to a request. */
  secretKeyHex(handle: string): string;
  publicKeyHex(handle: string): string;
  /** Signs the frozen `ludus.move.v1:` message from RoomCore.moveSignMessage. */
  sign(handle: string, message: string): string;
}

/**
 * The keyring for a seed, or null when the seed is missing/too short. Pure and
 * silent: the caller decides whether an unconfigured seed is worth a log line.
 */
export function houseKeyringFromSeed(seed: string | null | undefined): HouseKeyring | null {
  if (typeof seed !== 'string') return null;
  const trimmed = seed.trim();
  if (trimmed.length < HOUSE_SEED_MIN_CHARS) return null;
  const derive = (handle: string): string => sha256Hex(`${HOUSE_KEY_PURPOSE}:${trimmed}:${handle}`);
  return {
    secretKeyHex: derive,
    publicKeyHex: (handle) => publicKeyOf(derive(handle)),
    sign: (handle, message) => signEd25519(derive(handle), message),
  };
}

/** Warn once per isolate, not once per sweep: this is a config fact, not an event. */
let warnedUnconfigured = false;

/**
 * The production entry point. Returns null — never throws, never falls back to
 * a baked-in key — when HOUSE_SK_SEED is not configured, which is the state of
 * production today. Callers must treat null as "house backfill is off".
 */
export function houseKeyringFrom(env: HouseKeyEnv): HouseKeyring | null {
  const keyring = houseKeyringFromSeed(houseSeedOf(env.secrets));
  if (keyring === null && !warnedUnconfigured) {
    warnedUnconfigured = true;
    console.warn(
      'house: HOUSE_SK_SEED is not configured (or is shorter than ' +
        `${HOUSE_SEED_MIN_CHARS} characters); house backfill is disabled.`,
    );
  }
  return keyring;
}

// ---------------------------------------------------------------------------
// Marking a house seat (plan D-10)
// ---------------------------------------------------------------------------

export const HOUSE_ATTESTATION_NOTE =
  'House seat. Its key is derived by the hall from one secret and the room signs its moves, so the ' +
  'signature attests that the room wrote this move — not that an independent operator did.';

export interface HouseSeatMark {
  player: PlayerId;
  agent_id: string;
  handle: string;
  house: true;
  /** Distinguishes a room-signed seat from an operator-signed one. */
  attestation: 'room_signed';
  note: string;
}

/** Structural: RoomSeat and the pairer's seats_json rows both satisfy it. */
export interface SeatLike {
  player: PlayerId;
  agent_id: string;
  handle: string;
}

/**
 * The house seats among these, in seat order, in the shape a spectator surface
 * publishes. A seat missing from this list is an ordinary entrant.
 */
export function houseSeatMarks(seats: readonly SeatLike[]): HouseSeatMark[] {
  return seats
    .filter((s) => isHouseHandle(s.handle))
    .map((s) => ({
      player: s.player,
      agent_id: s.agent_id,
      handle: s.handle,
      house: true as const,
      attestation: 'room_signed' as const,
      note: HOUSE_ATTESTATION_NOTE,
    }));
}
