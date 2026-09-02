/**
 * Match driver: N LudusClients play one REAL game end-to-end through the live
 * local Worker — register, homologate, enter the lobby, wait for the pairer
 * (cron tick), then move whenever the room says it's their turn, until the
 * game ends; finally the finalize sweep runs and the replay is fetched.
 *
 * Strategies are pluggable:
 *   - randomStrategy: seeded uniform pick over legal_moves (deterministic per
 *     agent label via the kernel SeedStream — no Math.random in decisions).
 *   - landlordStrategy / islandersStrategy: seeded random with biases that
 *     steer play toward the spec's target events (auction, accepted trade,
 *     bankruptcy / bandit steal) WITHOUT touching any rule: they only choose
 *     among the server-shipped legal moves.
 *
 * The driver also collects: every spectator event (live poll during play +
 * the full post-end stream), the final replay, per-move timings, and match
 * flags (auction/trade/steal/bankruptcy seen).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { GAMES } from '../../src/games/index.ts';
import { isParseError, isRuleError, playerId, type AnyGame, type Json, type PlayerId, type SeedStream, type ViewObject } from '../../src/kernel/types.ts';
import type { LogEntry, ReplayFile } from '../../src/kernel/replay.ts';
import { LudusApiError, LudusClient, sleep, type MoveVerdict, type Transport } from './client.ts';
import { OUT_DIR, type Harness } from './harness.ts';

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

export interface MatchFlags {
  auction: boolean;
  auctionWon: boolean;
  trade: boolean;
  steal: boolean;
  bankruptcy: boolean;
}

export interface StrategyCtx {
  flags: MatchFlags;
  seed: SeedStream;
  decision: number;
}

/** Returns the index into view.legal_moves to play. */
export type Strategy = (view: ViewObject, ctx: StrategyCtx) => number;

export const randomStrategy: Strategy = (view, ctx) =>
  ctx.seed.int(`pick:${ctx.decision}`, view.legal_moves.length);

function findIdx(view: ViewObject, pred: (notation: string) => boolean): number | null {
  const hit = view.legal_moves.find((m) => pred(m.notation));
  return hit ? hit.index : null;
}

/**
 * Landlord bias: force the first unowned-property decision to 'decline' (that
 * starts an auction, per the rules), bid low in auctions, accept incoming
 * trade offers, and make an occasional offer; otherwise seeded random.
 */
export const landlordStrategy: Strategy = (view, ctx) => {
  const accept = findIdx(view, (n) => n.startsWith('accept('));
  if (accept !== null) return accept;
  if (view.phase === 'buy_or_auction') {
    // First unowned-property decision: decline, to force an auction. After
    // that: buy, so rents (and eventually bankruptcies) actually happen.
    const target = ctx.flags.auction ? 'buy' : 'decline';
    const found = findIdx(view, (n) => n === target);
    if (found !== null) return found;
    const decline = findIdx(view, (n) => n === 'decline');
    if (decline !== null) return decline;
  }
  if (view.phase === 'auction') {
    // Bid the minimum with 70% probability so auctions actually get won.
    if (ctx.seed.int(`auction:${ctx.decision}`, 10) < 7) {
      const bids = view.legal_moves.filter((m) => m.notation.startsWith('auction_bid('));
      if (bids.length > 0) return bids[0]!.index;
    }
    const decline = findIdx(view, (n) => n === 'decline');
    if (decline !== null) return decline;
  }
  if (view.phase === 'roll') {
    const roll = findIdx(view, (n) => n === 'roll');
    if (roll !== null && ctx.seed.int(`rollcoin:${ctx.decision}`, 10) < 8) return roll;
  }
  if (view.phase === 'manage' && ctx.seed.int(`offercoin:${ctx.decision}`, 10) < 3) {
    const offers = view.legal_moves.filter((m) => m.notation.startsWith('offer('));
    if (offers.length > 0) return offers[ctx.seed.int(`offerpick:${ctx.decision}`, offers.length)]!.index;
  }
  // Strong end_turn bias: keeps rounds short so the game fits the room's
  // single-blob snapshot limit (see notes/e2e-driver.md on SQLITE_TOOBIG).
  if (view.phase === 'manage' && ctx.seed.int(`endcoin:${ctx.decision}`, 10) < 8) {
    const end = findIdx(view, (n) => n === 'end_turn');
    if (end !== null) return end;
  }
  return randomStrategy(view, ctx);
};

/**
 * Islanders bias: accept incoming offers, always rob a victim when moving the
 * bandit (notation move_bandit(hex,victim) with victim != '-'), make an
 * occasional offer; otherwise seeded random.
 */
export const islandersStrategy: Strategy = (view, ctx) => {
  const accept = findIdx(view, (n) => n.startsWith('accept('));
  if (accept !== null) return accept;
  const robs = view.legal_moves.filter((m) => /^move_bandit\([^,]+,(?!-\))[^)]+\)$/.test(m.notation));
  if (robs.length > 0) return robs[ctx.seed.int(`rob:${ctx.decision}`, robs.length)]!.index;
  // Build priority: race to 10 VP so the game ends by points well before the
  // 100-round limit (which would overflow the room's single-blob snapshot).
  for (const prefix of ['build_city(', 'build_village(', 'build_road('] as const) {
    const builds = view.legal_moves.filter((m) => m.notation.startsWith(prefix));
    if (builds.length > 0 && ctx.seed.int(`build:${prefix}:${ctx.decision}`, 10) < 9) {
      return builds[ctx.seed.int(`buildpick:${ctx.decision}`, builds.length)]!.index;
    }
  }
  if (ctx.seed.int(`offercoin:${ctx.decision}`, 20) < 3) {
    const offers = view.legal_moves.filter((m) => m.notation.startsWith('offer('));
    if (offers.length > 0) return offers[ctx.seed.int(`offerpick:${ctx.decision}`, offers.length)]!.index;
  }
  // Otherwise end the turn briskly (production still happens every roll).
  if (ctx.seed.int(`endcoin:${ctx.decision}`, 10) < 8) {
    const end = findIdx(view, (n) => n === 'end_turn');
    if (end !== null) return end;
  }
  return randomStrategy(view, ctx);
};

// ---------------------------------------------------------------------------
// Spectator event normalization (live room shape vs D1 fallback shape)
// ---------------------------------------------------------------------------

export interface NormalizedEvent {
  seq: number;
  type: string;
  data: Json;
}

export function normalizeEvents(raw: unknown): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const push = (seq: unknown, type: unknown, data: unknown): void => {
    if (typeof seq === 'number' && typeof type === 'string') out.push({ seq, type, data: (data ?? null) as Json });
  };
  const obj = raw as { events?: unknown; data?: { events?: unknown } };
  const list = Array.isArray(obj.events) ? obj.events : Array.isArray(obj.data?.events) ? obj.data!.events : [];
  for (const e of list as Record<string, unknown>[]) {
    if (typeof e.type === 'string') push(e.seq, e.type, e.data);
    else if (e.event && typeof e.event === 'object') {
      const ev = e.event as Record<string, unknown>;
      push(e.seq, ev.type, ev.data);
    }
  }
  return out;
}

/**
 * Fetch + normalize spectator events regardless of live/D1 serving shape,
 * paginating past the endpoint's 500-row page until the stream is drained.
 */
export async function fetchEvents(base: string, gameId: string, since = 0): Promise<NormalizedEvent[]> {
  const all: NormalizedEvent[] = [];
  let cursor = since;
  for (let page = 0; page < 40; page++) {
    const res = await fetch(`${base}/api/games/${gameId}/events?since=${cursor}`);
    if (res.status === 429) {
      await res.body?.cancel();
      await fetch(`${base}/e2e/unlimit`, { method: 'POST' }).catch(() => undefined);
      await sleep(200);
      page--;
      continue;
    }
    const batch = normalizeEvents((await res.json()) as unknown);
    const fresh = batch.filter((e) => e.seq > cursor);
    if (fresh.length === 0) break;
    for (const e of fresh) cursor = Math.max(cursor, e.seq);
    all.push(...fresh);
  }
  return all;
}

/**
 * Target-event detection. The room's spectator stream carries only room-level
 * 'move' events (the game modules' own GameEvents — auction_start, trade,
 * stolen, bankruptcy — are dropped by the room; see notes/e2e-driver.md), so
 * the flags are derived from the PUBLIC move notations and the public phase:
 *   - auction:    an auction_bid(...) notation, or the public phase 'auction'
 *   - trade:      an applied accept(id) notation (landlord and islanders)
 *   - steal:      move_bandit(hex,victim)/warrior with a real victim (not '-')
 *   - bankruptcy: an applied declare_bankruptcy notation
 */
export function updateFlags(flags: MatchFlags, events: readonly NormalizedEvent[]): void {
  for (const e of events) {
    if (e.type !== 'move' || !e.data || typeof e.data !== 'object' || Array.isArray(e.data)) continue;
    const data = e.data as { notation?: string; public?: { phase?: string } };
    const n = data.notation ?? '';
    if (n.startsWith('auction_bid(')) flags.auction = true;
    if (data.public && typeof data.public === 'object' && (data.public as { phase?: string }).phase === 'auction') {
      flags.auction = true;
    }
    if (n.startsWith('accept(')) flags.trade = true;
    if ((n.startsWith('move_bandit(') || n.startsWith('play_progress(warrior')) && !n.endsWith(',-)')) {
      flags.steal = true;
    }
    if (n === 'declare_bankruptcy') flags.bankruptcy = true;
  }
}

// ---------------------------------------------------------------------------
// The match runner
// ---------------------------------------------------------------------------

export interface MatchOptions {
  game: string;
  players: number;
  /** Strategy per seat-agent (by driver agent index); default randomStrategy. */
  strategies?: Strategy[];
  /** Transport per agent for view+move ('http' default; 'mcp' covers the MCP door). */
  transports?: Transport[];
  variant?: string;
  division?: 'pure' | 'open';
  perMoveMs?: number;
  /** Safety cap on total applied decisions before the driver gives up. */
  maxDecisions?: number;
  /**
   * Legitimate early end: once this many decisions have been applied, the
   * next player to move RESIGNS (a signed move; the room ends the game with a
   * real 'resignation' result). Needed for the trading games, whose natural
   * turn-limit length overflows the room's single-blob DO snapshot (product
   * bug, see notes/e2e-driver.md).
   */
  resignAfterDecisions?: number;
  /** Distinguishes retries; feeds handles + strategy seeds. */
  label: string;
  commentaryEvery?: number;
}

export interface MoveTiming {
  handle: string;
  turn_index: number;
  ms: number;
}

export interface MatchReport {
  gameId: string;
  game: string;
  agents: { handle: string; agent_id: string }[];
  /** games row snapshot taken before the first move. */
  preMatchGame: { commitment: string | null; reveal_secret: string | null; status: string };
  /** Spectator events observed live BEFORE the game ended. */
  liveEvents: NormalizedEvent[];
  /** Full post-end event stream. */
  allEvents: NormalizedEvent[];
  replay: ReplayFile;
  result: Json;
  flags: MatchFlags;
  timings: MoveTiming[];
  decisions: number;
  replayPath: string;
}

export async function runMatch(h: Harness, opts: MatchOptions): Promise<MatchReport> {
  const game = GAMES[opts.game];
  if (!game) throw new Error(`unknown game '${opts.game}'`);
  const n = opts.players;
  const division = opts.division ?? 'open';
  const variant = opts.variant ?? 'standard';
  const label = opts.label.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // 1. Agents.
  const clients: LudusClient[] = [];
  for (let i = 0; i < n; i++) {
    const c = new LudusClient({
      base: h.base,
      handle: `e2e-${label}-${i}`.slice(0, 32),
      ip: `10.7.${(hash8(label) % 200) + 1}.${i + 1}`,
    });
    await c.register();
    await c.homologate(division);
    clients.push(c);
  }

  // 2. Queue + pair. Listed games go through the real signed lobby door;
  //    unlisted (tictactoe, by spec) are seeded via the shim.
  await h.configure({ seats: { [opts.game]: n }, per_move_ms: opts.perMoveMs ?? 60_000 });
  for (const c of clients) {
    if (game.meta.listed) await c.lobbyJoin(opts.game, variant, division);
    else await h.seedLobby({ game: opts.game, variant, division, agent_id: c.agentId });
  }
  let gameId = '';
  for (let i = 0; i < 30 && !gameId; i++) {
    await h.tickCron(); // the pairer runs on the cron tick
    const mine = await clients[0]!.myGames('live');
    const row = mine.games.find((g) => g.game === opts.game);
    if (row) gameId = row.id;
    else await sleep(250);
  }
  if (!gameId) throw new Error(`pairer did not form a ${opts.game} game after 30 cron ticks`);

  // 3. Pre-match snapshot: the commitment must already be public, the reveal
  //    must not be.
  const before = await clients[0]!.game(gameId);
  const preMatchGame = {
    commitment: before.game.commitment,
    reveal_secret: before.game.reveal_secret,
    status: before.game.status,
  };
  const playerToClient = new Map<string, number>();
  for (const seat of before.game.seats ?? []) {
    const ix = clients.findIndex((c) => c.agentId === seat.agent_id);
    if (ix >= 0) playerToClient.set(seat.player, ix);
  }

  // 4. Play.
  const flags: MatchFlags = { auction: false, auctionWon: false, trade: false, steal: false, bankruptcy: false };
  const seeds = clients.map((c) => createSeedStream(sha256Hex(`e2e-strategy:${label}:${c.handle}`)));
  const strategies = clients.map((_, i) => opts.strategies?.[i] ?? randomStrategy);
  const transports = clients.map((_, i) => opts.transports?.[i] ?? 'http');
  const timings: MoveTiming[] = [];
  const liveEvents: NormalizedEvent[] = [];
  let lastSeq = 0;
  let decisions = 0;
  let ended = false;
  const maxDecisions = opts.maxDecisions ?? 3000;
  let waiting: string[] = []; // players the room said it is waiting for
  let idleLoops = 0;

  const pollLive = async (): Promise<void> => {
    const fresh = await fetchEvents(h.base, gameId, lastSeq);
    for (const e of fresh) {
      if (e.seq > lastSeq) lastSeq = e.seq;
      liveEvents.push(e);
    }
    updateFlags(flags, fresh);
  };

  while (!ended && decisions < maxDecisions) {
    const targets: number[] = [];
    if (waiting.length > 0) {
      for (const p of waiting) {
        const ix = playerToClient.get(p);
        if (ix !== undefined) targets.push(ix);
      }
    }
    if (targets.length === 0) targets.push(...clients.keys());

    let acted = false;
    for (const ix of targets) {
      const c = clients[ix]!;
      let view: ViewObject;
      try {
        view = await c.view(gameId, transports[ix]);
      } catch (e) {
        if (e instanceof LudusApiError && (e.status === 503 || e.status === 409)) {
          // Room may have ended (timeout/terminal) — finalize and re-check.
          await h.sweep();
          const now = await c.game(gameId);
          if (now.game.status === 'ended') {
            ended = true;
            break;
          }
          continue;
        }
        throw e;
      }
      if (view.legal_moves.length === 0) continue;
      if (opts.resignAfterDecisions !== undefined && decisions >= opts.resignAfterDecisions) {
        const out = await c.resign(gameId, view.turn_index, transports[ix]);
        decisions++;
        if (out.verdict.ended === true) {
          ended = true;
          break;
        }
        continue;
      }
      const ctx: StrategyCtx = { flags, seed: seeds[ix]!, decision: decisions };
      const pick = strategies[ix]!(view, ctx);
      const commentary =
        opts.commentaryEvery && decisions % opts.commentaryEvery === 0
          ? `e2e ${opts.game} decision ${decisions}`
          : undefined;
      const t0 = Date.now();
      let verdict: MoveVerdict;
      try {
        const out = await c.move(gameId, view.turn_index, { index: pick }, { commentary, transport: transports[ix] });
        verdict = out.verdict;
      } catch (e) {
        if (e instanceof LudusApiError) {
          const roomCode =
            e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? (e.data as { code?: string }).code : undefined;
          if (roomCode === 'wrong_turn' || roomCode === 'not_your_turn' || roomCode === 'room_ended' || e.code === 'GAME_NOT_LIVE') {
            waiting = []; // stale view; re-probe everyone
            continue;
          }
          throw new Error(
            `move rejected for ${c.handle} at turn ${view.turn_index} (picked index ${pick} of ` +
              `${view.legal_moves.length}, phase ${view.phase}): [${e.code}] ${e.message} — room verdict: ${JSON.stringify(e.data)}`,
          );
        }
        throw e;
      }
      timings.push({ handle: c.handle, turn_index: view.turn_index, ms: Date.now() - t0 });
      decisions++;
      acted = true;
      waiting = Array.isArray(verdict.waiting_for) ? (verdict.waiting_for as string[]) : [];
      if (verdict.ended === true) {
        ended = true;
        break;
      }
    }
    await pollLive();
    if (!acted && !ended) {
      idleLoops++;
      if (idleLoops > 200) throw new Error(`match ${gameId} stalled: no player could act for 200 loops`);
      await sleep(100);
      waiting = [];
    } else {
      idleLoops = 0;
    }
  }
  if (!ended) throw new Error(`match ${gameId} hit the ${maxDecisions}-decision cap without ending`);

  // Capture any tail events that were emitted before end but not yet polled.
  await pollLive();

  // 5. Finalize (D1 status flip + ratings) and fetch the replay.
  await h.sweep();
  const after = await clients[0]!.game(gameId);
  if (after.game.status !== 'ended') throw new Error(`game ${gameId} room ended but finalize left status '${after.game.status}'`);
  const { replay } = await clients[0]!.replay(gameId);
  const allEvents = await fetchEvents(h.base, gameId, 0);
  updateFlags(flags, allEvents);

  const replayPath = join(OUT_DIR, `replay-${opts.game}-${label}.json`);
  writeFileSync(replayPath, JSON.stringify(replay));

  return {
    gameId,
    game: opts.game,
    agents: clients.map((c) => ({ handle: c.handle, agent_id: c.agentId })),
    preMatchGame,
    liveEvents,
    allEvents,
    replay: replay as unknown as ReplayFile,
    result: after.game.result,
    flags,
    timings,
    decisions,
    replayPath,
  };
}

// ---------------------------------------------------------------------------
// Deliberate misbehavior (A11 e2e half): illegal-move policy + timeout strike
// ---------------------------------------------------------------------------

export interface MisbehaviorReport {
  gameId: string;
  agents: { handle: string; agent_id: string; player: string }[];
  /** Room verdicts for the 1st and 2nd illegal submissions of one turn. */
  firstIllegal: Json;
  secondIllegal: Json;
  /** Verdict of the accepted legal 3rd submission of that same turn. */
  legalAfterIllegals: MoveVerdict;
  /** Verdict shape when a turn's 3rd submission was ALSO illegal (forced random legal + strike). */
  forcedVerdict: MoveVerdict | null;
  timedOutPlayer: string;
  replay: ReplayFile;
  allEvents: NormalizedEvent[];
  result: Json;
}

/**
 * Agent 0 opens every one of its turns with 2 illegal submissions (an
 * out-of-range index, then unparseable notation) before playing a legal move;
 * on its second turn it goes all the way to a 3rd illegal so the room forces
 * a seeded random legal move + strike. Agent 1 misses its first deadline
 * entirely (timeout default + strike). The game then runs to a natural end.
 */
export async function runMisbehaviorMatch(h: Harness, label = 'misbehave'): Promise<MisbehaviorReport> {
  const gameName = 'connect_drop';
  const perMoveMs = 8_000;
  const clients: LudusClient[] = [];
  for (let i = 0; i < 2; i++) {
    const c = new LudusClient({ base: h.base, handle: `e2e-${label}-${i}`, ip: `10.9.9.${i + 1}` });
    await c.register();
    await c.homologate('open');
    clients.push(c);
  }
  await h.configure({ seats: { [gameName]: 2 }, per_move_ms: perMoveMs });
  for (const c of clients) await c.lobbyJoin(gameName, 'standard', 'open');
  let gameId = '';
  for (let i = 0; i < 30 && !gameId; i++) {
    await h.tickCron();
    const mine = await clients[0]!.myGames('live');
    const row = mine.games.find((g) => g.game === gameName);
    if (row) gameId = row.id;
    else await sleep(200);
  }
  if (!gameId) throw new Error('pairer did not form the misbehavior game');
  const info = await clients[0]!.game(gameId);
  const seatOf = new Map<string, string>(); // agent_id -> player
  for (const s of info.game.seats ?? []) seatOf.set(s.agent_id, s.player);
  const agents = clients.map((c) => ({ handle: c.handle, agent_id: c.agentId, player: seatOf.get(c.agentId) ?? '?' }));

  const expectIllegal = async (c: LudusClient, turn: number, move: string | { index: number }): Promise<Json> => {
    try {
      await c.move(gameId, turn, move);
    } catch (e) {
      if (e instanceof LudusApiError) return (e.data ?? null) as Json;
      throw e;
    }
    throw new Error(`expected an illegal-move rejection for ${JSON.stringify(move)} at turn ${turn}`);
  };

  let firstIllegal: Json = null;
  let secondIllegal: Json = null;
  let legalAfterIllegals: MoveVerdict | null = null;
  let forcedVerdict: MoveVerdict | null = null;
  let timedOut = false;
  let ended = false;
  let aTurns = 0;
  const seed = createSeedStream(sha256Hex(`e2e-misbehave:${label}`));
  let decisions = 0;

  while (!ended && decisions < 120) {
    let acted = false;
    for (let ix = 0; ix < 2; ix++) {
      const c = clients[ix]!;
      let view: ViewObject;
      try {
        view = await c.view(gameId);
      } catch (e) {
        if (e instanceof LudusApiError && (e.status === 503 || e.status === 409)) {
          await h.sweep();
          const now = await c.game(gameId);
          if (now.game.status === 'ended') ended = true;
          continue;
        }
        throw e;
      }
      if (view.legal_moves.length === 0) continue;
      acted = true;
      decisions++;

      if (ix === 1 && !timedOut) {
        // Agent 1 misses its first deadline entirely. The DO alarm is the
        // primary clock; the cron's room tick is the sweep. Wait past the
        // deadline, tick, and confirm via the log that a timeout was applied.
        timedOut = true;
        await sleep(perMoveMs + 1_500);
        await h.tickCron();
        continue;
      }

      if (ix === 0) {
        aTurns++;
        const turn = view.turn_index;
        if (aTurns === 2 && forcedVerdict === null) {
          // Full three-illegal turn: the room must apply a seeded random
          // legal move itself and record a strike.
          await expectIllegal(c, turn, { index: 99_999 });
          await expectIllegal(c, turn, 'zz99-not-a-move');
          const out = await c.move(gameId, turn, { index: 99_999 });
          forcedVerdict = out.verdict;
          if (out.verdict.ended === true) ended = true;
          continue;
        }
        const first = await expectIllegal(c, turn, { index: 99_999 });
        const second = await expectIllegal(c, turn, 'zz99-not-a-move');
        if (firstIllegal === null) {
          firstIllegal = first;
          secondIllegal = second;
        }
        const pick = seed.int(`a:${decisions}`, view.legal_moves.length);
        const out = await c.move(gameId, turn, { index: pick }, { commentary: 'legal after two rejections' });
        if (legalAfterIllegals === null) legalAfterIllegals = out.verdict;
        if (out.verdict.ended === true) ended = true;
        continue;
      }

      const pick = seed.int(`b:${decisions}`, view.legal_moves.length);
      const out = await c.move(gameId, view.turn_index, { index: pick });
      if (out.verdict.ended === true) ended = true;
    }
    if (!acted && !ended) await sleep(150);
  }
  if (!ended) {
    // Cap reached: resign cleanly so the log still ends properly.
    const view = await clients[0]!.view(gameId).catch(() => null);
    if (view) await clients[0]!.resign(gameId, view.turn_index);
  }

  await h.sweep();
  const after = await clients[0]!.game(gameId);
  if (after.game.status !== 'ended') throw new Error('misbehavior game did not finalize');
  const { replay } = await clients[0]!.replay(gameId);
  const allEvents = await fetchEvents(h.base, gameId, 0);
  if (firstIllegal === null || secondIllegal === null || legalAfterIllegals === null) {
    throw new Error('misbehavior match ended before both illegal-rejection steps were observed');
  }
  return {
    gameId,
    agents,
    firstIllegal,
    secondIllegal,
    legalAfterIllegals,
    forcedVerdict,
    timedOutPlayer: agents[1]!.player,
    replay: replay as unknown as ReplayFile,
    allEvents,
    result: after.game.result,
  };
}

function hash8(s: string): number {
  let acc = 0;
  for (let i = 0; i < s.length; i++) acc = (acc * 31 + s.charCodeAt(i)) >>> 0;
  return acc % 251;
}

// ---------------------------------------------------------------------------
// Replay state walk (for hidden-information leak probes)
// ---------------------------------------------------------------------------

/**
 * Recomputes the state after every applied entry by replaying the log with
 * the game module and a fresh seed stream from final_seed (purpose-scoped
 * HMAC streams mean skipping the verifier-only pick draws cannot desync the
 * game's own draw purposes). Returns [initialState, ...stateAfterEachApply].
 */
export function replayStates(replay: ReplayFile): Json[] {
  const game = GAMES[replay.game] as AnyGame | undefined;
  if (!game) throw new Error(`replayStates: unknown game '${replay.game}'`);
  const seed = createSeedStream(replay.final_seed);
  const players = replay.seats.map((_, i) => playerId(i));
  let state = game.initialState(seed, players, replay.variant);
  const states: Json[] = [state];
  for (const entry of replay.log) {
    const applied = appliedNotationOf(entry);
    if (applied === null) continue;
    const payload = entry.payload as { player?: PlayerId };
    const player = payload.player ?? '';
    const move = game.parseMove(applied, state, player);
    if (isParseError(move)) throw new Error(`replayStates seq ${entry.seq}: cannot parse '${applied}': ${move.message}`);
    const out = game.apply(state, player, move, seed);
    if (isRuleError(out)) throw new Error(`replayStates seq ${entry.seq}: apply('${applied}') rejected: ${out.message}`);
    state = out.state;
    states.push(state);
  }
  return states;
}

function appliedNotationOf(entry: LogEntry): string | null {
  const payload = entry.payload as { notation?: string; applied_notation?: string };
  if (entry.kind === 'move') return typeof payload.notation === 'string' ? payload.notation : null;
  if (entry.kind === 'timeout') return typeof payload.applied_notation === 'string' ? payload.applied_notation : null;
  return null;
}

/**
 * Union of every player's secretProbes over every state of the game (games
 * that export none contribute nothing). Probes shorter than 6 chars are
 * dropped as too collision-prone for a substring scan.
 */
export async function collectSecretProbes(replay: ReplayFile): Promise<string[]> {
  let probesFn: ((state: Json, player: PlayerId) => string[]) | null = null;
  if (replay.game === 'landlord') {
    probesFn = (await import('../../src/games/landlord/index.ts')).secretProbes;
  } else if (replay.game === 'islanders') {
    const mod = await import('../../src/games/islanders/index.ts');
    probesFn = (state: Json, player: PlayerId) =>
      (mod.secretProbes as (s: unknown, p: PlayerId) => string[])(state, player);
  }
  if (!probesFn) return [];
  const probes = new Set<string>();
  const players = replay.seats.map((_, i) => playerId(i));
  for (const state of replayStates(replay)) {
    for (const p of players) {
      for (const probe of probesFn(state, p)) {
        if (probe.length >= 6) probes.add(probe);
      }
    }
  }
  return [...probes];
}
