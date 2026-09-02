/**
 * RoomCore — the pure, Durable-Object-free game-session state machine.
 *
 * All rules of a live session live here: signature checks, turn order, the
 * frozen illegal-move policy (reject → reject-with-list → forced random +
 * strike), timeouts and default moves, three-strikes forfeits, resignation,
 * draw offer/accept pairs, simultaneous-phase collection under one shared
 * deadline, hash-chained logging via src/crypto/chain.ts, spectator events
 * (public data only, gate A10), and replay-file assembly per
 * src/kernel/replay.ts.
 *
 * Methods take `nowMs` explicitly and perform no I/O — the GameRoom Durable
 * Object (src/rooms/room.ts) is a thin shell around this class. State is a
 * plain-JSON snapshot (`snapshot()` / `hydrate()`); the seed stream is
 * rebuilt on hydration by replaying its recorded draws.
 *
 * Log payload notes for the verifier tracks (T1/T9):
 *  - 'move' payload may carry `forced: 'illegal'` when the third illegal
 *    attempt of a turn caused a seeded random legal move (purpose
 *    `illegal:turn:N`); `submission` is then the rejected third submission
 *    and `notation` is the move actually applied.
 *  - 'resign' / 'draw_offer' / 'draw_accept' payloads carry the full signed
 *    `submission` in addition to { turn_index, player } so the Ed25519
 *    signature (over the frozen move message) is verifiable offline.
 *  - Every strike is its own 'strike' entry appended right after the entry
 *    that caused it ('timeout' or forced 'move').
 */

import { bytesToHex } from '@noble/hashes/utils';
import { hashJson } from '../crypto/canonical.ts';
import { appendEntry } from '../crypto/chain.ts';
import { deriveFinalSeed, makeCommitment } from '../crypto/commit.ts';
import { roundTimeMs } from '../crypto/drand.ts';
import { verifyEd25519 } from '../crypto/ed25519.ts';
import { hashState } from '../kernel/hash.ts';
import {
  MOVE_SIGN_PREFIX,
  type LogEntry,
  type ReplayFile,
  type ReplaySeat,
} from '../kernel/replay.ts';
import { createSeedStream } from '../kernel/seed.ts';
import { buildView, legalMoveEntries } from '../kernel/view.ts';
import {
  isParseError,
  isRuleError,
  type AnyGame,
  type GameResult,
  type HistoryEntry,
  type Json,
  type LegalMoveEntry,
  type MoveSubmission,
  type PlayerId,
  type SeedDraw,
  type SeedStream,
  type VariantConfig,
  type ViewObject,
} from '../kernel/types.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The frozen message an agent signs for a move submission (see replay.ts). */
export function moveSignMessage(gameId: string, turnIndex: number, submission: MoveSubmission): string {
  return `${MOVE_SIGN_PREFIX}:${gameId}:${turnIndex}:${hashJson(submission as unknown as Json)}`;
}

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

const MAX_COMMENTARY = 280;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoomSeat {
  player: PlayerId;
  agent_id: string;
  handle: string;
  pubkey_ed25519: string;
}

export interface RoomClocks {
  perMoveMs: number;
  /**
   * Cumulative side budget, ms (spec games.*.clock, e.g. chess "40 min per
   * side cumulative"); null = uncapped. Scaled by clock_scale like perMoveMs.
   */
  perSideMs: number | null;
  /** Test override multiplier (1 in production); see PLAN.md frozen policy. */
  clock_scale: number;
  /** Total thinking time consumed per seat, ms. */
  cumulativeMs: Record<PlayerId, number>;
}

/**
 * Per-game cumulative side budgets frozen by the spec's games.*.clock lines
 * (chess: "60 s per move, 40 min per side cumulative"). Games with no spec'd
 * side budget are uncapped unless the creator passes perSideMs explicitly.
 */
const DEFAULT_PER_SIDE_MS: Record<string, number> = {
  chess: 40 * 60_000,
};

export interface CreateRoomParams {
  /** Unique id of this game session (room id, log id, replay id). */
  gameId: string;
  game: AnyGame;
  variant: VariantConfig;
  seats: RoomSeat[];
  division: 'pure' | 'open';
  rulesetVersion: string;
  /** 32-byte hex; commit-reveal secret. Kept private until the reveal entry. */
  secretHex: string;
  drandRound: number;
  drandRandomnessHex: string;
  perMoveMs?: number;
  /**
   * Cumulative per-side clock budget, ms; null disables the cap. Omitted =
   * the game's spec default (DEFAULT_PER_SIDE_MS; chess 40 min, else null).
   */
  perSideMs?: number | null;
  clockScale?: number;
  rulesCard?: string;
}

export interface SpectatorEvent {
  seq: number;
  type: string;
  data: Json;
  at: string;
}

interface HeldSubmission {
  submission: MoveSubmission | null;
  signature: string | null;
  /** Resolved move (Json) for a valid submission; null when forced. */
  move: Json | null;
  forced: 'illegal' | 'timeout' | null;
  receivedAtMs: number;
}

export interface RejectionRecord {
  at: string;
  agent_id: string;
  code: string;
  message: string;
  turn_index: number;
}

export interface RoomSnapshot {
  game: string;
  game_id: string;
  variant: VariantConfig;
  seats: RoomSeat[];
  division: 'pure' | 'open';
  ruleset_version: string;
  secret: string;
  commitment: string;
  drand_round: number;
  drand_randomness: string;
  final_seed: string;
  log: LogEntry[];
  state: Json;
  initial_state: Json;
  turnIndex: number;
  strikes: Record<PlayerId, number>;
  illegalThisTurn: Record<PlayerId, number>;
  pendingDrawOffer: { by: PlayerId; validAtTurn: number } | null;
  pendingSimultaneous: Record<PlayerId, HeldSubmission>;
  clocks: RoomClocks;
  deadlineAtMs: number | null;
  turnStartedAtMs: number;
  status: 'running' | 'ended';
  result: GameResult | null;
  history: HistoryEntry[];
  events: SpectatorEvent[];
  privateViews: Record<PlayerId, Json>;
  seedDraws: SeedDraw[];
  rulesCard: string;
  replay: ReplayFile | null;
  rejections: RejectionRecord[];
}

export interface SubmitOk {
  ok: true;
  /** false = held for a simultaneous phase, applied when everyone is in. */
  applied: boolean;
  forced?: 'illegal';
  /** Canonical notation of the move actually applied (when applied). */
  notation?: string;
  waiting_for?: PlayerId[];
  ended: boolean;
  deadline_at_ms: number | null;
  /** Spectator events emitted by this call (public data only). */
  events: SpectatorEvent[];
}

export interface SubmitReject {
  ok: false;
  code: string;
  message: string;
  /** 1 or 2 while inside the illegal-move policy for this turn. */
  illegal_attempt?: number;
  /** Full restated legal list on the second illegal attempt of a turn. */
  legal_moves?: LegalMoveEntry[];
}

export type SubmitResult = SubmitOk | SubmitReject;

export interface TimeoutResult {
  fired: boolean;
  ended: boolean;
  deadline_at_ms: number | null;
  events: SpectatorEvent[];
}

// ---------------------------------------------------------------------------
// RoomCore
// ---------------------------------------------------------------------------

export class RoomCore {
  readonly game: AnyGame;
  private snap: RoomSnapshot;
  private seed: SeedStream;

  private constructor(game: AnyGame, snap: RoomSnapshot, seed: SeedStream) {
    this.game = game;
    this.snap = snap;
    this.seed = seed;
  }

  // ------------------------------------------------------------- creation --

  static create(nowMs: number, params: CreateRoomParams): RoomCore {
    const { game, gameId } = params;
    const nSeats = params.seats.length;
    if (nSeats < game.meta.players.min || nSeats > game.meta.players.max) {
      throw new Error(`createRoom: ${game.meta.id} takes ${game.meta.players.min}..${game.meta.players.max} players, got ${nSeats}`);
    }
    for (let i = 0; i < nSeats; i++) {
      const seat = params.seats[i]!;
      if (seat.player !== `p${i}`) throw new Error(`createRoom: seat ${i} must be player p${i}, got ${seat.player}`);
    }

    // Spec §identity_and_integrity.randomness[1]: the mixed drand quicknet
    // round must be at or after the commitment time. A round whose randomness
    // was already public when the commitment is made would let the house
    // grind the secret against known randomness for a favorable final_seed —
    // and created_at is not offline-verifiable, so create time is the only
    // place this ordering can be enforced.
    if (roundTimeMs(params.drandRound) < nowMs) {
      throw new Error(
        `createRoom: drand round ${params.drandRound} was emitted at ${roundTimeMs(params.drandRound)}ms, ` +
          `before the commitment time ${nowMs}ms — the mixed round must be at or after the commitment`,
      );
    }

    const commitment = makeCommitment(gameId, params.secretHex);
    const finalSeed = deriveFinalSeed(gameId, params.secretHex, params.drandRandomnessHex);
    const seed = createSeedStream(finalSeed);
    const players = params.seats.map((s) => s.player);
    const state = game.initialState(seed, players, params.variant);
    const initialStateHash = hashState(state);

    const perMoveMs = params.perMoveMs ?? 60_000;
    const clockScale = params.clockScale ?? 1;
    const perSideMs =
      params.perSideMs !== undefined ? params.perSideMs : DEFAULT_PER_SIDE_MS[game.meta.id] ?? null;
    const clocks: RoomClocks = {
      perMoveMs,
      perSideMs,
      clock_scale: clockScale,
      cumulativeMs: Object.fromEntries(players.map((p) => [p, 0])),
    };

    const snap: RoomSnapshot = {
      game: game.meta.id,
      game_id: gameId,
      variant: params.variant,
      seats: params.seats,
      division: params.division,
      ruleset_version: params.rulesetVersion,
      secret: params.secretHex,
      commitment,
      drand_round: params.drandRound,
      drand_randomness: params.drandRandomnessHex,
      final_seed: finalSeed,
      log: [],
      state,
      initial_state: state,
      turnIndex: 0,
      strikes: Object.fromEntries(players.map((p) => [p, 0])),
      illegalThisTurn: {},
      pendingDrawOffer: null,
      pendingSimultaneous: {},
      clocks,
      deadlineAtMs: null,
      turnStartedAtMs: nowMs,
      status: 'running',
      result: null,
      history: [],
      events: [],
      privateViews: {},
      seedDraws: [],
      rulesCard:
        params.rulesCard ??
        `${game.meta.name}. Notation: ${game.meta.notation}. Board: ${game.meta.boardText}. Answer with a legal move by notation or { "index": n } into legal_moves.`,
      replay: null,
      rejections: [],
    };

    const core = new RoomCore(game, snap, seed);

    // The commitment is logged before the first move (gate A8), then 'start'.
    core.appendLog(nowMs, 'commitment', { commitment, drand_round: params.drandRound }, null);
    core.appendLog(nowMs, 'start', {
      game: game.meta.id,
      variant: params.variant as Json,
      division: params.division,
      players: params.seats.map((s) => ({
        player: s.player,
        agent_id: s.agent_id,
        handle: s.handle,
        pubkey_ed25519: s.pubkey_ed25519,
      })),
      ruleset_version: params.rulesetVersion,
      initial_state_hash: initialStateHash,
    }, null);

    core.refreshPrivateViews();
    core.emit(nowMs, 'start', {
      game: game.meta.id,
      variant: params.variant as Json,
      players: params.seats.map((s) => ({ player: s.player, agent_id: s.agent_id, handle: s.handle })),
      public: game.publicView(state),
      board_text: game.renderText(state, null),
      commitment,
      drand_round: params.drandRound,
      turn_index: 0,
      players_to_move: game.playersToMove(state),
    });
    core.startTurnClock(nowMs);
    return core;
  }

  static hydrate(game: AnyGame, snapshot: RoomSnapshot): RoomCore {
    if (game.meta.id !== snapshot.game) {
      throw new Error(`hydrate: snapshot is for game '${snapshot.game}', got '${game.meta.id}'`);
    }
    // Re-derive the commit-reveal binding before trusting the snapshot: a
    // room resumed on a mismatched secret/commitment/final_seed would finish
    // the game and publish a replay that can never verify (gate A8). Any
    // storage-level tampering or corruption must hard-fail here instead.
    const commitment = makeCommitment(snapshot.game_id, snapshot.secret);
    if (commitment !== snapshot.commitment) {
      throw new Error('hydrate: snapshot commitment does not re-derive from (game_id, secret)');
    }
    const finalSeed = deriveFinalSeed(snapshot.game_id, snapshot.secret, snapshot.drand_randomness);
    if (finalSeed !== snapshot.final_seed) {
      throw new Error('hydrate: snapshot final_seed does not re-derive from (game_id, secret, drand_randomness)');
    }
    // Snapshots persisted before the cumulative side clock existed lack
    // clocks.perSideMs — resume them under the game's spec default.
    if ((snapshot.clocks as Partial<RoomClocks>).perSideMs === undefined) {
      snapshot.clocks.perSideMs = DEFAULT_PER_SIDE_MS[game.meta.id] ?? null;
    }
    const seed = createSeedStream(snapshot.final_seed);
    // Fast-forward the stream by replaying every recorded draw; any mismatch
    // means the snapshot was tampered with or the algorithm drifted.
    for (const d of snapshot.seedDraws) {
      if (d.kind === 'int') {
        const r = seed.int(d.purpose, d.arg);
        if (r !== d.result) throw new Error(`hydrate: seed draw mismatch at ${d.purpose}#${d.counter}`);
      } else {
        const r = bytesToHex(seed.bytes(d.purpose, d.arg));
        if (r !== d.result) throw new Error(`hydrate: seed draw mismatch at ${d.purpose}#${d.counter}`);
      }
    }
    return new RoomCore(game, snapshot, seed);
  }

  /** Plain-JSON snapshot for persistence. Do not mutate the returned object. */
  snapshot(): RoomSnapshot {
    this.snap.seedDraws = this.seed.draws().slice();
    return this.snap;
  }

  // -------------------------------------------------------------- getters --

  get gameId(): string {
    return this.snap.game_id;
  }
  get status(): 'running' | 'ended' {
    return this.snap.status;
  }
  get turnIndex(): number {
    return this.snap.turnIndex;
  }
  get deadlineAtMs(): number | null {
    return this.snap.deadlineAtMs;
  }
  get result(): GameResult | null {
    return this.snap.result;
  }
  get seats(): readonly RoomSeat[] {
    return this.snap.seats;
  }
  get log(): readonly LogEntry[] {
    return this.snap.log;
  }
  get strikes(): Readonly<Record<PlayerId, number>> {
    return this.snap.strikes;
  }
  get clocks(): RoomClocks {
    return this.snap.clocks;
  }

  playersToMoveNow(): PlayerId[] {
    return this.snap.status === 'running' ? this.game.playersToMove(this.snap.state) : [];
  }

  /** Movers who have not yet submitted in the current (simultaneous) phase. */
  waitingFor(): PlayerId[] {
    return this.playersToMoveNow().filter((p) => this.snap.pendingSimultaneous[p] === undefined);
  }

  replayFile(): ReplayFile | null {
    return this.snap.replay;
  }

  /** Spectator events with seq strictly greater than `after` (public only). */
  eventsSince(after: number): SpectatorEvent[] {
    return this.snap.events.filter((e) => e.seq > after);
  }

  seatByAgent(agentId: string): RoomSeat | undefined {
    return this.snap.seats.find((s) => s.agent_id === agentId);
  }

  seatByPlayer(player: PlayerId): RoomSeat | undefined {
    return this.snap.seats.find((s) => s.player === player);
  }

  // ----------------------------------------------------------------- view --

  viewFor(player: PlayerId, nowMs: number): ViewObject {
    const seat = this.seatByPlayer(player);
    if (!seat) throw new Error(`viewFor: no seat for ${player}`);
    return buildView(this.game, this.snap.state, player, {
      gameId: this.snap.game_id,
      turnIndex: this.snap.turnIndex,
      phase: this.phaseName(),
      deadlineUtc: this.snap.deadlineAtMs === null ? iso(nowMs) : iso(this.snap.deadlineAtMs),
      history: this.snap.history,
      rulesCard: this.snap.rulesCard,
    });
  }

  publicStateSummary(): Json {
    return {
      game_id: this.snap.game_id,
      game: this.snap.game,
      variant: this.snap.variant as Json,
      status: this.snap.status,
      turn_index: this.snap.turnIndex,
      phase: this.phaseName(),
      players_to_move: this.playersToMoveNow(),
      waiting_for: this.waitingFor(),
      deadline_at_ms: this.snap.deadlineAtMs,
      strikes: this.snap.strikes,
      cumulative_ms: this.snap.clocks.cumulativeMs,
      commitment: this.snap.commitment,
      drand_round: this.snap.drand_round,
      result: this.snap.result === null ? null : (this.snap.result as unknown as Json),
      log_length: this.snap.log.length,
      event_seq: this.snap.events.length,
      public: this.game.publicView(this.snap.state),
      board_text: this.game.renderText(this.snap.state, null),
    };
  }

  private phaseName(): string {
    if (this.snap.status === 'ended') return 'ended';
    const pub = this.game.publicView(this.snap.state);
    if (typeof pub === 'object' && pub !== null && !Array.isArray(pub)) {
      const p = (pub as Record<string, Json>)['phase'];
      if (typeof p === 'string') return p;
    }
    return this.playersToMoveNow().length > 1 ? 'simultaneous' : 'play';
  }

  // ------------------------------------------------------------- plumbing --

  private appendLog(nowMs: number, kind: LogEntry['kind'], payload: Json, signature: string | null): LogEntry {
    const entry = appendEntry(this.snap.game_id, this.snap.log, kind, payload, signature, iso(nowMs));
    this.snap.log.push(entry);
    return entry;
  }

  private emit(nowMs: number, type: string, data: Json): SpectatorEvent {
    const ev: SpectatorEvent = { seq: this.snap.events.length + 1, type, data, at: iso(nowMs) };
    this.snap.events.push(ev);
    return ev;
  }

  private refreshPrivateViews(): void {
    const views: Record<PlayerId, Json> = {};
    for (const s of this.snap.seats) views[s.player] = this.game.privateView(this.snap.state, s.player);
    this.snap.privateViews = views;
  }

  /** Reads status fresh (mutating helpers may have ended the game mid-call). */
  private isEnded(): boolean {
    return this.snap.status === 'ended';
  }

  private budgetMs(): number {
    return Math.max(1, Math.round(this.snap.clocks.perMoveMs * this.snap.clocks.clock_scale));
  }

  /** Scaled cumulative side budget (spec games.*.clock), or null when uncapped. */
  private sideBudgetMs(): number | null {
    const per = this.snap.clocks.perSideMs;
    return per === null ? null : Math.max(1, Math.round(per * this.snap.clocks.clock_scale));
  }

  /** True when the player's cumulative thinking time exhausted the side budget. */
  private flagFallen(player: PlayerId): boolean {
    const budget = this.sideBudgetMs();
    return budget !== null && (this.snap.clocks.cumulativeMs[player] ?? 0) >= budget;
  }

  private startTurnClock(nowMs: number): void {
    this.snap.turnStartedAtMs = nowMs;
    if (this.snap.status !== 'running') {
      this.snap.deadlineAtMs = null;
      return;
    }
    // The turn allowance is the per-move budget shrunk to whatever remains of
    // each mover's cumulative side budget (spec games.chess.clock: "60 s per
    // move, 40 min per side cumulative") — a mover can never think past their
    // flag inside a single move clock.
    let allowance = this.budgetMs();
    const side = this.sideBudgetMs();
    if (side !== null) {
      for (const p of this.game.playersToMove(this.snap.state)) {
        const remaining = side - (this.snap.clocks.cumulativeMs[p] ?? 0);
        allowance = Math.min(allowance, Math.max(1, remaining));
      }
    }
    this.snap.deadlineAtMs = nowMs + allowance;
  }

  private reject(nowMs: number, agentId: string, code: string, message: string, extra?: Partial<SubmitReject>): SubmitReject {
    const rec: RejectionRecord = { at: iso(nowMs), agent_id: agentId, code, message, turn_index: this.snap.turnIndex };
    this.snap.rejections.push(rec);
    if (this.snap.rejections.length > 100) this.snap.rejections.splice(0, this.snap.rejections.length - 100);
    return { ok: false, code, message, ...extra };
  }

  private drawsDelta(fromCount: number): Json {
    return this.seed.draws().slice(fromCount) as unknown as Json;
  }

  // ---------------------------------------------------------- submit path --

  submitMove(nowMs: number, agentId: string, submission: MoveSubmission, signatureHex: string): SubmitResult {
    const evStart = this.snap.events.length;

    if (this.snap.status !== 'running') {
      return this.reject(nowMs, agentId, 'room_ended', 'this game has ended');
    }
    const seat = this.seatByAgent(agentId);
    if (!seat) {
      return this.reject(nowMs, agentId, 'unknown_agent', `agent '${agentId}' has no seat in this game`);
    }
    const player = seat.player;

    if (submission.game_id !== this.snap.game_id) {
      return this.reject(nowMs, agentId, 'wrong_game', `submission is for game '${submission.game_id}', this is '${this.snap.game_id}'`);
    }
    if (!Number.isInteger(submission.turn_index)) {
      return this.reject(nowMs, agentId, 'bad_turn_index', 'turn_index must be an integer');
    }
    // Signature first: over the frozen move message with the seat's key.
    const message = moveSignMessage(this.snap.game_id, submission.turn_index, submission);
    if (!verifyEd25519(seat.pubkey_ed25519, message, signatureHex)) {
      return this.reject(nowMs, agentId, 'bad_signature', 'Ed25519 signature does not verify for this seat and body');
    }
    if (submission.turn_index !== this.snap.turnIndex) {
      return this.reject(
        nowMs, agentId, 'wrong_turn',
        `submission is for turn ${submission.turn_index}, the game is at turn ${this.snap.turnIndex}`,
      );
    }
    if (submission.commentary !== undefined) {
      if (typeof submission.commentary !== 'string' || submission.commentary.length > MAX_COMMENTARY) {
        return this.reject(nowMs, agentId, 'bad_commentary', `commentary must be a string of at most ${MAX_COMMENTARY} chars`);
      }
    }

    // Resignation is a signed log entry, allowed from any seated player.
    if (submission.resign === true) {
      this.appendLog(nowMs, 'resign', {
        turn_index: this.snap.turnIndex,
        player,
        submission: submission as unknown as Json,
      }, signatureHex);
      this.emit(nowMs, 'resign', { turn_index: this.snap.turnIndex, player, agent_id: agentId });
      const winners = this.snap.seats.map((s) => s.player).filter((p) => p !== player);
      this.endGame(nowMs, { winners, draw: false, reason: 'resignation' });
      return this.okResult(evStart, true);
    }

    // The view contract fixes deadline_utc as the "ISO time by which the move
    // must arrive". DO alarms are at-least-once and can lag, so a submission
    // landing at/after the deadline must never count as a clean move for the
    // expired turn — it is rejected and the turn resolves through timeout()
    // (GameRoom runs the timeout check before forwarding submissions).
    if (this.snap.deadlineAtMs !== null && nowMs >= this.snap.deadlineAtMs) {
      return this.reject(
        nowMs, agentId, 'deadline_passed',
        `the deadline for turn ${this.snap.turnIndex} passed at ${iso(this.snap.deadlineAtMs)}; the turn resolves by timeout`,
      );
    }

    const movers = this.playersToMoveNow();
    if (!movers.includes(player)) {
      return this.reject(nowMs, agentId, 'not_your_turn', `it is not ${player}'s turn`);
    }

    // Draw accept: a pending offer from another player, valid exactly for this turn.
    const offer = this.snap.pendingDrawOffer;
    if (submission.draw_offer === true && offer !== null && offer.by !== player && offer.validAtTurn === this.snap.turnIndex) {
      this.appendLog(nowMs, 'draw_accept', {
        turn_index: this.snap.turnIndex,
        player,
        submission: submission as unknown as Json,
      }, signatureHex);
      this.emit(nowMs, 'draw_accept', { turn_index: this.snap.turnIndex, player, agent_id: agentId });
      this.endGame(nowMs, { winners: [], draw: true, reason: 'agreement' });
      return this.okResult(evStart, true);
    }
    if (submission.draw_offer === true && movers.length > 1) {
      return this.reject(nowMs, agentId, 'draw_offer_unavailable', 'draw offers are not accepted during simultaneous phases');
    }

    if (movers.length > 1) {
      return this.submitSimultaneous(nowMs, seat, submission, signatureHex, evStart);
    }
    return this.submitSequential(nowMs, seat, submission, signatureHex, evStart);
  }

  /**
   * Resolves the submitted move against the current state. Returns either the
   * move or an illegal-move description (which feeds the three-step policy).
   */
  private resolveMove(
    submission: MoveSubmission,
    player: PlayerId,
  ): { move: Json } | { illegal: string } {
    const state = this.snap.state;
    const m = submission.move;
    if (typeof m === 'object' && m !== null) {
      if (!Number.isInteger(m.index) || m.index < 0) return { illegal: `move.index must be a non-negative integer` };
      const legal = this.game.legalMoves(state, player);
      const chosen = legal[m.index];
      if (chosen === undefined) return { illegal: `index ${m.index} is out of range: ${legal.length} legal moves` };
      return { move: chosen };
    }
    if (typeof m !== 'string') return { illegal: 'move must be a notation string or { index }' };
    // Kernel-level index fallback: '#7' means legal_moves[7].
    const hash = /^#(\d+)$/.exec(m.trim());
    if (hash) {
      const idx = Number(hash[1]);
      const legal = this.game.legalMoves(state, player);
      const chosen = legal[idx];
      if (chosen === undefined) return { illegal: `index ${idx} is out of range: ${legal.length} legal moves` };
      return { move: chosen };
    }
    const parsed = this.game.parseMove(m, state, player);
    if (isParseError(parsed)) return { illegal: `cannot parse '${m}': ${parsed.message}` };
    return { move: parsed };
  }

  /**
   * The frozen three-step illegal-move policy. Returns a rejection for the
   * first and second illegal attempt of a turn; on the third returns
   * { third: true } and the caller draws the seeded random legal move
   * (purpose `illegal:turn:N`) at the moment it is applied, so the draw log
   * stays in strict application order for the offline verifier.
   */
  private illegalAttempt(
    nowMs: number,
    seat: RoomSeat,
    reason: string,
  ): { rejection: SubmitReject } | { third: true } {
    const player = seat.player;
    const n = (this.snap.illegalThisTurn[player] ?? 0) + 1;
    this.snap.illegalThisTurn[player] = n;
    if (n === 1) {
      return {
        rejection: this.reject(nowMs, seat.agent_id, 'illegal_move', `illegal move (attempt 1 of this turn): ${reason}`, {
          illegal_attempt: 1,
        }),
      };
    }
    if (n === 2) {
      return {
        rejection: this.reject(
          nowMs, seat.agent_id, 'illegal_move',
          `illegal move (attempt 2 of this turn): ${reason}. The full legal list is restated below.`,
          { illegal_attempt: 2, legal_moves: legalMoveEntries(this.game, this.snap.state, player) },
        ),
      };
    }
    return { third: true };
  }

  /** Seeded random legal move for the frozen policy (purpose `illegal:turn:N`). */
  private drawForcedLegal(player: PlayerId, turn: number): Json {
    const legal = this.game.legalMoves(this.snap.state, player);
    if (legal.length === 0) throw new Error(`forced move: ${player} to move with no legal moves`);
    return legal[this.seed.int(`illegal:turn:${turn}`, legal.length)]!;
  }

  private submitSequential(
    nowMs: number,
    seat: RoomSeat,
    submission: MoveSubmission,
    signatureHex: string,
    evStart: number,
  ): SubmitResult {
    const player = seat.player;
    const resolved = this.resolveMove(submission, player);

    let move: Json;
    let forced = false;
    let drawStart = this.seed.draws().length;

    if ('illegal' in resolved) {
      const outcome = this.illegalAttempt(nowMs, seat, resolved.illegal);
      if ('rejection' in outcome) return outcome.rejection;
      // Third illegal attempt this turn: seeded random legal move + strike.
      // When that strike is the player's THIRD, the forfeit beats the forced
      // move (spec: "Three strikes in a game forfeit it") — nothing is drawn
      // or applied, matching the simultaneous path, so a striker can never be
      // crowned by their own forced game-ending move.
      if ((this.snap.strikes[player] ?? 0) >= 2) {
        this.recordStrike(nowMs, player, 'illegal_move', this.snap.turnIndex);
        this.forfeit(nowMs, player);
        return this.okResult(evStart, true);
      }
      drawStart = this.seed.draws().length;
      move = this.drawForcedLegal(player, this.snap.turnIndex);
      forced = true;
    } else {
      move = resolved.move;
    }

    const applied = this.game.apply(this.snap.state, player, move, this.seed);
    if (isRuleError(applied)) {
      if (forced) throw new Error(`room ${this.snap.game_id}: forced random legal move rejected: ${applied.message}`);
      const outcome = this.illegalAttempt(nowMs, seat, `${applied.code}: ${applied.message}`);
      if ('rejection' in outcome) return outcome.rejection;
      // Same third-strike rule as above: forfeit beats the forced move.
      if ((this.snap.strikes[player] ?? 0) >= 2) {
        this.recordStrike(nowMs, player, 'illegal_move', this.snap.turnIndex);
        this.forfeit(nowMs, player);
        return this.okResult(evStart, true);
      }
      drawStart = this.seed.draws().length;
      move = this.drawForcedLegal(player, this.snap.turnIndex);
      forced = true;
      const retried = this.game.apply(this.snap.state, player, move, this.seed);
      if (isRuleError(retried)) throw new Error(`room ${this.snap.game_id}: forced random legal move rejected: ${retried.message}`);
      this.commitApplied(nowMs, seat, submission, signatureHex, move, retried.state, drawStart, forced);
      return this.okResult(evStart, true, forced, this.snap.history[this.snap.history.length - 1]?.notation);
    }

    this.commitApplied(nowMs, seat, submission, signatureHex, move, applied.state, drawStart, forced);
    return this.okResult(evStart, true, forced, this.snap.history[this.snap.history.length - 1]?.notation);
  }

  /** Applies bookkeeping after a successful (or forced) sequential move. */
  private commitApplied(
    nowMs: number,
    seat: RoomSeat,
    submission: MoveSubmission | null,
    signatureHex: string | null,
    move: Json,
    newState: Json,
    drawStart: number,
    forced: boolean,
  ): void {
    const player = seat.player;
    const turn = this.snap.turnIndex;
    const notation = this.game.moveToNotation(move, this.snap.state);
    this.snap.state = newState;
    const stateHash = hashState(newState);

    // Clock accounting.
    this.snap.clocks.cumulativeMs[player] =
      (this.snap.clocks.cumulativeMs[player] ?? 0) + Math.max(0, nowMs - this.snap.turnStartedAtMs);

    const payload: Record<string, Json> = {
      turn_index: turn,
      player,
      agent_id: seat.agent_id,
      submission: submission as unknown as Json,
      notation,
      state_hash: stateHash,
      draws: this.drawsDelta(drawStart),
    };
    if (forced) payload['forced'] = 'illegal';
    this.appendLog(nowMs, 'move', payload, signatureHex);

    if (forced) {
      this.recordStrike(nowMs, player, 'illegal_move', turn);
    }

    // Draw offer registers only when the player's own (unforced) move applies.
    if (!forced && submission?.draw_offer === true) {
      this.appendLog(nowMs, 'draw_offer', {
        turn_index: turn,
        player,
        submission: submission as unknown as Json,
      }, signatureHex);
      this.snap.pendingDrawOffer = { by: player, validAtTurn: turn + 1 };
      this.emit(nowMs, 'draw_offer', { turn_index: turn, player });
    }

    const hist: HistoryEntry = { turnIndex: turn, player, notation };
    if (!forced && typeof submission?.commentary === 'string' && submission.commentary.length > 0) {
      hist.commentary = submission.commentary;
    }
    this.snap.history.push(hist);
    this.refreshPrivateViews();

    const evData: Record<string, Json> = {
      turn_index: turn,
      player,
      agent_id: seat.agent_id,
      notation,
      state_hash: stateHash,
      public: this.game.publicView(this.snap.state),
      board_text: this.game.renderText(this.snap.state, null),
    };
    if (hist.commentary !== undefined) evData['commentary'] = hist.commentary;
    if (forced) evData['forced'] = 'illegal';
    this.emit(nowMs, 'move', evData);

    // Three strikes forfeit BEFORE the terminal check runs (safety net; the
    // submit paths already forfeit third strikes without applying a move): a
    // striker must never be crowned by their own forced game-ending move.
    if (forced && (this.snap.strikes[player] ?? 0) >= 3) {
      this.forfeit(nowMs, player);
      return;
    }

    this.advanceTurn(nowMs, turn);
    if (this.snap.status !== 'running') return;

    // A pending offer expires once the acceptance turn has been consumed.
    const offer = this.snap.pendingDrawOffer;
    if (offer !== null && offer.validAtTurn <= turn) this.snap.pendingDrawOffer = null;
  }

  private advanceTurn(nowMs: number, justPlayedTurn: number): void {
    this.snap.turnIndex = justPlayedTurn + 1;
    this.snap.illegalThisTurn = {};
    const result = this.game.isTerminal(this.snap.state);
    if (result) {
      this.endGame(nowMs, result);
      return;
    }
    this.startTurnClock(nowMs);
  }

  private recordStrike(nowMs: number, player: PlayerId, reason: string, turn: number): void {
    const count = (this.snap.strikes[player] ?? 0) + 1;
    this.snap.strikes[player] = count;
    this.appendLog(nowMs, 'strike', { turn_index: turn, player, reason, strike_count: count }, null);
    this.emit(nowMs, 'strike', { turn_index: turn, player, reason, strike_count: count });
  }

  /** 'three_strikes' = the frozen strike policy; 'time' = cumulative side clock exhausted (flag fall). */
  private forfeit(nowMs: number, player: PlayerId, reason: 'three_strikes' | 'time' = 'three_strikes'): void {
    if (this.snap.status !== 'running') return;
    this.appendLog(nowMs, 'forfeit', { player, reason }, null);
    this.emit(nowMs, 'forfeit', { player, reason });
    const winners = this.snap.seats.map((s) => s.player).filter((p) => p !== player);
    this.endGame(nowMs, { winners, draw: false, reason: 'forfeit' });
  }

  // ------------------------------------------------- simultaneous phases --

  private submitSimultaneous(
    nowMs: number,
    seat: RoomSeat,
    submission: MoveSubmission,
    signatureHex: string,
    evStart: number,
  ): SubmitResult {
    const player = seat.player;
    if (this.snap.pendingSimultaneous[player] !== undefined) {
      return this.reject(nowMs, seat.agent_id, 'already_submitted', 'a turn accepts exactly one move; yours is already in for this phase');
    }

    const resolved = this.resolveMove(submission, player);
    let held: HeldSubmission;
    if ('illegal' in resolved) {
      const outcome = this.illegalAttempt(nowMs, seat, resolved.illegal);
      if ('rejection' in outcome) return outcome.rejection;
      // Third illegal in a simultaneous phase: strike now, hold a forced
      // marker; the seeded pick happens at resolution time in seat order so
      // the draw log stays in strict application order.
      this.recordStrike(nowMs, player, 'illegal_move', this.snap.turnIndex);
      held = { submission, signature: signatureHex, move: null, forced: 'illegal', receivedAtMs: nowMs };
      if ((this.snap.strikes[player] ?? 0) >= 3) {
        this.forfeit(nowMs, player);
        return this.okResult(evStart, true);
      }
    } else {
      held = { submission, signature: signatureHex, move: resolved.move, forced: null, receivedAtMs: nowMs };
    }

    this.snap.pendingSimultaneous[player] = held;
    this.snap.clocks.cumulativeMs[player] =
      (this.snap.clocks.cumulativeMs[player] ?? 0) + Math.max(0, nowMs - this.snap.turnStartedAtMs);

    const waiting = this.waitingFor();
    if (waiting.length > 0) {
      return {
        ok: true,
        applied: false,
        ended: false,
        deadline_at_ms: this.snap.deadlineAtMs,
        waiting_for: waiting,
        events: this.snap.events.slice(evStart),
      };
    }
    this.resolveSimultaneous(nowMs);
    return this.okResult(evStart, true);
  }

  /**
   * Applies all held submissions of the current simultaneous phase in seat
   * order. All movers signed the same turn_index; each applied move logs that
   * shared turn_index and the phase then advances the turn counter once.
   */
  private resolveSimultaneous(nowMs: number): void {
    const turn = this.snap.turnIndex;
    const held = this.snap.pendingSimultaneous;
    this.snap.pendingSimultaneous = {};

    for (const seat of this.snap.seats) {
      if (this.snap.status !== 'running') return; // terminal mid-resolution: rest no longer act
      const player = seat.player;
      const h = held[player];
      if (h === undefined) continue;
      if (!this.game.playersToMove(this.snap.state).includes(player)) continue;

      const drawStart = this.seed.draws().length;
      let move: Json;
      let entryKind: 'move' | 'timeout' = 'move';
      let strikeReason: string | null = null;

      if (h.forced === 'timeout') {
        // Third strike: the forfeit beats the forced default (spec: three
        // strikes forfeit) — no move is drawn or applied.
        if ((this.snap.strikes[player] ?? 0) >= 2) {
          this.recordStrike(nowMs, player, 'timeout', turn);
          this.forfeit(nowMs, player);
          return;
        }
        const legal = this.game.legalMoves(this.snap.state, player);
        if (legal.length === 0) throw new Error(`resolveSimultaneous: ${player} to move with no legal moves`);
        move = this.game.defaultMove
          ? this.game.defaultMove(this.snap.state, player, legal)
          : legal[this.seed.int(`timeout:turn:${turn}`, legal.length)]!;
        entryKind = 'timeout';
        strikeReason = 'timeout';
      } else if (h.forced === 'illegal') {
        move = this.drawForcedLegal(player, turn);
        // strike already recorded at submission time
      } else {
        move = h.move!;
      }

      let applied = this.game.apply(this.snap.state, player, move, this.seed);
      if (isRuleError(applied)) {
        if (h.forced !== null) throw new Error(`resolveSimultaneous: forced move rejected: ${applied.message}`);
        // The state shifted under a previously-legal held move: substitute a
        // seeded random legal move and record a strike — unless that strike
        // is the third, in which case the forfeit beats the substitution.
        if ((this.snap.strikes[player] ?? 0) >= 2) {
          this.recordStrike(nowMs, player, 'illegal_move', turn);
          this.forfeit(nowMs, player);
          return;
        }
        move = this.drawForcedLegal(player, turn);
        strikeReason = 'illegal_move';
        applied = this.game.apply(this.snap.state, player, move, this.seed);
        if (isRuleError(applied)) throw new Error(`resolveSimultaneous: substituted legal move rejected: ${applied.message}`);
      }

      const notation = this.game.moveToNotation(move, this.snap.state);
      this.snap.state = applied.state;
      const stateHash = hashState(this.snap.state);
      const draws = this.drawsDelta(drawStart);

      if (entryKind === 'timeout') {
        const count = (this.snap.strikes[player] ?? 0) + 1;
        this.appendLog(nowMs, 'timeout', {
          turn_index: turn,
          player,
          applied_notation: notation,
          state_hash: stateHash,
          draws,
          strike_count: count,
        }, null);
      } else {
        const payload: Record<string, Json> = {
          turn_index: turn,
          player,
          agent_id: seat.agent_id,
          submission: h.submission as unknown as Json,
          notation,
          state_hash: stateHash,
          draws,
        };
        if (h.forced === 'illegal' || strikeReason === 'illegal_move') payload['forced'] = 'illegal';
        this.appendLog(nowMs, 'move', payload, h.signature);
      }

      const hist: HistoryEntry = { turnIndex: turn, player, notation };
      if (h.forced === null && strikeReason === null && typeof h.submission?.commentary === 'string' && h.submission.commentary.length > 0) {
        hist.commentary = h.submission.commentary;
      }
      this.snap.history.push(hist);
      this.refreshPrivateViews();

      const evData: Record<string, Json> = {
        turn_index: turn,
        player,
        agent_id: seat.agent_id,
        notation,
        state_hash: stateHash,
        public: this.game.publicView(this.snap.state),
        board_text: this.game.renderText(this.snap.state, null),
      };
      if (hist.commentary !== undefined) evData['commentary'] = hist.commentary;
      if (h.forced !== null) evData['forced'] = h.forced;
      this.emit(nowMs, entryKind === 'timeout' ? 'timeout' : 'move', evData);

      if (strikeReason !== null) {
        this.recordStrike(nowMs, player, strikeReason, turn);
        if ((this.snap.strikes[player] ?? 0) >= 3) {
          this.forfeit(nowMs, player);
          return;
        }
      }
    }

    if (this.snap.status !== 'running') return;
    this.advanceTurn(nowMs, turn);
    if (this.snap.status !== 'running') return;
    const offer = this.snap.pendingDrawOffer;
    if (offer !== null && offer.validAtTurn <= turn) this.snap.pendingDrawOffer = null;
  }

  // -------------------------------------------------------------- timeout --

  /**
   * Fires when the shared deadline for the current turn/phase has passed.
   * Sequential: applies the game's defaultMove (else a seeded random legal
   * move, purpose `timeout:turn:N`) and records a strike. Simultaneous: every
   * mover who has not submitted is forced the same way, then the phase
   * resolves. Three strikes forfeit.
   */
  timeout(nowMs: number): TimeoutResult {
    const evStart = this.snap.events.length;
    if (this.snap.status !== 'running' || this.snap.deadlineAtMs === null || nowMs < this.snap.deadlineAtMs) {
      return { fired: false, ended: this.snap.status === 'ended', deadline_at_ms: this.snap.deadlineAtMs, events: [] };
    }

    const movers = this.playersToMoveNow();
    if (movers.length > 1) {
      for (const p of this.waitingFor()) {
        this.snap.pendingSimultaneous[p] = {
          submission: null,
          signature: null,
          move: null,
          forced: 'timeout',
          receivedAtMs: nowMs,
        };
        this.snap.clocks.cumulativeMs[p] = (this.snap.clocks.cumulativeMs[p] ?? 0) + this.budgetMs();
      }
      // A fallen flag (cumulative side clock exhausted) beats resolution: the
      // first absentee in seat order past their budget loses on time.
      for (const s of this.snap.seats) {
        if (this.snap.pendingSimultaneous[s.player]?.forced === 'timeout' && this.flagFallen(s.player)) {
          this.forfeit(nowMs, s.player, 'time');
          return {
            fired: true,
            ended: this.isEnded(),
            deadline_at_ms: this.snap.deadlineAtMs,
            events: this.snap.events.slice(evStart),
          };
        }
      }
      this.resolveSimultaneous(nowMs);
      return {
        fired: true,
        ended: this.isEnded(),
        deadline_at_ms: this.snap.deadlineAtMs,
        events: this.snap.events.slice(evStart),
      };
    }

    const player = movers[0];
    if (player === undefined) {
      // Defensive: a running game must have movers (kernel contract).
      throw new Error(`timeout: room ${this.snap.game_id} is running but no one is to move`);
    }
    const seat = this.seatByPlayer(player)!;
    const turn = this.snap.turnIndex;

    // A timeout charges the full per-move budget, never the alarm latency.
    this.snap.clocks.cumulativeMs[player] = (this.snap.clocks.cumulativeMs[player] ?? 0) + this.budgetMs();

    // Third strike: the forfeit beats the forced default move (spec: "Three
    // strikes in a game forfeit it") — nothing is applied, so the striker can
    // never win by their own forced game-ending move.
    if ((this.snap.strikes[player] ?? 0) >= 2) {
      this.recordStrike(nowMs, player, 'timeout', turn);
      this.forfeit(nowMs, player);
      return {
        fired: true,
        ended: this.isEnded(),
        deadline_at_ms: this.snap.deadlineAtMs,
        events: this.snap.events.slice(evStart),
      };
    }

    // Cumulative side clock exhausted (spec games.chess.clock): flag fall —
    // the stalling player loses on time.
    if (this.flagFallen(player)) {
      this.forfeit(nowMs, player, 'time');
      return {
        fired: true,
        ended: this.isEnded(),
        deadline_at_ms: this.snap.deadlineAtMs,
        events: this.snap.events.slice(evStart),
      };
    }

    const legal = this.game.legalMoves(this.snap.state, player);
    if (legal.length === 0) throw new Error(`timeout: ${player} to move with no legal moves`);

    const drawStart = this.seed.draws().length;
    const move = this.game.defaultMove
      ? this.game.defaultMove(this.snap.state, player, legal)
      : legal[this.seed.int(`timeout:turn:${turn}`, legal.length)]!;

    const applied = this.game.apply(this.snap.state, player, move, this.seed);
    if (isRuleError(applied)) throw new Error(`timeout: default/random legal move rejected: ${applied.message}`);

    const notation = this.game.moveToNotation(move, this.snap.state);
    this.snap.state = applied.state;
    const stateHash = hashState(this.snap.state);

    const count = (this.snap.strikes[player] ?? 0) + 1;
    this.appendLog(nowMs, 'timeout', {
      turn_index: turn,
      player,
      applied_notation: notation,
      state_hash: stateHash,
      draws: this.drawsDelta(drawStart),
      strike_count: count,
    }, null);

    this.snap.history.push({ turnIndex: turn, player, notation });
    this.refreshPrivateViews();
    this.emit(nowMs, 'timeout', {
      turn_index: turn,
      player,
      agent_id: seat.agent_id,
      notation,
      state_hash: stateHash,
      public: this.game.publicView(this.snap.state),
      board_text: this.game.renderText(this.snap.state, null),
    });
    this.recordStrike(nowMs, player, 'timeout', turn);

    if (this.snap.status === 'running') {
      this.advanceTurn(nowMs, turn);
    }
    if (this.snap.status === 'running') {
      const offer = this.snap.pendingDrawOffer;
      if (offer !== null && offer.validAtTurn <= turn) this.snap.pendingDrawOffer = null;
    }

    return {
      fired: true,
      ended: this.isEnded(),
      deadline_at_ms: this.snap.deadlineAtMs,
      events: this.snap.events.slice(evStart),
    };
  }

  // ------------------------------------------------------------------ end --

  private endGame(nowMs: number, result: GameResult): void {
    if (this.snap.status !== 'running') return;
    this.snap.status = 'ended';
    this.snap.result = result;
    this.snap.deadlineAtMs = null;
    this.snap.pendingDrawOffer = null;
    this.snap.pendingSimultaneous = {};

    const finalStateHash = hashState(this.snap.state);
    this.appendLog(nowMs, 'end', { result: result as unknown as Json, final_state_hash: finalStateHash }, null);
    this.appendLog(nowMs, 'reveal', {
      reveal_secret: this.snap.secret,
      final_seed: this.snap.final_seed,
      drand_randomness: this.snap.drand_randomness,
    }, null);

    const seats: ReplaySeat[] = this.snap.seats.map((s) => ({
      player: s.player,
      agent_id: s.agent_id,
      handle: s.handle,
      pubkey_ed25519: s.pubkey_ed25519,
    }));
    this.snap.replay = {
      version: 'ludus.replay.v1',
      game_id: this.snap.game_id,
      game: this.snap.game,
      variant: this.snap.variant,
      division: this.snap.division,
      ruleset_version: this.snap.ruleset_version,
      seats,
      commitment: this.snap.commitment,
      drand_round: this.snap.drand_round,
      drand_randomness: this.snap.drand_randomness,
      reveal_secret: this.snap.secret,
      final_seed: this.snap.final_seed,
      initial_state: this.snap.initial_state,
      log: this.snap.log,
      result,
      seed_draws: this.seed.draws().slice(),
    };

    // Public 'end' first; the reveal follows only after the game has ended
    // (spec §identity_and_integrity.spectator_reveal).
    this.emit(nowMs, 'end', { result: result as unknown as Json, final_state_hash: finalStateHash });
    this.emit(nowMs, 'reveal', {
      commitment: this.snap.commitment,
      reveal_secret: this.snap.secret,
      final_seed: this.snap.final_seed,
      drand_round: this.snap.drand_round,
      drand_randomness: this.snap.drand_randomness,
    });
  }

  private okResult(evStart: number, applied: boolean, forced?: boolean, notation?: string): SubmitOk {
    const out: SubmitOk = {
      ok: true,
      applied,
      ended: this.snap.status === 'ended',
      deadline_at_ms: this.snap.deadlineAtMs,
      events: this.snap.events.slice(evStart),
    };
    if (forced) out.forced = 'illegal';
    if (notation !== undefined) out.notation = notation;
    const waiting = this.snap.status === 'running' ? this.waitingFor() : [];
    if (waiting.length > 0 && this.playersToMoveNow().length > 1) out.waiting_for = waiting;
    return out;
  }
}

