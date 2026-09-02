/**
 * RED TEAM red-team-liveness — attack family 1: stall a game.
 *
 * Targets src/rooms/core.ts against the frozen policy
 * (spec §llm_player_protocol.move_submission, §matchmaking_and_ratings
 * .forfeits_and_draws, acceptance A11):
 *   - 2-illegal-then-legal every turn is allowed free work, but the policy
 *     must be EXACT: rejections never consume the turn or strike, the counter
 *     resets per turn, the 3rd forces random+strike.
 *   - timeout/legal alternation farms 2 strikes legally; the 3rd forfeits —
 *     including when the strike-causing move is the one that ends the game.
 *   - a simultaneous phase deadline resolves ALL absentees with
 *     defaults+strikes in ONE pass, and the pass is idempotent.
 *   - draw-offer spam cannot accumulate; an offer expires after the
 *     opponent's next turn; forced moves never carry an offer.
 *   - resignation works off-turn; nothing at all lands after the game ends.
 *
 * Every test asserts the DEFENDED behavior; a failing test is an exploitable
 * hole. Deterministic keys only (sha256-derived); no Date.now/Math.random.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { signEd25519 } from '../../src/crypto/ed25519.ts';
import { publicKeyOf } from '../../src/identity/ed25519.ts';
import {
  playerId,
  type GameMeta,
  type GameResult,
  type Json,
  type MoveSubmission,
  type PlayerId,
  type SeedStream,
  type VariantConfig,
} from '../../src/kernel/types.ts';
import {
  moveSignMessage,
  RoomCore,
  type RoomSeat,
  type SubmitOk,
  type SubmitReject,
} from '../../src/rooms/core.ts';
import { miniGame, P0, P1 } from '../../src/rooms/tests/mini-game.ts';

const SECRET = '33'.repeat(32);
const DRAND = 'ef'.repeat(32);
const P2: PlayerId = playerId(2);

interface Seat {
  seat: RoomSeat;
  secretKey: string;
}

function makeSeat(i: number): Seat {
  const secretKey = sha256Hex(`redteam-liveness:stalls:seat:${i}`);
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

function makeCore(opts?: {
  game?: typeof miniGame;
  variant?: VariantConfig;
  nSeats?: number;
}): { core: RoomCore; seats: Seat[]; gameId: string } {
  const n = opts?.nSeats ?? 2;
  const seats = Array.from({ length: n }, (_, i) => makeSeat(i));
  const gameId = 'rt-liveness-stalls';
  const core = RoomCore.create(1_000_000, {
    gameId,
    game: opts?.game ?? miniGame,
    variant: opts?.variant ?? {},
    seats: seats.map((s) => s.seat),
    division: 'open',
    rulesetVersion: '1.0.0',
    secretHex: SECRET,
    drandRound: 777,
    drandRandomnessHex: DRAND,
    perMoveMs: 60_000,
    clockScale: 1,
  });
  return { core, seats, gameId };
}

function submit(
  core: RoomCore,
  gameId: string,
  seat: Seat,
  move: MoveSubmission['move'],
  nowMs: number,
  extra?: Partial<MoveSubmission>,
) {
  const submission: MoveSubmission = { game_id: gameId, turn_index: core.turnIndex, move, ...extra };
  const signature = signEd25519(seat.secretKey, moveSignMessage(gameId, core.turnIndex, submission));
  return core.submitMove(nowMs, seat.seat.agent_id, submission, signature);
}

function strikeEntries(core: RoomCore): number {
  return core.log.filter((e) => e.kind === 'strike').length;
}

// ---------------------------------------------------------------------------
// A tiny 3-player game whose first phase is simultaneous (all three must play
// under one shared deadline) — the islanders discard-half trap with two
// possible absentees, so a single timeout pass must resolve BOTH.
// ---------------------------------------------------------------------------

type TriState = {
  players: PlayerId[];
  seq: { player: PlayerId; m: string }[];
  done: Record<string, boolean>;
  limit: number;
};

const triMeta: GameMeta = {
  id: 'tri',
  name: 'Tri Simultaneous Test Game',
  players: { min: 3, max: 3 },
  information: 'perfect',
  randomness: 'none',
  variants: {},
  notation: "single letter 'a' or 'b'",
  boardText: 'one line listing the moves played so far',
  listed: false,
};

function triSt(state: Json): TriState {
  return state as TriState;
}

function triMovers(s: TriState): PlayerId[] {
  if (s.seq.length >= s.limit) return [];
  if (s.seq.length < s.players.length) return s.players.filter((p) => s.done[p] !== true);
  return [s.players[s.seq.length % s.players.length]!];
}

const triGame: typeof miniGame = {
  meta: triMeta,
  initialState(_seed: SeedStream, players: PlayerId[], variant: VariantConfig): Json {
    const done: Record<string, boolean> = {};
    for (const p of players) done[p] = false;
    const limit = typeof variant['limit'] === 'number' ? variant['limit'] : 6;
    return { players: players.slice(), seq: [], done, limit } as Json;
  },
  playersToMove(state) {
    return triMovers(triSt(state));
  },
  legalMoves(state, player) {
    const s = triSt(state);
    if (!triMovers(s).includes(player)) return [];
    return [{ m: 'a' }, { m: 'b' }] as Json[];
  },
  apply(state, player, move) {
    const s = triSt(state);
    if (!triMovers(s).includes(player)) {
      return { error: true, code: 'not_to_move', message: `${player} is not to move` };
    }
    const m = (move as { m?: unknown }).m;
    if (m !== 'a' && m !== 'b') return { error: true, code: 'bad_move', message: "move must be 'a' or 'b'" };
    const firstRound = s.seq.length < s.players.length;
    const next: TriState = {
      ...s,
      seq: [...s.seq, { player, m }],
      done: firstRound ? { ...s.done, [player]: true } : s.done,
    };
    return { state: next as Json, events: [] };
  },
  isTerminal(state): GameResult | null {
    const s = triSt(state);
    if (s.seq.length < s.limit) return null;
    return { winners: [s.seq[s.seq.length - 1]!.player], draw: false, reason: 'turn_limit' };
  },
  publicView(state) {
    const s = triSt(state);
    return {
      phase: s.seq.length < s.players.length ? 'discard' : 'play',
      moves: s.seq.map((e) => `${e.player}:${e.m}`),
      count: s.seq.length,
    };
  },
  privateView() {
    return {};
  },
  renderText(state) {
    const s = triSt(state);
    return `tri[${s.seq.length}/${s.limit}] ${s.seq.map((e) => `${e.player}${e.m}`).join(' ') || '(empty)'}`;
  },
  encodeState(state) {
    return JSON.stringify(state);
  },
  decodeState(encoded) {
    return JSON.parse(encoded) as Json;
  },
  parseMove(input) {
    const t = input.trim();
    if (t === 'a' || t === 'b') return { m: t } as Json;
    return { parseError: true, message: `unknown notation '${input}'` };
  },
  moveToNotation(move) {
    return String((move as { m?: unknown }).m);
  },
  defaultMove(_state, _player, legal) {
    return legal[0]!; // deterministic: 'a'
  },
};

// ---------------------------------------------------------------------------
// 1. Unbounded 2-illegal-then-legal farming — the policy must be EXACT
// ---------------------------------------------------------------------------

describe('illegal-move farming: 2 rejections per turn forever, never a strike', () => {
  it('rejections never consume the turn or strike; the counter resets every turn; the legal move lands', () => {
    const { core, seats, gameId } = makeCore({ variant: { limit: 9 } });
    const [p0, p1] = [seats[0]!, seats[1]!];
    let now = 1_000_100;

    // Three full rounds of p0 farming 2 free illegals, p1 farming 1.
    for (let round = 0; round < 3; round++) {
      const turnBefore = core.turnIndex;

      // p0: attempt 1 — bad notation.
      const r1 = submit(core, gameId, p0, 'zz', (now += 200)) as SubmitReject;
      expect(r1.ok).toBe(false);
      expect(r1.code).toBe('illegal_move');
      expect(r1.illegal_attempt).toBe(1);
      expect(r1.legal_moves).toBeUndefined();
      expect(core.turnIndex).toBe(turnBefore);

      // p0: attempt 2 — out-of-range index; the FULL legal list is restated.
      const r2 = submit(core, gameId, p0, { index: 99 }, (now += 200)) as SubmitReject;
      expect(r2.ok).toBe(false);
      expect(r2.illegal_attempt).toBe(2);
      expect(r2.legal_moves).toHaveLength(2);
      expect(core.turnIndex).toBe(turnBefore);

      // p0: a legal move — applied, unforced, still zero strikes.
      const r3 = submit(core, gameId, p0, { index: 0 }, (now += 200)) as SubmitOk;
      expect(r3.ok).toBe(true);
      expect(r3.applied).toBe(true);
      expect(r3.forced).toBeUndefined();
      expect(core.turnIndex).toBe(turnBefore + 1);

      // p1: one free illegal, then legal — counter is per player per turn.
      const q1 = submit(core, gameId, p1, 'q', (now += 200)) as SubmitReject;
      expect(q1.illegal_attempt).toBe(1); // fresh count: reset happened on turn advance
      const q2 = submit(core, gameId, p1, { index: 1 }, (now += 200)) as SubmitOk;
      expect(q2.ok).toBe(true);
    }

    // Endless free work indeed cost nothing: no strikes, no forced moves.
    expect(core.strikes[P0]).toBe(0);
    expect(core.strikes[P1]).toBe(0);
    expect(strikeEntries(core)).toBe(0);
    expect(core.log.filter((e) => e.kind === 'move' && (e.payload as { forced?: string }).forced !== undefined)).toHaveLength(0);
    expect(core.turnIndex).toBe(6);
    expect(core.status).toBe('running');
  });

  it('the 3rd illegal of a turn is forced random + strike; a draw offer on a forced move does not register', () => {
    const { core, seats, gameId } = makeCore({ variant: { limit: 9 } });
    const p0 = seats[0]!;
    let now = 1_000_100;

    submit(core, gameId, p0, 'zz', (now += 100));
    submit(core, gameId, p0, 'zz', (now += 100));
    const r3 = submit(core, gameId, p0, 'zz', (now += 100), { draw_offer: true }) as SubmitOk;
    expect(r3.ok).toBe(true);
    expect(r3.forced).toBe('illegal');
    expect(core.strikes[P0]).toBe(1);
    // The forced move must not smuggle in the attacker's draw offer.
    expect(core.snapshot().pendingDrawOffer).toBeNull();
    expect(core.log.filter((e) => e.kind === 'draw_offer')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Timeout farming — 2 strikes free, the 3rd must forfeit (always)
// ---------------------------------------------------------------------------

describe('timeout farming: alternate timeout/legal, the third strike forfeits', () => {
  it('two timeout strikes with legal play between are survivable; the third forfeits mid-game', () => {
    const { core, seats, gameId } = makeCore({ variant: { limit: 9 } });
    const p1 = seats[1]!;

    // t0: p0 times out (strike 1).
    expect(core.timeout(core.deadlineAtMs!).fired).toBe(true);
    expect(core.strikes[P0]).toBe(1);
    expect(core.status).toBe('running');
    // t1: p1 legal.
    expect(submit(core, gameId, p1, { index: 0 }, core.deadlineAtMs! - 1_000).ok).toBe(true);
    // t2: p0 times out (strike 2) — still no forfeit.
    expect(core.timeout(core.deadlineAtMs!).fired).toBe(true);
    expect(core.strikes[P0]).toBe(2);
    expect(core.status).toBe('running');
    // t3: p1 legal.
    expect(submit(core, gameId, p1, { index: 0 }, core.deadlineAtMs! - 1_000).ok).toBe(true);
    // t4: p0 times out a third time — forfeit, opponent wins.
    expect(core.timeout(core.deadlineAtMs!).fired).toBe(true);
    expect(core.strikes[P0]).toBe(3);
    expect(core.status).toBe('ended');
    expect(core.result).toMatchObject({ winners: [P1], draw: false, reason: 'forfeit' });
    expect(core.log.some((e) => e.kind === 'forfeit')).toBe(true);
    expect(core.log[core.log.length - 1]!.kind).toBe('reveal');
  });

  it('a third strike earned on the game-ending move must still forfeit, not crown the striker', () => {
    // Adversarial schedule: p0 farms strikes at t0 and t4, then times out on
    // t8 — the 9th applied move, which trips the miniGame turn limit with p0
    // as "last mover". Spec §llm_player_protocol: "Three strikes in a game
    // forfeit it" — a player carrying three strikes must not be declared the
    // winner because their own strike-causing forced move ended the game.
    const { core, seats, gameId } = makeCore({ variant: { limit: 9 } });
    const [p0, p1] = [seats[0]!, seats[1]!];

    expect(core.timeout(core.deadlineAtMs!).fired).toBe(true); // t0: strike 1
    expect(submit(core, gameId, p1, { index: 0 }, core.deadlineAtMs! - 1_000).ok).toBe(true); // t1
    expect(submit(core, gameId, p0, { index: 0 }, core.deadlineAtMs! - 1_000).ok).toBe(true); // t2
    expect(submit(core, gameId, p1, { index: 0 }, core.deadlineAtMs! - 1_000).ok).toBe(true); // t3
    expect(core.timeout(core.deadlineAtMs!).fired).toBe(true); // t4: strike 2
    expect(submit(core, gameId, p1, { index: 0 }, core.deadlineAtMs! - 1_000).ok).toBe(true); // t5
    expect(submit(core, gameId, p0, { index: 0 }, core.deadlineAtMs! - 1_000).ok).toBe(true); // t6
    expect(submit(core, gameId, p1, { index: 0 }, core.deadlineAtMs! - 1_000).ok).toBe(true); // t7
    expect(core.status).toBe('running');
    expect(core.turnIndex).toBe(8);
    expect(core.strikes[P0]).toBe(2);

    // t8: p0's third timeout — strike 3 recorded while the game is running,
    // and the forced default move is the 9th (turn-limit-ending) move.
    expect(core.timeout(core.deadlineAtMs!).fired).toBe(true);
    expect(core.strikes[P0]).toBe(3);
    expect(core.status).toBe('ended');
    // DEFENDED: three strikes forfeit — the opponent wins, not the striker.
    expect(core.result?.winners).toEqual([P1]);
    expect(core.result?.draw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Simultaneous phase: ONE deadline pass resolves ALL absentees
// ---------------------------------------------------------------------------

describe('simultaneous discard: one player submits, two never do', () => {
  it('a single timeout call defaults + strikes BOTH absentees in seat order and advances once', () => {
    const { core, seats, gameId } = makeCore({ game: triGame, nSeats: 3 });
    expect(core.playersToMoveNow().sort()).toEqual([P0, P1, P2]);
    const sharedDeadline = core.deadlineAtMs!;

    // Only p1 submits; p0 and p2 stall forever.
    const held = submit(core, gameId, seats[1]!, { index: 1 }, 1_000_100) as SubmitOk;
    expect(held.ok).toBe(true);
    expect(held.applied).toBe(false);
    expect(held.waiting_for?.sort()).toEqual([P0, P2]);
    expect(core.deadlineAtMs).toBe(sharedDeadline); // ONE shared deadline, unchanged

    const res = core.timeout(sharedDeadline);
    expect(res.fired).toBe(true);

    // ALL absentees resolved in this one pass: defaults + strikes for p0, p2.
    expect(core.turnIndex).toBe(1);
    expect(core.strikes[P0]).toBe(1);
    expect(core.strikes[P1]).toBe(0);
    expect(core.strikes[P2]).toBe(1);

    const timeouts = core.log.filter((e) => e.kind === 'timeout');
    expect(timeouts).toHaveLength(2);
    expect(timeouts.map((e) => (e.payload as { player: string }).player)).toEqual([P0, P2]); // seat order
    expect(timeouts.every((e) => (e.payload as { turn_index: number }).turn_index === 0)).toBe(true);
    expect(core.log.filter((e) => e.kind === 'move')).toHaveLength(1); // p1's held move
    expect(strikeEntries(core)).toBe(2);

    // The phase resolved exactly once and the next deadline is fresh.
    expect(core.status).toBe('running');
    expect(core.deadlineAtMs).toBe(sharedDeadline + 60_000);

    // Idempotency: replaying the same alarm time is a no-op.
    const again = core.timeout(sharedDeadline);
    expect(again.fired).toBe(false);
    expect(core.strikes[P0]).toBe(1);
    expect(core.strikes[P2]).toBe(1);
    expect(core.log.filter((e) => e.kind === 'timeout')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Draw-offer spam
// ---------------------------------------------------------------------------

describe('draw-offer spam', () => {
  it('spamming an offer every turn keeps exactly one pending slot and never auto-draws', () => {
    const { core, seats, gameId } = makeCore({ variant: { limit: 9 } });
    const [p0, p1] = [seats[0]!, seats[1]!];
    let now = 1_000_100;

    for (let round = 0; round < 4; round++) {
      const turn = core.turnIndex;
      expect(submit(core, gameId, p0, { index: 0 }, (now += 500), { draw_offer: true }).ok).toBe(true);
      const pending = core.snapshot().pendingDrawOffer;
      expect(pending).toEqual({ by: P0, validAtTurn: turn + 1 }); // exactly one slot, correct window
      // p1 declines by playing a normal move; the offer must expire NOW.
      expect(submit(core, gameId, p1, { index: 0 }, (now += 500)).ok).toBe(true);
      expect(core.snapshot().pendingDrawOffer).toBeNull();
    }

    // 4 offers logged, zero accepts, the game just ran its course.
    expect(core.log.filter((e) => e.kind === 'draw_offer')).toHaveLength(4);
    expect(core.log.filter((e) => e.kind === 'draw_accept')).toHaveLength(0);
    // 8 moves played; the 9th ends by turn limit, not by any phantom draw.
    expect(submit(core, gameId, p0, { index: 0 }, (now += 500)).ok).toBe(true);
    expect(core.status).toBe('ended');
    expect(core.result?.draw).toBe(false);
    expect(core.result?.reason).toBe('turn_limit');
  });

  it('a stale offer cannot be accepted two turns later; a late draw_offer is a NEW offer', () => {
    const { core, seats, gameId } = makeCore({ variant: { limit: 9 } });
    const [p0, p1] = [seats[0]!, seats[1]!];
    let now = 1_000_100;

    // t0: p0 offers. t1: p1 declines (normal move) -> expired.
    expect(submit(core, gameId, p0, { index: 0 }, (now += 500), { draw_offer: true }).ok).toBe(true);
    expect(submit(core, gameId, p1, { index: 0 }, (now += 500)).ok).toBe(true);
    expect(core.snapshot().pendingDrawOffer).toBeNull();

    // t2: p0 normal. t3: p1 sends draw_offer=true — must NOT resurrect p0's
    // dead offer into an agreement; it is a fresh offer by p1.
    expect(submit(core, gameId, p0, { index: 0 }, (now += 500)).ok).toBe(true);
    expect(submit(core, gameId, p1, { index: 0 }, (now += 500), { draw_offer: true }).ok).toBe(true);
    expect(core.status).toBe('running');
    expect(core.snapshot().pendingDrawOffer).toEqual({ by: P1, validAtTurn: 4 });
    expect(core.log.filter((e) => e.kind === 'draw_accept')).toHaveLength(0);

    // t4: p0 declines -> expired again. t5: p1 offers. t6: p0 accepts in-window.
    expect(submit(core, gameId, p0, { index: 0 }, (now += 500)).ok).toBe(true);
    expect(core.snapshot().pendingDrawOffer).toBeNull();
    expect(submit(core, gameId, p1, { index: 0 }, (now += 500), { draw_offer: true }).ok).toBe(true);
    expect(submit(core, gameId, p0, { index: 0 }, (now += 500), { draw_offer: true }).ok).toBe(true);
    expect(core.status).toBe('ended');
    expect(core.result).toMatchObject({ winners: [], draw: true, reason: 'agreement' });
    expect(core.log.filter((e) => e.kind === 'draw_accept')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Resignation off-turn + nothing lands after the end
// ---------------------------------------------------------------------------

describe('resignation and post-end submissions', () => {
  it('resigning during the opponent turn is honored and loses for the resigner', () => {
    const { core, seats, gameId } = makeCore();
    // p0 is to move; p1 resigns anyway.
    const r = submit(core, gameId, seats[1]!, { index: 0 }, 1_000_100, { resign: true });
    expect(r.ok).toBe(true);
    expect(core.status).toBe('ended');
    expect(core.result).toMatchObject({ winners: [P0], draw: false, reason: 'resignation' });
    const entry = core.log.find((e) => e.kind === 'resign')!;
    expect((entry.payload as { player: string }).player).toBe(P1);
    expect(entry.signature).not.toBeNull();
  });

  it('after the end: moves, resigns, draw offers and timeouts are all inert', () => {
    const { core, seats, gameId } = makeCore(); // limit 5
    let now = 1_000_100;
    while (core.status === 'running') {
      const mover = core.playersToMoveNow()[0]!;
      const seat = seats.find((s) => s.seat.player === mover)!;
      expect(submit(core, gameId, seat, { index: 0 }, (now += 500)).ok).toBe(true);
    }
    const logLen = core.log.length;
    const evLen = core.eventsSince(0).length;
    const finalResult = JSON.stringify(core.result);

    for (const extra of [undefined, { resign: true }, { draw_offer: true }] as const) {
      for (const seat of seats) {
        const r = submit(core, gameId, seat, { index: 0 }, (now += 500), extra) as SubmitReject;
        expect(r.ok).toBe(false);
        expect(r.code).toBe('room_ended');
      }
    }
    expect(core.timeout((now += 60_000)).fired).toBe(false);

    // Nothing was appended, emitted, or rewritten.
    expect(core.log.length).toBe(logLen);
    expect(core.eventsSince(0).length).toBe(evLen);
    expect(JSON.stringify(core.result)).toBe(finalResult);
    expect(core.log[core.log.length - 1]!.kind).toBe('reveal');
  });
});
