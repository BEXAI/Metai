/**
 * Match driver: N LudusClients play one REAL game end-to-end through the live
 * local Worker — register, homologate, enter the lobby, wait for the REAL
 * cronTick pairer (cron tick), then move whenever the room says it's their
 * turn, until the game ends; the room's own finalize path (R2 + D1 + ratings)
 * runs on end and the replay is fetched from the API.
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
import {
  isRuleError,
  playerId,
  type AnyGame,
  type Json,
  type LegalMoveEntry,
  type PlayerId,
  type SeedStream,
  type ViewObject,
} from '../../src/kernel/types.ts';
import { resolveSubmittedMove } from '../../src/kernel/move.ts';
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

/**
 * A submission a strategy wants made, for the games where an index is not the
 * whole move: werewolf's WORDS ARE A MOVE PAYLOAD and ride either inline in the
 * notation (`accuse(p3) "you dodged the check"`) or in the separate `utterance`
 * field. Every board-game strategy keeps returning a plain index.
 */
export interface MoveDecision {
  move: string | { index: number };
  utterance?: string;
  commentary?: string;
}

/** Returns the index into view.legal_moves to play, or a full submission. */
export type Strategy = (view: ViewObject, ctx: StrategyCtx) => number | MoveDecision;

/**
 * Normalise a Strategy's return into submission parts. A bare number is the
 * index-only form every board game uses; a MoveDecision is what a speech game
 * returns when it also has words to say.
 */
export function decisionOf(pick: number | MoveDecision): MoveDecision {
  return typeof pick === 'number' ? { move: { index: pick } } : pick;
}

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
// werewolf: the one strategy whose moves are WORDS
// ---------------------------------------------------------------------------

/**
 * Markers the e2e assertions look for. A move's `text` reaches the state, the
 * state hash, the signed log and the public transcript, so finding a marker on
 * the spectator `game:speech` feed proves that CHANNEL carried real words all
 * the way through — not merely that the field was accepted at the door.
 */
export const WW_INLINE_MARK = 'inline-channel';
export const WW_UTTERANCE_MARK = 'utterance-channel';

/** Deliberately lowercase: an uppercase role word would collide with the
 *  dossier-row leak probe shape (`p3 SEER`) and fail the scan on our own text. */
const WW_DAY_LINES: readonly string[] = [
  'the quiet seats worry me more than the loud ones',
  'nobody answered the question from the first round',
  'that timing does not fit an honest seat',
  'i want the check before i commit to a wagon',
  'i am reading the vote history, not the volume',
];
const WW_NIGHT_LINES: readonly string[] = [
  'keeping this short, the clock is not generous',
  'i will follow the wagon tomorrow and watch who flinches',
  'no need to explain, the count speaks for itself',
];
const WW_BALLOT_LINES: readonly string[] = [
  'voting the seat that drew the accusations',
  'i would rather be wrong out loud than quiet',
  'this is the only read i can defend',
];

/** The move object werewolf ships inside every legal_moves entry. */
interface WwLegalMoveShape {
  t?: string;
  target?: string;
}

/** The live per-phase speech cap the room shipped (600 day / 300 night / 200 ballot). */
function wwSpeechCap(view: ViewObject): number {
  const limit = view.speech?.limit;
  return typeof limit === 'number' && limit > 0 ? limit : 0;
}

/** Honours the LIVE cap in view.speech rather than a hardcoded constant. */
function wwFit(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap).trimEnd();
}

/**
 * The notation to hang INLINE speech on. Day and ballot entries already carry
 * their own head (`accuse(p3)`, `vote(p2)`, `abstain`), but every NIGHT entry
 * notates as the single redacted constant `night`, which carries no target —
 * so the night head is rebuilt from the move object the view ships alongside
 * it. Sending `kill(p3) "…"` is the point: the room must still log `night`.
 */
function wwInlineHead(entry: LegalMoveEntry): string {
  const m = (entry.move ?? {}) as WwLegalMoveShape;
  switch (m.t) {
    case 'kill':
    case 'peek':
    case 'guard':
      return `${m.t}(${m.target ?? ''})`;
    case 'stay_in':
    case 'sleep':
      return m.t;
    default:
      return entry.notation;
  }
}

/**
 * Submits `entry` WITH WORDS, over one of the two channels the game accepts:
 *   inline    a quoted JSON string literal in the notation — accuse(p3) "…"
 *   utterance the separate signed field, folded in by game.bindUtterance
 * Both land in move.text, so both are phase-gated by apply(), covered by the
 * state hash and recomputed by the offline verifier.
 *
 * The channel is chosen by SEAT PARITY, not by a coin. Night 1, both talk
 * rounds of day 1 and the day-1 ballot all have every one of the eight seats
 * moving, so parity makes BOTH channels certain in every one of those phases.
 * A coin would not: night words never reach a public surface, so a run whose
 * coin happened to land the same way all night would make that half of the
 * assertion silently vacuous instead of failing.
 */
function wwSpeak(view: ViewObject, entry: LegalMoveEntry, line: string): MoveDecision {
  const cap = wwSpeechCap(view);
  if (cap === 0) return { move: { index: entry.index } };
  if (view.you.seat % 2 === 0) {
    const text = wwFit(`${WW_INLINE_MARK} ${line}`, cap);
    return { move: `${wwInlineHead(entry)} ${JSON.stringify(text)}` };
  }
  return { move: { index: entry.index }, utterance: wwFit(`${WW_UTTERANCE_MARK} ${line}`, cap) };
}

/**
 * Werewolf: PHASE-AWARE, and never a script. The role deal comes from the
 * room's commit-revealed seed, so which seat may kill, peek or guard differs
 * every run and is only ever discovered from that seat's own legal_moves.
 *
 * night      every living seat must submit; a villager's only option is
 *            `sleep` (index 0) and skipping it times the seat out. A seat that
 *            HAS a real action takes it 9 nights in 10, which is what drives
 *            the game to a natural terminal instead of six silent nights.
 * day_talk   accuse-heavy, so a most-accused seat exists and the defence phase
 *            actually runs; claim/report/defend/say fill the rest.
 * day_vote   pile onto the seat that just defended (read off public.defender,
 *            which is public information) 7 times in 10 — strict plurality
 *            lynches and ANY TIE IS NO LYNCH, so a scattered ballot would stall
 *            the game at the day limit every time.
 */
export const werewolfStrategy: Strategy = (view, ctx) => {
  const legal = view.legal_moves;
  if (legal.length === 0) return 0;
  const pick = (list: LegalMoveEntry[], key: string): LegalMoveEntry =>
    list[ctx.seed.int(`ww:${key}:${ctx.decision}`, list.length)]!;
  const lineFrom = (lines: readonly string[], key: string): string =>
    lines[ctx.seed.int(`ww:${key}:${ctx.decision}`, lines.length)]!;

  if (view.phase === 'night') {
    const acts = legal.filter((m) => {
      const t = (m.move as WwLegalMoveShape | undefined)?.t;
      return t === 'kill' || t === 'peek' || t === 'guard';
    });
    const entry =
      acts.length > 0 && ctx.seed.int(`ww:act:${ctx.decision}`, 10) < 9 ? pick(acts, 'nightact') : legal[0]!;
    // Night words are a pack whisper (wolves) or a private note (everyone
    // else): they reach no public surface, so the only place they can be
    // proved to have landed is the replay.
    return wwSpeak(view, entry, lineFrom(WW_NIGHT_LINES, 'nightline'));
  }

  if (view.phase === 'day_talk' || view.phase === 'day_defense') {
    const of = (prefix: string): LegalMoveEntry[] => legal.filter((m) => m.notation.startsWith(prefix));
    const accuse = of('accuse(');
    const report = of('report(');
    const claim = of('claim(');
    const defend = of('defend(');
    const roll = ctx.seed.int(`ww:day:${ctx.decision}`, 10);
    let entry: LegalMoveEntry;
    if (roll < 5 && accuse.length > 0) entry = pick(accuse, 'accusepick');
    else if (roll < 7 && report.length > 0) entry = pick(report, 'reportpick');
    else if (roll < 8 && claim.length > 0) entry = pick(claim, 'claimpick');
    else if (roll < 9 && defend.length > 0) entry = pick(defend, 'defendpick');
    else entry = legal[0]!; // `say`
    // Speech IS the day move here: silence is index 0 with text ''.
    return wwSpeak(view, entry, lineFrom(WW_DAY_LINES, 'dayline'));
  }

  if (view.phase === 'day_vote') {
    const votes = legal.filter((m) => m.notation.startsWith('vote('));
    const pub = view.public as { defender?: unknown } | null;
    const defender = typeof pub?.defender === 'string' ? pub.defender : null;
    const wagon = defender === null ? [] : votes.filter((m) => m.notation === `vote(${defender})`);
    const entry =
      wagon.length > 0 && ctx.seed.int(`ww:wagon:${ctx.decision}`, 10) < 7
        ? wagon[0]!
        : votes.length > 0
          ? pick(votes, 'votepick')
          : legal[0]!; // `abstain`
    return wwSpeak(view, entry, lineFrom(WW_BALLOT_LINES, 'ballotline'));
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
 * Target-event detection. Since the stage-4 integration, the room emits the
 * game modules' own PUBLIC GameEvents live to spectators as `game:<type>`
 * events (auction_start, auction_won, trade, stolen, bankruptcy, ...), so the
 * flags key off those first; the pre-integration notation/phase heuristics
 * are kept as a cross-check fallback:
 *   - auction:    game:auction_start, an auction_bid(...) notation, or the
 *                 public phase 'auction'
 *   - auctionWon: game:auction_won
 *   - trade:      game:trade, or an applied accept(id) notation
 *   - steal:      game:stolen, or move_bandit/warrior with a real victim
 *   - bankruptcy: game:bankruptcy, or an applied declare_bankruptcy notation
 */
export function updateFlags(flags: MatchFlags, events: readonly NormalizedEvent[]): void {
  for (const e of events) {
    // Real game-authored events (wired by the stage-4 rooms integration).
    if (e.type === 'game:auction_start') flags.auction = true;
    if (e.type === 'game:auction_won') flags.auctionWon = true;
    if (e.type === 'game:trade') flags.trade = true;
    if (e.type === 'game:stolen') flags.steal = true;
    if (e.type === 'game:bankruptcy') flags.bankruptcy = true;
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
  /** Safety cap on total applied decisions before the driver gives up. */
  maxDecisions?: number;
  /**
   * Legitimate early end: once this many decisions have been applied, the
   * next player to move RESIGNS (a signed move; the room ends the game with a
   * real 'resignation' result). No longer needed for the trading games (the
   * room's chunked DO storage survives full-length matches now) — kept as a
   * generic driver capability.
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

/**
 * Wait for the PRODUCT finalize path (GameRoom.finalize: R2 upload + D1 rows
 * + ratings hook, run on every end path inside the room) to flip the games
 * row to 'ended'. Normally instant — finalize is awaited before the ending
 * move's response — but D1 failures are retried by the room's alarm (+5 s),
 * so poll with a cron tick (its timeout sweep POSTs /tick on live rooms,
 * which re-runs finalize for ended-but-unfinalized rooms).
 */
async function waitForEnded(
  h: Harness,
  c: LudusClient,
  gameId: string,
  timeoutMs = 30_000,
): Promise<{ status: string; result: Json } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = await c.game(gameId);
    if (now.game.status === 'ended') return { status: now.game.status, result: now.game.result };
    if (Date.now() >= deadline) return null;
    await h.tickCron();
    await sleep(300);
  }
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
  //    unlisted (tictactoe, by spec) are seeded via the shim door. The REAL
  //    cronTick pairer (src/match/pairing.ts) forms the game on a cron tick —
  //    it seats meta.players.min agents per queue, so `opts.players` must
  //    equal players.min for the game.
  const expectedSeats = game.meta.players.min;
  if (n !== expectedSeats) {
    throw new Error(
      `runMatch(${opts.game}): the product pairer always seats players.min=${expectedSeats}, got players=${n}`,
    );
  }
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
          // Room may have ended (timeout/terminal); the product finalize
          // already flips D1 status on every end path — just re-check.
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
        const decision = decisionOf(pick);
        const out = await c.move(gameId, view.turn_index, decision.move, {
          commentary: decision.commentary ?? commentary,
          utterance: decision.utterance,
          transport: transports[ix],
        });
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

  // 5. The PRODUCT finalize (room end path) flips D1 + uploads R2 + applies
  //    ratings; wait for the status flip, then fetch the replay.
  const after = await waitForEnded(h, clients[0]!, gameId);
  if (!after) throw new Error(`game ${gameId} room ended but the product finalize never flipped D1 status to 'ended'`);
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
    result: after.result,
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
  // The e2e worker sets PER_MOVE_MS_OVERRIDE (wrangler.e2e.jsonc vars) so the
  // pairer creates games with a short per-move clock; the timeout half of this
  // match waits out that deadline instead of the generous production default.
  // Keep in sync with wrangler.e2e.jsonc.
  const perMoveMs = 10_000;
  const clients: LudusClient[] = [];
  for (let i = 0; i < 2; i++) {
    const c = new LudusClient({ base: h.base, handle: `e2e-${label}-${i}`, ip: `10.9.9.${i + 1}` });
    await c.register();
    await c.homologate('open');
    clients.push(c);
  }
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

  const after = await waitForEnded(h, clients[0]!, gameId);
  if (!after) throw new Error('misbehavior game did not finalize (product finalize path)');
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
    result: after.result,
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
 * Recomputes the state after every state-changing entry by replaying the log
 * with the game module and a fresh seed stream from final_seed. Returns
 * [initialState, ...stateAfterEachApply].
 *
 * THE MOVE COMES FROM `payload.submission`, NOT FROM THE LOGGED NOTATION.
 * This mirrors kernel/verify.ts's recomputation exactly, and it has to: a game
 * may REDACT its notation, and werewolf does — every night move of every role
 * notates as the single token `night`, so re-parsing the notation would replay
 * every night as an abstention and diverge on the first kill. Resolving the
 * submission through the shared kernel/move.ts ladder also picks up
 * bindUtterance, so speech lands in the state here the same way it did in the
 * room. The three non-submission paths are reproduced the way the room and the
 * verifier both freeze them:
 *
 *   timeout            game.defaultMove, else legal[seed.int('timeout:turn:N')]
 *   forced: 'illegal'  legal[seed.int('illegal:turn:N')] — the SUBMISSION on
 *                      such an entry is the rejected third attempt, not the
 *                      move that applied
 *   forfeit + state_hash   an ELIMINATION: game.forfeitPlayer advanced the
 *                      state, and everything after it depends on that
 *
 * Purpose-scoped HMAC streams mean the draws taken here for the forced paths
 * can never desync the game's own draw purposes.
 */
/** One state-changing log entry, with the states either side of it. */
export interface ReplayStep {
  entry: LogEntry;
  /** The state the entry was applied TO (so: the phase it was played in). */
  pre: Json;
  /** The state it produced. */
  post: Json;
}

export interface ReplayWalk {
  initial: Json;
  steps: ReplayStep[];
}

export function replayStates(replay: ReplayFile): Json[] {
  const walk = replayWalk(replay);
  return [walk.initial, ...walk.steps.map((s) => s.post)];
}

/**
 * The walk replayStates is built on, exposed because some assertions need the
 * PRE state of an entry and not just the sequence of states: werewolf's night
 * redaction is a claim about the phase a move was PLAYED IN, and only `pre`
 * says what that was (the last night mover's own move lands in day_talk).
 */
export function replayWalk(replay: ReplayFile): ReplayWalk {
  const game = GAMES[replay.game] as AnyGame | undefined;
  if (!game) throw new Error(`replayStates: unknown game '${replay.game}'`);
  const seed = createSeedStream(replay.final_seed);
  const players = replay.seats.map((_, i) => playerId(i));
  let state = game.initialState(seed, players, replay.variant);
  const initial = state;
  const steps: ReplayStep[] = [];

  for (const entry of replay.log) {
    if (entry.kind !== 'move' && entry.kind !== 'timeout' && entry.kind !== 'forfeit') continue;
    const payload = entry.payload as {
      player?: PlayerId;
      turn_index?: number;
      forced?: string;
      state_hash?: string;
      submission?: { move?: unknown; utterance?: unknown };
    };
    const player = payload.player ?? '';
    const where = `replayStates seq ${entry.seq} (${entry.kind} ${player})`;

    if (entry.kind === 'forfeit') {
      // { player, reason } with no state_hash is the TERMINAL forfeit every
      // game without forfeitPlayer produces: nothing follows it and the state
      // is unchanged.
      if (payload.state_hash === undefined) continue;
      const out = game.forfeitPlayer?.(state, player) ?? null;
      if (out === null) throw new Error(`${where}: forfeitPlayer returned null for a logged elimination`);
      steps.push({ entry, pre: state, post: out.state });
      state = out.state;
      continue;
    }

    const turn = typeof payload.turn_index === 'number' ? payload.turn_index : 0;
    let move: Json;
    if (entry.kind === 'timeout' || payload.forced === 'illegal') {
      const legal = game.legalMoves(state, player);
      if (legal.length === 0) throw new Error(`${where}: forced entry but no legal moves exist`);
      if (entry.kind === 'timeout') {
        move = game.defaultMove
          ? game.defaultMove(state, player, legal)
          : legal[seed.int(`timeout:turn:${turn}`, legal.length)]!;
      } else {
        move = legal[seed.int(`illegal:turn:${turn}`, legal.length)]!;
      }
    } else {
      const submission = payload.submission;
      if (typeof submission !== 'object' || submission === null) throw new Error(`${where}: payload.submission missing`);
      const resolved = resolveSubmittedMove(game, state, player, submission as { move: unknown; utterance?: unknown });
      if (!resolved.ok) throw new Error(`${where}: submission did not resolve (${resolved.reason})`);
      move = resolved.move;
    }

    const out = game.apply(state, player, move, seed);
    if (isRuleError(out)) throw new Error(`${where}: apply rejected the replayed move: ${out.code}: ${out.message}`);
    steps.push({ entry, pre: state, post: out.state });
    state = out.state;
  }
  return { initial, steps };
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
  } else if (replay.game === 'werewolf') {
    // Every probe werewolf emits clears the 6-char filter below: the shortest
    // family is the dossier row `p0 SEER` at 7. A terminal state contributes
    // nothing (the post-`end` reveal is sanctioned), which is exactly why the
    // e2e scan is over PRE-END events.
    const mod = await import('../../src/games/werewolf/index.ts');
    probesFn = (state: Json, player: PlayerId) =>
      (mod.secretProbes as (s: unknown, p: PlayerId) => string[])(state, player);
  }
  if (!probesFn) return [];
  const states = replayStates(replay);
  const players = replay.seats.map((_, i) => playerId(i));

  /**
   * Which seats a UNION-over-all-states probe set may speak for.
   *
   * Werewolf is the one game where a hidden secret becomes LEGITIMATELY public
   * mid-game: every death reveals the dead seat's role, and the public dossier
   * then prints `p3 WEREWOLF` in the board_text of every later move event —
   * which is byte-identical to that seat's own dossier-row probe, collected
   * from the earlier states in which it was still alive. Scanning the union
   * against the whole pre-end stream would therefore fail on CORRECT
   * behaviour. The union is restricted to seats whose role never became public
   * at all (nothing in `revealed` at the end of play), and the sharper,
   * time-scoped check — a per-event scan against exactly the seats still
   * hidden AT THAT EVENT — lives in the werewolf match test.
   */
  let speaksFor: (p: PlayerId) => boolean = () => true;
  if (replay.game === 'werewolf') {
    const final = states[states.length - 1] as { revealed?: Record<string, unknown> } | null;
    const revealed = new Set(Object.keys(final?.revealed ?? {}));
    speaksFor = (p) => !revealed.has(p);
  }

  const probes = new Set<string>();
  for (const state of states) {
    for (const p of players) {
      if (!speaksFor(p)) continue;
      for (const probe of probesFn(state, p)) {
        if (probe.length >= 6) probes.add(probe);
      }
    }
  }
  return [...probes];
}
