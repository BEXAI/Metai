/**
 * Tiny deterministic fixture game + replay builder used by the kernel unit
 * tests (verify.test.ts, view.test.ts) and by the verify-replay CLI as a
 * pre-integration smoke path. It is NOT in the GAMES registry.
 *
 * The game ("fixture_nim"): the seed picks who moves first; players alternate
 * taking 1-3 tokens from a pile; every take is accompanied by a seeded d6 roll
 * (purpose `dice:turn:N`) purely so replays exercise draw verification; whoever
 * takes the last token wins.
 *
 * Seed-draw purposes used:
 *   'first'        — one int(nPlayers) during initialState (first player)
 *   'dice:turn:N'  — one d6 per applied move
 */

import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { canonicalJson, sha256Hex } from '../../crypto/canonical.ts';
import { hashState } from '../hash.ts';
import { createSeedStream } from '../seed.ts';
import {
  COMMIT_PREFIX,
  GENESIS_PREV,
  LOG_HASH_PREFIX,
  MOVE_SIGN_PREFIX,
  SEED_PREFIX,
  type LogEntry,
  type LogKind,
  type ReplayFile,
} from '../replay.ts';
import {
  isRuleError,
  playerId,
  type Game,
  type Json,
  type PlayerId,
  type VariantConfig,
} from '../types.ts';

export type NimState = {
  total: number;
  toMove: number;
  turn: number;
  nPlayers: number;
  lastRoll: number | null;
  lastMover: string | null;
};

export const fixtureGame: Game<NimState, number> = {
  meta: {
    id: 'fixture_nim',
    name: 'Fixture Nim',
    players: { min: 2, max: 2 },
    information: 'perfect',
    randomness: 'dice',
    variants: { total: { description: 'starting tokens', values: [4, 21], default: 4 } },
    notation: "'takeN' with N in 1..3 (bare digit also accepted)",
    boardText: 'single status line: total, player to move, turn, last roll',
    listed: false,
  },

  initialState(seed, players, variant: VariantConfig): NimState {
    const total = typeof variant.total === 'number' ? variant.total : 4;
    return {
      total,
      toMove: seed.int('first', players.length),
      turn: 0,
      nPlayers: players.length,
      lastRoll: null,
      lastMover: null,
    };
  },

  playersToMove(state) {
    return state.total > 0 ? [playerId(state.toMove)] : [];
  },

  legalMoves(state, player) {
    if (state.total <= 0 || player !== playerId(state.toMove)) return [];
    const out: number[] = [];
    for (let k = 1; k <= Math.min(3, state.total); k++) out.push(k);
    return out;
  },

  apply(state, player, move, seed) {
    if (player !== playerId(state.toMove)) {
      return { error: true, code: 'not_your_turn', message: `${player} is not to move` };
    }
    if (!Number.isInteger(move) || move < 1 || move > Math.min(3, state.total)) {
      return { error: true, code: 'bad_take', message: `cannot take ${move} from ${state.total}` };
    }
    const roll = seed.die(`dice:turn:${state.turn}`, 6);
    const next: NimState = {
      total: state.total - move,
      toMove: (state.toMove + 1) % state.nPlayers,
      turn: state.turn + 1,
      nPlayers: state.nPlayers,
      lastRoll: roll,
      lastMover: player,
    };
    return {
      state: next,
      events: [{ type: 'take', data: { player, take: move, roll }, visibility: 'public' }],
    };
  },

  isTerminal(state) {
    if (state.total > 0) return null;
    return {
      winners: state.lastMover === null ? [] : [state.lastMover],
      draw: false,
      reason: 'last_take',
    };
  },

  publicView(state) {
    return state;
  },

  privateView(state) {
    return state;
  },

  renderText(state, viewer) {
    return (
      `NIM  total=${state.total}  toMove=p${state.toMove}  turn=${state.turn}` +
      `  lastRoll=${state.lastRoll ?? '-'}  viewer=${viewer ?? 'spectator'}`
    );
  },

  encodeState(state) {
    return canonicalJson(state);
  },

  decodeState(encoded) {
    return JSON.parse(encoded) as NimState;
  },

  parseMove(input) {
    const m = /^(?:take)?([123])$/.exec(input.trim());
    if (!m) return { parseError: true, message: `unrecognized move '${input}' (want take1..take3)` };
    return Number(m[1]);
  },

  moveToNotation(move) {
    return `take${move}`;
  },

  moveSummary(move, state) {
    return `takes ${move}, leaving ${state.total - move}`;
  },
};

// ---------------------------------------------------------------------------
// Fixture replay builder: does exactly what a room (T6) will do, by hand.
// ---------------------------------------------------------------------------

const CREATED_AT = '2026-01-01T00:00:00.000Z';

export interface FixtureKeypair {
  secretKeyHex: string;
  publicKeyHex: string;
}

/** Deterministic test keypair derived from a label (never for production use). */
export function fixtureKeypair(label: string): FixtureKeypair {
  const secretKeyHex = sha256Hex(`fixture-key:${label}`);
  return {
    secretKeyHex,
    publicKeyHex: bytesToHex(ed25519.getPublicKey(hexToBytes(secretKeyHex))),
  };
}

/** Signs the frozen move message format from replay.ts over a submission body. */
export function signMoveMessage(
  key: FixtureKeypair,
  gameId: string,
  turnIndex: number,
  body: Json,
): string {
  const message = `${MOVE_SIGN_PREFIX}:${gameId}:${turnIndex}:${sha256Hex(canonicalJson(body))}`;
  return bytesToHex(ed25519.sign(new TextEncoder().encode(message), hexToBytes(key.secretKeyHex)));
}

/** Recomputes prev_hash/hash for every entry (used by tamper tests to re-seal a modified log). */
export function rehashLog(replay: ReplayFile): void {
  let prev = GENESIS_PREV;
  for (const e of replay.log) {
    e.prev_hash = prev;
    e.hash = sha256Hex(
      `${LOG_HASH_PREFIX}:${replay.game_id}:${e.seq}:${prev}:${canonicalJson({ kind: e.kind, payload: e.payload })}`,
    );
    prev = e.hash;
  }
}

/**
 * A complete, genuine 2-move replay of fixture_nim (total=4: first mover takes
 * 3 by notation, second takes the last token by { index } and wins), with a
 * real Ed25519 signature on each move. Deterministic: every call returns an
 * identical file.
 */
export function buildFixtureReplay(): ReplayFile {
  const gameId = 'g_fixture_0001';
  const secret = sha256Hex('fixture-secret');
  const drandRandomness = sha256Hex('fixture-drand');
  const drandRound = 12345;
  const commitment = sha256Hex(`${COMMIT_PREFIX}:${gameId}:${secret}`);
  const finalSeed = sha256Hex(`${SEED_PREFIX}:${gameId}:${secret}:${drandRandomness}`);
  const players: PlayerId[] = ['p0', 'p1'];
  const keys: Record<string, FixtureKeypair> = {
    p0: fixtureKeypair('p0'),
    p1: fixtureKeypair('p1'),
  };
  const variant: VariantConfig = { total: 4 };

  const seed = createSeedStream(finalSeed);
  let state = fixtureGame.initialState(seed, players, variant);
  const initialState = structuredClone(state) as Json;

  const log: LogEntry[] = [];
  const push = (kind: LogKind, payload: Json, signature: string | null): void => {
    const seq = log.length;
    const prev = seq === 0 ? GENESIS_PREV : log[seq - 1]!.hash;
    const hash = sha256Hex(
      `${LOG_HASH_PREFIX}:${gameId}:${seq}:${prev}:${canonicalJson({ kind, payload })}`,
    );
    log.push({ seq, kind, payload, prev_hash: prev, hash, signature, created_at: CREATED_AT });
  };

  push('commitment', { commitment, drand_round: drandRound }, null);
  push(
    'start',
    {
      game: fixtureGame.meta.id,
      variant,
      division: 'pure',
      players: [...players],
      ruleset_version: 'fixture-1',
      initial_state_hash: hashState(initialState),
    },
    null,
  );

  // Move 0 arrives as notation; move 1 as an { index } into legal_moves.
  const inputs: (string | { index: number })[] = ['take3', { index: 0 }];
  for (let turn = 0; turn < inputs.length; turn++) {
    const player = fixtureGame.playersToMove(state)[0]!;
    const input = inputs[turn]!;
    const move =
      typeof input === 'string'
        ? (fixtureGame.parseMove(input, state, player) as number)
        : fixtureGame.legalMoves(state, player)[input.index]!;
    const submission: Json = { game_id: gameId, turn_index: turn, move: typeof input === 'string' ? input : { index: input.index } };
    const notation = fixtureGame.moveToNotation(move, state);
    const before = seed.draws().length;
    const applied = fixtureGame.apply(state, player, move, seed);
    if (isRuleError(applied)) throw new Error(`fixture apply failed: ${applied.message}`);
    state = applied.state;
    const payload: Record<string, Json> = {
      turn_index: turn,
      player,
      agent_id: `a_${player}`,
      submission,
      notation,
      state_hash: hashState(state),
      draws: JSON.parse(JSON.stringify(seed.draws().slice(before))) as Json,
    };
    // Rooms log apply()'s events whenever it emitted any, and the verifier now
    // recomputes them (a deleted event is a tamper the state hash cannot see).
    // Same guard as rooms/core.ts: the key is written only when non-empty.
    if (applied.events.length > 0) payload.events = applied.events as unknown as Json;
    push('move', payload, signMoveMessage(keys[player]!, gameId, turn, submission));
  }

  const result = fixtureGame.isTerminal(state);
  if (!result) throw new Error('fixture game did not end after the scripted moves');
  push('end', { result: result as unknown as Json, final_state_hash: hashState(state) }, null);
  push('reveal', { reveal_secret: secret, final_seed: finalSeed, drand_randomness: drandRandomness }, null);

  return {
    version: 'ludus.replay.v1',
    game_id: gameId,
    game: fixtureGame.meta.id,
    variant,
    division: 'pure',
    ruleset_version: 'fixture-1',
    seats: players.map((p) => ({
      player: p,
      agent_id: `a_${p}`,
      handle: `fixture-${p}`,
      pubkey_ed25519: keys[p]!.publicKeyHex,
    })),
    commitment,
    drand_round: drandRound,
    drand_randomness: drandRandomness,
    reveal_secret: secret,
    final_seed: finalSeed,
    initial_state: initialState,
    log,
    result,
    seed_draws: seed.draws().slice(),
  };
}
