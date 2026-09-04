/**
 * Shared log-entry and replay-file shapes. Rooms (T6) produce them, the API
 * (T7) serves them, the offline verifier (T1) and the browser verifier (T9)
 * recompute them. Defined in stage 0 so the four tracks cannot drift.
 *
 * Hash chain (frozen):
 *   GENESIS_PREV = '0' * 64
 *   entry.hash = sha256Hex(
 *     'ludus.log.v1:' + game_id + ':' + seq + ':' + prev_hash + ':'
 *       + canonicalJson({ kind: entry.kind, payload: entry.payload }))
 *
 * Signing strings (frozen, from the spec):
 *   commitment   C = sha256Hex('ludus.commit.v1:' + game_id + ':' + secretHex)
 *   final_seed     = sha256Hex('ludus.seed.v1:' + game_id + ':' + secretHex + ':' + drand_randomness)
 *   move message   = 'ludus.move.v1:' + game_id + ':' + turn_index + ':'
 *                      + sha256Hex(canonicalJson(body_without_signature))
 *   doorbell proof = 'ludus.doorbell-endpoint.v1:' + agent + ':' + challenge + ':' + url
 */

import type { GameResult, Json, PlayerId, SeedDraw, VariantConfig } from './types.ts';

export const GENESIS_PREV = '0'.repeat(64);
export const LOG_HASH_PREFIX = 'ludus.log.v1';
export const COMMIT_PREFIX = 'ludus.commit.v1';
export const SEED_PREFIX = 'ludus.seed.v1';
export const MOVE_SIGN_PREFIX = 'ludus.move.v1';
export const DOORBELL_PREFIX = 'ludus.doorbell-endpoint.v1';

export type LogKind =
  | 'commitment' // { commitment, drand_round } — logged before the first move
  | 'start' //      { game, variant, division, players, ruleset_version, initial_state_hash }
  | 'move' //       { turn_index, player, agent_id, submission, notation, state_hash, draws }
  | 'timeout' //    { turn_index, player, applied_notation, state_hash, draws, strike_count }
  | 'strike' //     { turn_index, player, reason, strike_count }
  | 'resign' //     { turn_index, player }
  | 'draw_offer' // { turn_index, player }
  | 'draw_accept' //{ turn_index, player }
  | 'forfeit' //    terminal: { player, reason }; non-terminal elimination:
  //                { turn_index, player, reason, state_hash, draws, events? }
  | 'adjudication' // { reason, docket_id }
  | 'end' //        { result, final_state_hash }
  | 'reveal'; //    { reveal_secret, final_seed, drand_randomness } — logged after end

export interface LogEntry {
  seq: number;
  kind: LogKind;
  payload: Json;
  prev_hash: string;
  hash: string;
  /** Ed25519 signature hex for agent-authored entries (move/resign/draw_*), else null. */
  signature: string | null;
  created_at: string;
}

export interface ReplaySeat {
  player: PlayerId;
  agent_id: string;
  handle: string;
  pubkey_ed25519: string;
}

export interface ReplayFile {
  version: 'ludus.replay.v1';
  game_id: string;
  game: string;
  variant: VariantConfig;
  division: 'pure' | 'open';
  ruleset_version: string;
  seats: ReplaySeat[];
  commitment: string;
  drand_round: number;
  /** drand quicknet randomness for that round, hex; embedded so verification is offline. */
  drand_randomness: string;
  reveal_secret: string;
  final_seed: string;
  initial_state: Json;
  log: LogEntry[];
  result: GameResult;
  /** Full audit of every seeded draw, in order, for convenience (recomputable). */
  seed_draws: SeedDraw[];
}

export interface VerifyReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}
