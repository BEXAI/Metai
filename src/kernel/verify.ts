/**
 * Offline replay verifier (spec §identity_and_integrity.replay, gates A2/A8).
 *
 * Pure: no network, no clocks, no Date. Everything is recomputed from the
 * replay file plus the game module the caller passes in. Used by the
 * `test/verify-replay.ts` CLI and (compiled) by the browser verifier.
 *
 * Checks, in report order (each is a named entry in report.checks):
 *   structure        — replay/log shape, seq === index, exactly one commitment/
 *                      start/end/reveal, commitment before start before the
 *                      first state-changing entry, end second-to-last,
 *                      reveal last, seats are p0..p(n-1) in order.
 *   commitment       — commitment === sha256('ludus.commit.v1:'+game_id+':'+reveal_secret)
 *                      and the commitment log entry matches replay fields.
 *   final_seed       — final_seed === sha256('ludus.seed.v1:'+game_id+':'+reveal_secret+':'+drand_randomness).
 *   hash_chain       — every entry hash recomputes per the frozen rule in
 *                      src/kernel/replay.ts; prev links from GENESIS_PREV.
 *   signatures       — every move/resign/draw_offer/draw_accept entry carries a
 *                      valid Ed25519 signature by that seat's key over the
 *                      frozen move-message format; no other kind carries one.
 *   game_module      — replay.game resolves in the provided registry.
 *   recomputation    — initialState + every move/timeout re-applied through
 *                      game.apply with a fresh SeedStream over final_seed;
 *                      state hashes, notations, per-entry draws and per-entry
 *                      events all match. A 'forfeit' entry carrying a
 *                      state_hash is a non-terminal ELIMINATION and is
 *                      recomputed through game.forfeitPlayer.
 *   result           — end payload matches replay.result; replay.result matches
 *                      game.isTerminal on the recomputed final state, or is
 *                      explained by a logged resign/forfeit/adjudication/draw_accept.
 *   seed_draws       — replay.seed_draws equals the full recomputed draw log.
 *   reveal_after_end — reveal entry is the final entry, after end, and its
 *                      payload matches the replay's reveal fields.
 *
 * Refinements of the informal payload comments in replay.ts (documented in
 * notes/T1-kernel.md; rooms (T6) must produce entries accordingly):
 *   - The signed body of a 'move' entry is payload.submission (the exact
 *     MoveSubmission the agent sent). For resign/draw_offer/draw_accept the
 *     signed body is payload.submission when present, else the payload itself
 *     ({ turn_index, player }). Message:
 *       'ludus.move.v1:' + game_id + ':' + payload.turn_index + ':'
 *         + sha256Hex(canonicalJson(body)).
 *   - Moves are re-resolved from submission.move (notation via parseMove,
 *     the kernel '#N' index-string fallback into legalMoves' canonical order,
 *     or { index } into the same order). If the room also logged the resolved
 *     move as payload.move it must equal the re-resolved move.
 *   - A 'move' entry may carry payload.forced === 'illegal' (frozen policy,
 *     rooms/core.ts): the third illegal attempt of a turn forced a seeded
 *     random legal move. payload.submission is then the REJECTED (but signed)
 *     third submission — its signature is still checked — and the applied
 *     move is recomputed as legal[seed.int('illegal:turn:N', legal.length)],
 *     never from the submission. notation/state_hash/draws cover the applied
 *     move.
 *   - 'timeout' entries cover the timeout penalty path only (frozen purpose
 *     `timeout:turn:N`; a logged payload.purpose must equal it).
 *     game.defaultMove is used when the game defines it; otherwise the move
 *     is legal[seed.int('timeout:turn:N', legal.length)].
 *   - 'forfeit' has two shapes. { player, reason } is the TERMINAL forfeit
 *     every game without game.forfeitPlayer produces: nothing follows it, so
 *     the state is not advanced. { turn_index, player, reason, state_hash,
 *     draws, events? } is a non-terminal ELIMINATION: the state IS advanced,
 *     by calling the pure game.forfeitPlayer, and everything after it depends
 *     on the result. Neither shape is signed.
 *   - payload.events (when present) must equal the events the recomputed
 *     apply() / forfeitPlayer() emitted, including the private ones that live
 *     only in the log.
 *   - entry.created_at is not verifiable offline and is ignored.
 */

import { canonicalJson, sha256Hex } from '../crypto/canonical.ts';
import { verifyEd25519 } from '../crypto/ed25519.ts';
import { hashState } from './hash.ts';
import { resolveSubmittedMove } from './move.ts';
import { createSeedStream } from './seed.ts';
import {
  COMMIT_PREFIX,
  GENESIS_PREV,
  LOG_HASH_PREFIX,
  MOVE_SIGN_PREFIX,
  SEED_PREFIX,
  type ReplayFile,
  type VerifyReport,
} from './replay.ts';
import {
  isRuleError,
  playerId,
  type AnyGame,
  type Json,
  type SeedDraw,
} from './types.ts';

type Check = { name: string; ok: boolean; detail?: string };
type JsonObj = { [key: string]: Json };

/**
 * Entry kinds that advance the recomputed state. 'forfeit' is here because a
 * game with `forfeitPlayer` turns a three-strikes/flag-fall loss into an
 * in-game ELIMINATION and keeps playing, so that entry mutates state and every
 * later state_hash depends on it. The terminal forfeit every other game
 * produces carries no `state_hash` and is skipped, exactly as before.
 */
const STATE_KINDS: ReadonlySet<string> = new Set(['move', 'timeout', 'forfeit']);
const SIGNED_KINDS: ReadonlySet<string> = new Set(['move', 'resign', 'draw_offer', 'draw_accept']);
const CAUSE_KINDS: ReadonlySet<string> = new Set(['resign', 'forfeit', 'adjudication', 'draw_accept']);

function asObj(x: Json | undefined): JsonObj | null {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? x : null;
}

function jsonEq(a: Json, b: Json): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Re-resolves a logged submission. The ladder ('#n' / parseMove / { index })
 * plus the optional bindUtterance step lives in kernel/move.ts, shared verbatim
 * with rooms/core.ts — a drift between the live room and this verifier would
 * look exactly like tampering months later. The failure is discriminated there
 * and worded HERE, so this file's messages are unchanged.
 *
 * ONE MESSAGE CHANGED, deliberately (see kernel/move.ts): the shared helper
 * adopts the room's stricter `Number.isInteger(index) && index >= 0`, so a
 * non-integer or negative logged index — reachable only by tampering — now
 * reports as the bad-shape string instead of the out-of-range one.
 */
function resolveMove(
  game: AnyGame,
  state: Json,
  player: string,
  payload: JsonObj,
  sub: JsonObj,
): { ok: true; move: Json } | { ok: false; detail: string } {
  const r = resolveSubmittedMove(game, state, player, sub as { move: unknown; utterance?: unknown });
  if (!r.ok) {
    if (r.reason === 'index_out_of_range') {
      const shown = r.via === 'hash' ? `#${r.index}` : String(r.index);
      return { ok: false, detail: `submission index ${shown} out of range (${r.legalCount} legal moves)` };
    }
    if (r.reason === 'parse_error') {
      return { ok: false, detail: `submission notation '${r.notation}' did not parse: ${r.parseMessage}` };
    }
    return { ok: false, detail: 'submission.move is neither a notation string nor { index }' };
  }
  // The signature covers the submission; a separately logged resolved move must
  // agree. This check has no room analogue, so it stays at this call site.
  if (payload.move !== undefined && !jsonEq(payload.move, r.move)) {
    return { ok: false, detail: 'payload.move disagrees with the move resolved from the signed submission' };
  }
  return { ok: true, move: r.move };
}

export function verifyReplay(replay: ReplayFile, games: Record<string, AnyGame>): VerifyReport {
  const checks: Check[] = [];
  const run = (name: string, fn: () => string | null): void => {
    try {
      const detail = fn();
      checks.push(detail === null ? { name, ok: true } : { name, ok: false, detail });
    } catch (err) {
      checks.push({ name, ok: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  run('structure', () => {
    if (replay === null || typeof replay !== 'object') return 'replay is not an object';
    if (replay.version !== 'ludus.replay.v1') return `unknown replay version ${JSON.stringify(replay.version)}`;
    if (typeof replay.game_id !== 'string' || replay.game_id.length === 0) return 'missing game_id';
    if (!Array.isArray(replay.log) || replay.log.length < 4) {
      return 'log must contain at least commitment, start, end, and reveal entries';
    }
    for (let i = 0; i < replay.log.length; i++) {
      const e = replay.log[i]!;
      if (e.seq !== i) return `entry at index ${i} has seq ${e.seq} (seq must equal the array index)`;
      if (typeof e.kind !== 'string') return `entry ${i} has no kind`;
    }
    for (const k of ['commitment', 'start', 'end', 'reveal']) {
      const n = replay.log.filter((e) => e.kind === k).length;
      if (n !== 1) return `expected exactly one '${k}' entry, found ${n}`;
    }
    const idx = (k: string): number => replay.log.findIndex((e) => e.kind === k);
    const firstState = replay.log.findIndex((e) => STATE_KINDS.has(e.kind));
    if (idx('commitment') >= idx('start')) return `'commitment' must precede 'start'`;
    if (firstState !== -1 && firstState < idx('start')) return `state-changing entry before 'start'`;
    if (idx('end') !== replay.log.length - 2) return `'end' must be the second-to-last entry`;
    if (idx('reveal') !== replay.log.length - 1) return `'reveal' must be the final entry`;
    if (!Array.isArray(replay.seats) || replay.seats.length === 0) return 'replay has no seats';
    for (let i = 0; i < replay.seats.length; i++) {
      if (replay.seats[i]!.player !== playerId(i)) {
        return `seat ${i} has player '${replay.seats[i]!.player}' (must be '${playerId(i)}')`;
      }
    }
    return null;
  });

  run('commitment', () => {
    const derived = sha256Hex(`${COMMIT_PREFIX}:${replay.game_id}:${replay.reveal_secret}`);
    if (derived !== replay.commitment) {
      return `sha256('${COMMIT_PREFIX}:…:reveal_secret') = ${derived.slice(0, 16)}… does not match commitment ${String(replay.commitment).slice(0, 16)}…`;
    }
    const entry = replay.log.find((e) => e.kind === 'commitment');
    const p = entry ? asObj(entry.payload) : null;
    if (!p) return `missing or malformed 'commitment' log entry`;
    if (p.commitment !== replay.commitment) return 'commitment log entry does not match replay.commitment';
    if (p.drand_round !== replay.drand_round) {
      return `commitment entry drand_round ${String(p.drand_round)} != replay.drand_round ${replay.drand_round}`;
    }
    return null;
  });

  run('final_seed', () => {
    const derived = sha256Hex(
      `${SEED_PREFIX}:${replay.game_id}:${replay.reveal_secret}:${replay.drand_randomness}`,
    );
    if (derived !== replay.final_seed) {
      return `sha256('${SEED_PREFIX}:…') = ${derived.slice(0, 16)}… does not match final_seed ${String(replay.final_seed).slice(0, 16)}…`;
    }
    return null;
  });

  run('hash_chain', () => {
    let prev = GENESIS_PREV;
    for (const e of replay.log) {
      if (e.prev_hash !== prev) return `entry ${e.seq} (${e.kind}): prev_hash does not link to the previous entry`;
      const expected = sha256Hex(
        `${LOG_HASH_PREFIX}:${replay.game_id}:${e.seq}:${prev}:${canonicalJson({ kind: e.kind, payload: e.payload })}`,
      );
      if (e.hash !== expected) return `entry ${e.seq} (${e.kind}): hash does not recompute`;
      prev = e.hash;
    }
    return null;
  });

  run('signatures', () => {
    for (const e of replay.log) {
      if (!SIGNED_KINDS.has(e.kind)) {
        if (e.signature !== null) return `entry ${e.seq} (${e.kind}): non-agent entry must have signature null`;
        continue;
      }
      if (typeof e.signature !== 'string' || e.signature.length === 0) {
        return `entry ${e.seq} (${e.kind}): missing signature`;
      }
      const p = asObj(e.payload);
      if (!p) return `entry ${e.seq} (${e.kind}): payload is not an object`;
      if (typeof p.player !== 'string') return `entry ${e.seq} (${e.kind}): payload.player missing`;
      if (typeof p.turn_index !== 'number') return `entry ${e.seq} (${e.kind}): payload.turn_index missing`;
      const seat = replay.seats.find((s) => s.player === p.player);
      if (!seat) return `entry ${e.seq} (${e.kind}): player '${String(p.player)}' has no seat`;
      const body: Json = p.submission !== undefined ? p.submission : e.payload;
      const message = `${MOVE_SIGN_PREFIX}:${replay.game_id}:${p.turn_index}:${sha256Hex(canonicalJson(body))}`;
      if (!verifyEd25519(seat.pubkey_ed25519, message, e.signature)) {
        return `entry ${e.seq} (${e.kind}): Ed25519 signature does not verify for ${String(p.player)}`;
      }
    }
    return null;
  });

  const game: AnyGame | undefined = games[replay.game];
  run('game_module', () =>
    game ? null : `no game module registered for '${String(replay.game)}'`,
  );

  let finalState: Json | null = null;
  let recomputedDraws: readonly SeedDraw[] = [];

  run('recomputation', () => {
    if (!game) return 'skipped: game module missing';
    const seed = createSeedStream(replay.final_seed);
    const players = replay.seats.map((s) => s.player);
    let state = game.initialState(seed, players, replay.variant);
    if (!jsonEq(state, replay.initial_state)) {
      return 'recomputed initial state differs from replay.initial_state';
    }
    const startP = asObj(replay.log.find((e) => e.kind === 'start')?.payload);
    if (!startP) return `missing or malformed 'start' payload`;
    if (startP.initial_state_hash !== hashState(state)) {
      return 'start.initial_state_hash does not match the recomputed initial state';
    }
    if (startP.game !== replay.game) return `start.game '${String(startP.game)}' != replay.game '${replay.game}'`;
    if (startP.variant !== undefined && !jsonEq(startP.variant, replay.variant)) {
      return 'start.variant != replay.variant';
    }
    if (startP.ruleset_version !== replay.ruleset_version) {
      return `start.ruleset_version '${String(startP.ruleset_version)}' != replay.ruleset_version '${replay.ruleset_version}'`;
    }

    for (const e of replay.log) {
      // The forfeit branch comes FIRST, before the generic player/turn_index
      // extraction below, because a TERMINAL forfeit (every game without
      // game.forfeitPlayer) logs only { player, reason } — no turn_index — and
      // must keep verifying byte-identically. It is distinguished from a
      // non-terminal ELIMINATION purely by the presence of `state_hash`.
      //
      // Fail-closed: stripping `state_hash` to skip the recomputation is not an
      // exploit. The hash chain covers the whole payload, so the hash_chain
      // check catches the edit first, and even if it did not, the next entry's
      // state_hash (or end.final_state_hash) would no longer match.
      if (e.kind === 'forfeit') {
        const fp = asObj(e.payload);
        if (!fp) return `entry ${e.seq} (forfeit): payload is not an object`;
        if (fp.state_hash === undefined) continue; // terminal forfeit: state unchanged
        const fplayer = typeof fp.player === 'string' ? fp.player : null;
        if (fplayer === null) return `entry ${e.seq} (forfeit): payload.player missing`;
        if (!game.forfeitPlayer) {
          return `entry ${e.seq}: forfeit carries state_hash but the game module has no forfeitPlayer`;
        }
        const beforeF = seed.draws().length;
        // forfeitPlayer is pure and takes no SeedStream, so this recomputation
        // is exact and its draw delta is always empty.
        const out = game.forfeitPlayer(state, fplayer);
        if (out === null) return `entry ${e.seq}: forfeitPlayer returned null for a logged elimination`;
        state = out.state;
        if (fp.state_hash !== hashState(state)) {
          return `entry ${e.seq}: state_hash does not match the recomputed state`;
        }
        if (!jsonEq(seed.draws().slice(beforeF) as unknown as Json, (fp.draws ?? []) as Json)) {
          return `entry ${e.seq}: logged draws differ from the recomputed seed draws`;
        }
        if (!jsonEq((fp.events ?? []) as Json, out.events as unknown as Json)) {
          return `entry ${e.seq}: logged events differ from the recomputed forfeitPlayer() events`;
        }
        continue;
      }
      if (!STATE_KINDS.has(e.kind)) continue;
      const p = asObj(e.payload);
      if (!p) return `entry ${e.seq} (${e.kind}): payload is not an object`;
      const player = typeof p.player === 'string' ? p.player : null;
      if (player === null) return `entry ${e.seq} (${e.kind}): payload.player missing`;
      const turn = typeof p.turn_index === 'number' ? p.turn_index : null;
      if (turn === null) return `entry ${e.seq} (${e.kind}): payload.turn_index missing`;

      const before = seed.draws().length;
      let move: Json;
      if (e.kind === 'move') {
        const sub = asObj(p.submission);
        if (!sub) return `entry ${e.seq}: payload.submission missing`;
        if (sub.game_id !== replay.game_id) return `entry ${e.seq}: submission.game_id != replay.game_id`;
        if (sub.turn_index !== turn) return `entry ${e.seq}: submission.turn_index != payload.turn_index`;
        if (p.forced !== undefined && p.forced !== 'illegal') {
          return `entry ${e.seq}: unknown forced marker ${JSON.stringify(p.forced)}`;
        }
        if (p.forced === 'illegal') {
          // Frozen policy (rooms/core.ts): third illegal attempt of the turn.
          // The submission is the rejected-but-signed third attempt; the
          // applied move is the seeded random legal move, purpose
          // 'illegal:turn:N', drawn from the same stream position.
          const legal = game.legalMoves(state, player);
          if (legal.length === 0) return `entry ${e.seq}: forced move for ${player} but no legal moves exist`;
          move = legal[seed.int(`illegal:turn:${turn}`, legal.length)]!;
        } else {
          const r = resolveMove(game, state, player, p, sub);
          if (!r.ok) return `entry ${e.seq}: ${r.detail}`;
          move = r.move;
        }
      } else {
        const purpose = `timeout:turn:${turn}`;
        if (p.purpose !== undefined && p.purpose !== purpose) {
          return `entry ${e.seq}: timeout purpose ${JSON.stringify(p.purpose)} != frozen '${purpose}'`;
        }
        const legal = game.legalMoves(state, player);
        if (legal.length === 0) return `entry ${e.seq}: timeout for ${player} but no legal moves exist`;
        if (game.defaultMove) {
          move = game.defaultMove(state, player, legal);
        } else {
          move = legal[seed.int(purpose, legal.length)]!;
        }
      }

      const notation = game.moveToNotation(move, state);
      const applied = game.apply(state, player, move, seed);
      if (isRuleError(applied)) {
        return `entry ${e.seq}: apply rejected the logged move '${notation}' (${applied.code}: ${applied.message})`;
      }
      // Structured events are part of the record (a werewolf pack whisper is
      // ONLY in the log), so recompute them too. `?? []` and not an
      // `e.payload.events !== undefined` guard: rooms write the field only when
      // apply() emitted something, so an undefined-guard would let DELETION —
      // the exact tamper this check exists to catch — pass vacuously.
      if (!jsonEq((p.events ?? []) as Json, applied.events as unknown as Json)) {
        return `entry ${e.seq}: logged events differ from the recomputed apply() events`;
      }
      state = applied.state;
      const loggedNotation = e.kind === 'move' ? p.notation : p.applied_notation;
      if (loggedNotation !== notation) {
        return `entry ${e.seq}: logged notation '${String(loggedNotation)}' != recomputed '${notation}'`;
      }
      if (p.state_hash !== hashState(state)) {
        return `entry ${e.seq}: state_hash does not match the recomputed state`;
      }
      const slice = seed.draws().slice(before);
      if (!jsonEq(slice as unknown as Json, (p.draws ?? []) as Json)) {
        return `entry ${e.seq}: logged draws differ from the recomputed seed draws`;
      }
    }
    finalState = state;
    recomputedDraws = seed.draws();
    return null;
  });

  run('result', () => {
    if (!game) return 'skipped: game module missing';
    if (finalState === null) return 'skipped: recomputation failed';
    const endP = asObj(replay.log.find((e) => e.kind === 'end')?.payload);
    if (!endP) return `missing or malformed 'end' payload`;
    if (endP.final_state_hash !== hashState(finalState)) {
      return 'end.final_state_hash does not match the recomputed final state';
    }
    const resultJson = replay.result as unknown as Json;
    if (endP.result === undefined || !jsonEq(endP.result, resultJson)) {
      return 'end.result != replay.result';
    }
    const term = game.isTerminal(finalState);
    if (term) {
      if (!jsonEq(term as unknown as Json, resultJson)) {
        return 'game.isTerminal on the recomputed final state disagrees with the logged result';
      }
      return null;
    }
    const causes = replay.log.filter((e) => CAUSE_KINDS.has(e.kind));
    const last = causes[causes.length - 1];
    if (!last) {
      return 'final state is not terminal and no resign/forfeit/adjudication/draw_accept explains the result';
    }
    const p = asObj(last.payload) ?? {};
    const winners = replay.result.winners;
    switch (last.kind) {
      case 'resign':
        if (replay.result.draw) return 'a resignation cannot end in a draw';
        if (typeof p.player === 'string' && winners.includes(p.player)) {
          return `resigning player ${p.player} is listed as a winner`;
        }
        return null;
      case 'forfeit':
        // Only reachable on the TERMINAL forfeit path — a non-terminal
        // elimination leaves a state that isTerminal() explains, so `term` is
        // truthy above and this branch is never consulted. That matters: a
        // game that eliminates a seat may legitimately award it the win with
        // its team, which the check below would reject.
        if (typeof p.player === 'string' && winners.includes(p.player)) {
          return `forfeiting player ${p.player} is listed as a winner`;
        }
        return null;
      case 'draw_accept':
        if (!replay.result.draw) return `'draw_accept' must end in a draw`;
        return null;
      case 'adjudication':
        return null; // result is whatever the public docket entry says
      default:
        return `unexpected cause kind '${last.kind}'`;
    }
  });

  run('seed_draws', () => {
    if (finalState === null) return 'skipped: recomputation failed';
    if (!jsonEq(recomputedDraws as unknown as Json, replay.seed_draws as unknown as Json)) {
      return `replay.seed_draws does not match the recomputed draw log (${recomputedDraws.length} recomputed vs ${replay.seed_draws.length} logged)`;
    }
    return null;
  });

  run('reveal_after_end', () => {
    const revealIdx = replay.log.findIndex((e) => e.kind === 'reveal');
    const endIdx = replay.log.findIndex((e) => e.kind === 'end');
    if (revealIdx === -1) return `missing 'reveal' entry`;
    if (endIdx === -1) return `missing 'end' entry`;
    if (revealIdx < endIdx) return `'reveal' appears before 'end'`;
    if (revealIdx !== replay.log.length - 1) return `'reveal' must be the final entry`;
    const p = asObj(replay.log[revealIdx]!.payload);
    if (!p) return 'reveal payload is not an object';
    if (p.reveal_secret !== replay.reveal_secret) return 'reveal.reveal_secret != replay.reveal_secret';
    if (p.final_seed !== replay.final_seed) return 'reveal.final_seed != replay.final_seed';
    if (p.drand_randomness !== replay.drand_randomness) return 'reveal.drand_randomness != replay.drand_randomness';
    return null;
  });

  return { ok: checks.every((c) => c.ok), checks };
}
