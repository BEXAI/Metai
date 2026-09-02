/**
 * RED TEAM red-team-liveness — attack family 2: clock integrity.
 *
 * Targets src/rooms/core.ts:
 *   - cumulative clock exhaustion (spec §games.chess.clock: "60 s per move,
 *     40 min per side cumulative") must forfeit mid-game — burning 59.9 s
 *     per move forever must not be free;
 *   - a move arriving AFTER its deadline (delayed DO alarm) must not be
 *     accepted as a clean move (view_object.deadline_utc: "ISO time by which
 *     the move must arrive");
 *   - deadlines anchor to the LAST event (move applied / timeout fired), no
 *     wall drift;
 *   - timeout() fires exactly once per deadline even under alarm retries;
 *   - cumulative bookkeeping accrues from event times.
 *
 * Seeded randomness only (createSeedStream); deterministic sha256 keys.
 */

import { describe, expect, it } from 'vitest';
import chess from '../../src/games/chess/index.ts';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { signEd25519 } from '../../src/crypto/ed25519.ts';
import { publicKeyOf } from '../../src/identity/ed25519.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import { playerId, type MoveSubmission, type VariantConfig } from '../../src/kernel/types.ts';
import { moveSignMessage, RoomCore, type RoomSeat } from '../../src/rooms/core.ts';
import { miniGame, P0, P1 } from '../../src/rooms/tests/mini-game.ts';

const SECRET = '44'.repeat(32);
const DRAND = 'ba'.repeat(32);

interface Seat {
  seat: RoomSeat;
  secretKey: string;
}

function makeSeat(i: number): Seat {
  const secretKey = sha256Hex(`redteam-liveness:clocks:seat:${i}`);
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
  gameId?: string;
}): { core: RoomCore; seats: Seat[]; gameId: string } {
  const seats = [makeSeat(0), makeSeat(1)];
  const gameId = opts?.gameId ?? 'rt-liveness-clocks';
  const core = RoomCore.create(1_000_000, {
    gameId,
    game: opts?.game ?? miniGame,
    variant: opts?.variant ?? {},
    seats: seats.map((s) => s.seat),
    division: 'open',
    rulesetVersion: '1.0.0',
    secretHex: SECRET,
    drandRound: 778,
    drandRandomnessHex: DRAND,
    perMoveMs: 60_000, // the spec chess move clock
    clockScale: 1,
  });
  return { core, seats, gameId };
}

function submit(core: RoomCore, gameId: string, seat: Seat, move: MoveSubmission['move'], nowMs: number) {
  const submission: MoveSubmission = { game_id: gameId, turn_index: core.turnIndex, move };
  const signature = signEd25519(seat.secretKey, moveSignMessage(gameId, core.turnIndex, submission));
  return core.submitMove(nowMs, seat.seat.agent_id, submission, signature);
}

// ---------------------------------------------------------------------------
// 1. Cumulative clock exhaustion — chess: 60 s/move, 40 min/side cumulative
// ---------------------------------------------------------------------------

describe('cumulative clock (spec games.chess.clock: "60 s per move, 40 min per side cumulative")', () => {
  it(
    'a player burning 59.9 s on every move must flag once past 40 min cumulative',
    () => {
      // p0 stays under the per-move clock on every single move but blows the
      // 40-minute side budget on move 41 (41 x 59.9 s = 40.93 min). Moves are
      // seeded-random legal chess (verified alive well past ply 84 for this
      // pick stream). DEFENDED: the game ends with p0 losing on time at or
      // before ply 84. Today RoomCore tracks cumulativeMs but enforces no
      // budget, so the loop runs out with the game still 'running'.
      const { core, seats, gameId } = makeCore({ game: chess, gameId: 'rt-liveness-chess-clock' });
      const pick = createSeedStream(sha256Hex('redteam-liveness:pick:a'));
      const bySeat = new Map(seats.map((s) => [s.seat.player, s]));

      let now = 1_000_000;
      let plies = 0;
      let iterations = 0;
      while (core.status === 'running' && plies < 84 && iterations < 300) {
        iterations++;
        const mover = core.playersToMoveNow()[0]!;
        const think = mover === P0 ? 59_900 : 100;
        const deadline = core.deadlineAtMs!;
        if (now + think >= deadline) {
          // Post-fix path: the room shrank the deadline to the remaining side
          // budget — let the clock fall instead of submitting late.
          now = Math.max(now + think, deadline);
          core.timeout(now);
          continue;
        }
        now += think;
        const legalCount = core.viewFor(mover, now).legal_moves.length;
        const idx = pick.int(`pick:${plies}`, legalCount);
        const r = submit(core, gameId, bySeat.get(mover)!, { index: idx }, now);
        if (r.ok) {
          plies++;
        } else {
          // Post-fix path: the room refuses the over-budget move; resolve via
          // the clock and keep going until the forfeit lands.
          core.timeout(now);
        }
      }

      // p0 consumed far more than the 40-minute side budget by ply 81.
      expect(core.clocks.cumulativeMs[P0] ?? 0).toBeGreaterThan(40 * 60_000);
      // DEFENDED: the game must have ended with p0 losing on time.
      expect(core.status).toBe('ended');
      expect(core.result?.draw).toBe(false);
      expect(core.result?.winners).toEqual([P1]);
    },
    { timeout: 600_000 },
  );

  it('cumulative bookkeeping accrues exactly the thinking time from event times', () => {
    const { core, seats, gameId } = makeCore(); // miniGame
    // p0 thinks 10 s, p1 thinks 20 s, p0 thinks 5 s.
    expect(submit(core, gameId, seats[0]!, { index: 0 }, 1_010_000).ok).toBe(true);
    expect(submit(core, gameId, seats[1]!, { index: 0 }, 1_030_000).ok).toBe(true);
    expect(submit(core, gameId, seats[0]!, { index: 0 }, 1_035_000).ok).toBe(true);
    expect(core.clocks.cumulativeMs[P0]).toBe(15_000);
    expect(core.clocks.cumulativeMs[P1]).toBe(20_000);
  });

  it('a timeout charges the turn budget, not the alarm latency', () => {
    const { core } = makeCore();
    const deadline = core.deadlineAtMs!;
    // The alarm fires 30 s late; p0 must be charged 60 s (the budget), not 90.
    expect(core.timeout(deadline + 30_000).fired).toBe(true);
    expect(core.clocks.cumulativeMs[P0]).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// 2. Late move acceptance — the deadline must mean something
// ---------------------------------------------------------------------------

describe('late move acceptance (delayed alarm race)', () => {
  it('a move arriving a full minute after the deadline must not land as a clean unforced move', () => {
    // In production the DO alarm calls timeout() at the deadline, but alarms
    // are at-least-once and can be delayed. RoomCore.submitMove never checks
    // deadlineAtMs, so during that window a stalling agent gets unbounded
    // extra thinking time with no strike. DEFENDED: a submission at
    // deadline + 60 s is not recorded as the player's own clean move for the
    // expired turn (it is either rejected or the timeout resolves first).
    const { core, seats, gameId } = makeCore({ variant: { limit: 9 } });
    const deadline = core.deadlineAtMs!;

    submit(core, gameId, seats[0]!, { index: 0 }, deadline + 60_000);

    const cleanTurn0Move = core.log.find(
      (e) =>
        e.kind === 'move' &&
        (e.payload as { turn_index: number }).turn_index === 0 &&
        (e.payload as { player: string }).player === P0 &&
        (e.payload as { forced?: string }).forced === undefined,
    );
    expect(cleanTurn0Move, 'a move 60s past the deadline was accepted as a clean move with no strike').toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Deadline anchoring — last event, not wall drift
// ---------------------------------------------------------------------------

describe('deadline anchoring', () => {
  it('every new deadline = the anchoring event time + budget (moves and late alarms alike)', () => {
    const { core, seats, gameId } = makeCore({ variant: { limit: 9 } });
    expect(core.deadlineAtMs).toBe(1_000_000 + 60_000); // creation anchors turn 0

    // p0 moves 5 s in: turn 1 deadline anchors to the move event.
    expect(submit(core, gameId, seats[0]!, { index: 0 }, 1_005_000).ok).toBe(true);
    expect(core.deadlineAtMs).toBe(1_005_000 + 60_000);

    // p1 stalls; the alarm fires 30 s late. Turn 2 anchors to the firing
    // event — the late alarm must not silently shrink (drift) the next turn.
    const d1 = core.deadlineAtMs!;
    expect(core.timeout(d1 + 30_000).fired).toBe(true);
    expect(core.turnIndex).toBe(2);
    expect(core.deadlineAtMs).toBe(d1 + 30_000 + 60_000);
  });

  it('timeout() fires exactly once per deadline under alarm retries', () => {
    const { core } = makeCore({ variant: { limit: 9 } });
    const d0 = core.deadlineAtMs!;

    expect(core.timeout(d0 - 1).fired).toBe(false); // early alarm: no-op
    expect(core.timeout(d0).fired).toBe(true); // fires exactly at the deadline
    expect(core.strikes[P0]).toBe(1);

    // Duplicate alarm deliveries at and just after the original deadline.
    expect(core.timeout(d0).fired).toBe(false);
    expect(core.timeout(d0 + 1_000).fired).toBe(false);
    expect(core.timeout(d0 + 59_999).fired).toBe(false);

    // Still exactly one timeout entry and one strike; the turn advanced once.
    expect(core.log.filter((e) => e.kind === 'timeout')).toHaveLength(1);
    expect(core.log.filter((e) => e.kind === 'strike')).toHaveLength(1);
    expect(core.strikes[P0]).toBe(1);
    expect(core.strikes[P1]).toBe(0);
    expect(core.turnIndex).toBe(1);

    // The NEXT deadline passing is a genuine second firing (p1's turn).
    expect(core.timeout(core.deadlineAtMs!).fired).toBe(true);
    expect(core.strikes[P1]).toBe(1);
    expect(core.turnIndex).toBe(2);
  });
});
