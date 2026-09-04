/**
 * RoomCore tests: happy path + replay chain (A8/A11), the frozen three-step
 * illegal-move policy, timeouts/defaultMove/strikes/forfeit, resignation,
 * draw offer/accept, simultaneous-phase collection under one deadline, the
 * A10 spectator-leakage probe, protocol rejections, and snapshot/hydration.
 * All crypto is real (Ed25519 keys, hash chain, commit-reveal).
 *
 * The final block covers the optional engine hooks (non-terminal elimination,
 * phase budgets, the history window, the resign/draw gates and the end-of-game
 * disclosure). Every assertion there is written as an octoGame/octoGameBare
 * PAIR: the same test that proves a hook works also proves a game without it
 * behaves exactly as it did before the hook existed.
 */

import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../crypto/canonical.ts';
import { verifyChain } from '../../crypto/chain.ts';
import { deriveFinalSeed, verifyCommitment } from '../../crypto/commit.ts';
import { generateKeypair, signEd25519, verifyEd25519 } from '../../crypto/ed25519.ts';
import { playerId, type AnyGame, type Json, type MoveSubmission, type PlayerId, type VariantConfig } from '../../kernel/types.ts';
import { verifyReplay } from '../../kernel/verify.ts';
import { moveSignMessage, RoomCore, type RoomSeat, type SubmitOk, type SubmitReject } from '../core.ts';
import { miniGame, miniGameNoDefault, P0, P1, secretProbe } from './mini-game.ts';
import { octoGame, octoGameBare, octoSecretProbe } from './octo-game.ts';

const SECRET = '11'.repeat(32);
const DRAND = 'ab'.repeat(32);
const DRAND_ROUND = 4242;

interface Seat {
  seat: RoomSeat;
  secretKey: string;
}

function makeSeats(): Seat[] {
  return [P0, P1].map((player, i) => {
    const kp = generateKeypair();
    return {
      seat: {
        player,
        agent_id: `agent-${i}`,
        handle: `Agent${i}`,
        pubkey_ed25519: kp.publicKeyHex,
      },
      secretKey: kp.secretKeyHex,
    };
  });
}

function makeCore(opts?: {
  variant?: VariantConfig;
  game?: typeof miniGame;
  seats?: Seat[];
  nowMs?: number;
  perMoveMs?: number;
  clockScale?: number;
}): { core: RoomCore; seats: Seat[]; gameId: string } {
  const seats = opts?.seats ?? makeSeats();
  const gameId = 'game-test-1';
  const core = RoomCore.create(opts?.nowMs ?? 1_000_000, {
    gameId,
    game: opts?.game ?? miniGame,
    variant: opts?.variant ?? {},
    seats: seats.map((s) => s.seat),
    division: 'open',
    rulesetVersion: '1.0.0',
    secretHex: SECRET,
    drandRound: DRAND_ROUND,
    drandRandomnessHex: DRAND,
    perMoveMs: opts?.perMoveMs ?? 60_000,
    clockScale: opts?.clockScale ?? 1,
  });
  return { core, seats, gameId };
}

function signed(
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

function submit(
  core: RoomCore,
  gameId: string,
  seat: Seat,
  move: MoveSubmission['move'],
  nowMs: number,
  extra?: Partial<MoveSubmission>,
) {
  const { submission, signature } = signed(gameId, seat, core.turnIndex, move, extra);
  return core.submitMove(nowMs, seat.seat.agent_id, submission, signature);
}

describe('RoomCore happy path (A11 index answers + A8 commit/reveal + chain)', () => {
  it('plays a full 5-move game and produces a verifiable replay', () => {
    const { core, seats, gameId } = makeCore();
    expect(core.log[0]!.kind).toBe('commitment');
    expect(core.log[1]!.kind).toBe('start');

    let now = 1_000_100;
    // Alternate: notation, index, #index-fallback, index, notation.
    const moves: MoveSubmission['move'][] = ['a', { index: 1 }, '#0', { index: 0 }, 'b'];
    for (let i = 0; i < 5; i++) {
      const seat = seats[i % 2]!;
      const res = submit(core, gameId, seat, moves[i]!, (now += 500));
      expect(res.ok, JSON.stringify(res)).toBe(true);
      expect((res as SubmitOk).applied).toBe(true);
    }

    expect(core.status).toBe('ended');
    expect(core.result?.reason).toBe('turn_limit');
    expect(core.result?.winners).toEqual([P0]); // p0 played moves 0, 2, 4

    const replay = core.replayFile();
    expect(replay).not.toBeNull();
    expect(replay!.version).toBe('ludus.replay.v1');
    expect(replay!.log[replay!.log.length - 2]!.kind).toBe('end');
    expect(replay!.log[replay!.log.length - 1]!.kind).toBe('reveal');

    // Hash chain verifies end to end (T2 crypto).
    expect(verifyChain(gameId, replay!.log).ok).toBe(true);

    // Commit-reveal verifies and the final seed is recomputable.
    expect(verifyCommitment(gameId, replay!.reveal_secret, replay!.commitment)).toBe(true);
    expect(deriveFinalSeed(gameId, replay!.reveal_secret, replay!.drand_randomness)).toBe(replay!.final_seed);

    // Every move entry's Ed25519 signature verifies over the frozen message.
    for (const entry of replay!.log) {
      if (entry.kind !== 'move') continue;
      const payload = entry.payload as { turn_index: number; player: PlayerId; submission: Json };
      const seat = seats.find((s) => s.seat.player === payload.player)!;
      const msg = moveSignMessage(gameId, payload.turn_index, payload.submission as unknown as MoveSubmission);
      expect(verifyEd25519(seat.seat.pubkey_ed25519, msg, entry.signature!)).toBe(true);
    }

    // Every applied move recorded its d6 roll in the entry's draws delta.
    const moveEntries = replay!.log.filter((e) => e.kind === 'move');
    expect(moveEntries).toHaveLength(5);
    for (const e of moveEntries) {
      const draws = (e.payload as { draws: { purpose: string }[] }).draws;
      expect(draws.some((d) => d.purpose.startsWith('roll:turn:'))).toBe(true);
    }

    // Tampering with any payload byte breaks chain verification (A8 half).
    const tampered = replay!.log.map((e) => ({ ...e }));
    tampered[2] = { ...tampered[2]!, payload: { ...(tampered[2]!.payload as object), evil: true } as Json };
    expect(verifyChain(gameId, tampered).ok).toBe(false);
  });
});

describe('illegal-move three-step policy (A11)', () => {
  it('rejects, restates the legal list, then forces a seeded random move + strike', () => {
    const { core, seats, gameId } = makeCore();
    const p0 = seats[0]!;

    // 1st illegal (bad notation): rejected with reason, turn NOT consumed.
    const r1 = submit(core, gameId, p0, 'z', 1_000_100) as SubmitReject;
    expect(r1.ok).toBe(false);
    expect(r1.code).toBe('illegal_move');
    expect(r1.illegal_attempt).toBe(1);
    expect(r1.legal_moves).toBeUndefined();
    expect(core.turnIndex).toBe(0);

    // 2nd illegal (out-of-range index): rejected with the FULL legal list.
    const r2 = submit(core, gameId, p0, { index: 99 }, 1_000_200) as SubmitReject;
    expect(r2.ok).toBe(false);
    expect(r2.illegal_attempt).toBe(2);
    expect(r2.legal_moves).toHaveLength(2);
    expect(r2.legal_moves![0]).toMatchObject({ index: 0, notation: 'a' });
    expect(core.turnIndex).toBe(0);

    // 3rd illegal: a seeded random legal move is applied + a strike recorded.
    const r3 = submit(core, gameId, p0, 'nonsense', 1_000_300);
    expect(r3.ok).toBe(true);
    const ok3 = r3 as SubmitOk;
    expect(ok3.forced).toBe('illegal');
    expect(ok3.applied).toBe(true);
    expect(core.turnIndex).toBe(1);
    expect(core.strikes[P0]).toBe(1);

    const log = core.log;
    const forcedMove = log.find((e) => e.kind === 'move')!;
    expect((forcedMove.payload as { forced?: string }).forced).toBe('illegal');
    const strike = log.find((e) => e.kind === 'strike')!;
    expect(strike.payload).toMatchObject({ player: P0, reason: 'illegal_move', strike_count: 1 });

    // The forced pick used the frozen purpose.
    const draws = core.snapshot().seedDraws;
    expect(draws.some((d) => d.purpose === 'illegal:turn:0')).toBe(true);

    // Counter resets next turn: one illegal by p1 is attempt 1 again.
    const p1 = seats[1]!;
    const r4 = submit(core, gameId, p1, 'q', 1_000_400) as SubmitReject;
    expect(r4.illegal_attempt).toBe(1);
  });
});

describe('timeouts, defaultMove, strikes, forfeit (A11)', () => {
  it('applies the defaultMove on timeout and records a strike', () => {
    const { core } = makeCore(); // miniGame HAS defaultMove -> 'a'
    const deadline = core.deadlineAtMs!;
    expect(core.timeout(deadline - 1).fired).toBe(false);

    const res = core.timeout(deadline);
    expect(res.fired).toBe(true);
    expect(core.turnIndex).toBe(1);
    expect(core.strikes[P0]).toBe(1);
    const t = core.log.find((e) => e.kind === 'timeout')!;
    expect(t.payload).toMatchObject({ turn_index: 0, player: P0, applied_notation: 'a', strike_count: 1 });
    // defaultMove used: no 'timeout:turn:0' seed draw.
    expect(core.snapshot().seedDraws.some((d) => d.purpose === 'timeout:turn:0')).toBe(false);
  });

  it('applies a seeded random legal move when the game has no defaultMove', () => {
    const { core } = makeCore({ game: miniGameNoDefault });
    core.timeout(core.deadlineAtMs!);
    expect(core.turnIndex).toBe(1);
    expect(core.snapshot().seedDraws.some((d) => d.purpose === 'timeout:turn:0')).toBe(true);
  });

  it('forfeits the game on the third strike', () => {
    const { core, seats, gameId } = makeCore({ variant: { limit: 9 } });
    const p1 = seats[1]!;
    let now = 1_000_000;

    // p0 times out; p1 plays; repeat until p0 has 3 strikes.
    for (let round = 0; round < 3; round++) {
      now = core.deadlineAtMs!;
      const t = core.timeout(now);
      expect(t.fired).toBe(true);
      if (core.status === 'ended') break;
      const r = submit(core, gameId, p1, { index: 0 }, now + 10);
      expect(r.ok).toBe(true);
    }

    expect(core.status).toBe('ended');
    expect(core.strikes[P0]).toBe(3);
    expect(core.result).toMatchObject({ winners: [P1], draw: false, reason: 'forfeit' });
    expect(core.log.some((e) => e.kind === 'forfeit')).toBe(true);
    // Full end sequence still present after a forfeit.
    expect(core.log[core.log.length - 1]!.kind).toBe('reveal');
    expect(verifyChain(gameId, core.log.slice()).ok).toBe(true);
  });
});

describe('resignation and draw offer/accept', () => {
  it('resignation is a signed log entry that ends the game', () => {
    const { core, seats, gameId } = makeCore();
    const res = submit(core, gameId, seats[0]!, { index: 0 }, 1_000_100, { resign: true });
    expect(res.ok).toBe(true);
    expect(core.status).toBe('ended');
    expect(core.result).toMatchObject({ winners: [P1], draw: false, reason: 'resignation' });
    const entry = core.log.find((e) => e.kind === 'resign')!;
    expect(entry.signature).not.toBeNull();
  });

  it('a draw offer is valid for exactly the opponent turn that follows', () => {
    const { core, seats, gameId } = makeCore();
    const [p0, p1] = [seats[0]!, seats[1]!];

    // p0 offers a draw with the move; p1 accepts on their turn.
    expect(submit(core, gameId, p0, { index: 0 }, 1_000_100, { draw_offer: true }).ok).toBe(true);
    expect(core.log.some((e) => e.kind === 'draw_offer')).toBe(true);
    const accept = submit(core, gameId, p1, { index: 0 }, 1_000_200, { draw_offer: true });
    expect(accept.ok).toBe(true);
    expect(core.status).toBe('ended');
    expect(core.result).toMatchObject({ winners: [], draw: true, reason: 'agreement' });
    expect(core.log.some((e) => e.kind === 'draw_accept')).toBe(true);
  });

  it('an unanswered offer expires after the opponent turn', () => {
    const { core, seats, gameId } = makeCore({ variant: { limit: 9 } });
    const [p0, p1] = [seats[0]!, seats[1]!];

    expect(submit(core, gameId, p0, { index: 0 }, 1_000_100, { draw_offer: true }).ok).toBe(true);
    // p1 plays a normal move -> the offer expires.
    expect(submit(core, gameId, p1, { index: 0 }, 1_000_200).ok).toBe(true);
    // p0 plays; then p1 sends draw_offer=true -> that is a NEW offer, not an accept.
    expect(submit(core, gameId, p0, { index: 0 }, 1_000_300).ok).toBe(true);
    const r = submit(core, gameId, p1, { index: 0 }, 1_000_400, { draw_offer: true });
    expect(r.ok).toBe(true);
    expect(core.status).toBe('running'); // no agreement happened
    expect(core.log.filter((e) => e.kind === 'draw_offer')).toHaveLength(2);
    expect(core.log.some((e) => e.kind === 'draw_accept')).toBe(false);
  });
});

describe('simultaneous phase: one shared deadline, one submission per mover', () => {
  it('collects both submissions, resolves in seat order, keeps ONE deadline', () => {
    const { core, seats, gameId } = makeCore({ variant: { simultaneous: true } });
    expect(core.playersToMoveNow().sort()).toEqual([P0, P1]);
    const sharedDeadline = core.deadlineAtMs;

    // p1 submits first: held, not applied; deadline unchanged.
    const r1 = submit(core, gameId, seats[1]!, { index: 1 }, 1_000_100) as SubmitOk;
    expect(r1.ok).toBe(true);
    expect(r1.applied).toBe(false);
    expect(r1.waiting_for).toEqual([P0]);
    expect(core.deadlineAtMs).toBe(sharedDeadline);
    expect(core.turnIndex).toBe(0);

    // Double submission is rejected: a turn accepts exactly one move.
    const dup = submit(core, gameId, seats[1]!, { index: 0 }, 1_000_150) as SubmitReject;
    expect(dup.code).toBe('already_submitted');

    // p0 submits: the phase resolves, both moves apply in seat order.
    const r2 = submit(core, gameId, seats[0]!, { index: 0 }, 1_000_200) as SubmitOk;
    expect(r2.ok).toBe(true);
    expect(r2.applied).toBe(true);
    expect(core.turnIndex).toBe(1);

    const moveEntries = core.log.filter((e) => e.kind === 'move');
    expect(moveEntries).toHaveLength(2);
    expect(moveEntries.map((e) => (e.payload as { player: string }).player)).toEqual([P0, P1]); // seat order
    expect(moveEntries.every((e) => (e.payload as { turn_index: number }).turn_index === 0)).toBe(true);
  });

  it('forces defaults for missing movers when the shared deadline passes', () => {
    const { core, seats, gameId } = makeCore({ variant: { simultaneous: true } });
    // Only p1 submits.
    expect((submit(core, gameId, seats[1]!, { index: 1 }, 1_000_100) as SubmitOk).applied).toBe(false);

    const res = core.timeout(core.deadlineAtMs!);
    expect(res.fired).toBe(true);
    expect(core.turnIndex).toBe(1);
    expect(core.strikes[P0]).toBe(1);
    expect(core.strikes[P1]).toBe(0);

    const kinds = core.log.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'timeout')).toHaveLength(1); // p0 forced
    expect(kinds.filter((k) => k === 'move')).toHaveLength(1); //    p1's held move
    const t = core.log.find((e) => e.kind === 'timeout')!;
    expect(t.payload).toMatchObject({ turn_index: 0, player: P0, applied_notation: 'a' });
  });
});

describe('spectator events never leak hidden state before the end (A10)', () => {
  it('no probe string appears in any pre-end event; the reveal only follows the end', () => {
    const { core, seats, gameId } = makeCore({ variant: { simultaneous: true } });
    let now = 1_000_100;
    // Simultaneous first turn, then sequential to the 5-move end.
    submit(core, gameId, seats[0]!, { index: 0 }, (now += 100));
    submit(core, gameId, seats[1]!, { index: 1 }, (now += 100));
    while (core.status === 'running') {
      const mover = core.playersToMoveNow()[0]!;
      const seat = seats.find((s) => s.seat.player === mover)!;
      const r = submit(core, gameId, seat, { index: 0 }, (now += 100), {
        commentary: 'gg so far',
      });
      expect(r.ok).toBe(true);
    }

    const events = core.eventsSince(0);
    const endIdx = events.findIndex((e) => e.type === 'end');
    expect(endIdx).toBeGreaterThan(0);
    const preEnd = events.slice(0, endIdx);
    const blob = JSON.stringify(preEnd);
    for (const p of [P0, P1]) {
      expect(blob).not.toContain(secretProbe(p));
    }
    // Sanity: the probes DO exist in the players' private views.
    const snap = core.snapshot();
    const turns = Object.keys(snap.privateViewsByTurn).map(Number);
    const latest = snap.privateViewsByTurn[String(Math.max(...turns))]!;
    expect(JSON.stringify(latest[P0])).toContain(secretProbe(P0));

    // The reveal event exists but only after 'end'.
    const revealIdx = events.findIndex((e) => e.type === 'reveal');
    expect(revealIdx).toBeGreaterThan(endIdx);
  });
});

describe('protocol rejections (signature, turn, seat, commentary)', () => {
  it('rejects bad signatures, wrong turn indexes, unknown agents, out-of-turn moves, and oversized commentary', () => {
    const { core, seats, gameId } = makeCore();
    const [p0, p1] = [seats[0]!, seats[1]!];

    // Signature by the WRONG key.
    const sub = { game_id: gameId, turn_index: 0, move: { index: 0 } } as MoveSubmission;
    const wrongSig = signEd25519(p1.secretKey, moveSignMessage(gameId, 0, sub));
    expect(core.submitMove(1_000_100, p0.seat.agent_id, sub, wrongSig)).toMatchObject({ ok: false, code: 'bad_signature' });

    // Wrong turn index (signature valid over its own body).
    const { submission: s2, signature: g2 } = signed(gameId, p0, 7, { index: 0 });
    expect(core.submitMove(1_000_100, p0.seat.agent_id, s2, g2)).toMatchObject({ ok: false, code: 'wrong_turn' });

    // Unknown agent.
    expect(core.submitMove(1_000_100, 'nobody', sub, wrongSig)).toMatchObject({ ok: false, code: 'unknown_agent' });

    // Not this player's turn.
    const r = submit(core, gameId, p1, { index: 0 }, 1_000_100);
    expect(r).toMatchObject({ ok: false, code: 'not_your_turn' });

    // Commentary over 280 chars.
    const r2 = submit(core, gameId, p0, { index: 0 }, 1_000_100, { commentary: 'x'.repeat(281) });
    expect(r2).toMatchObject({ ok: false, code: 'bad_commentary' });

    // None of that consumed the turn or polluted the chain.
    expect(core.turnIndex).toBe(0);
    expect(core.log.filter((e) => e.kind === 'move')).toHaveLength(0);
  });
});

describe('snapshot + hydration (seed fast-forward)', () => {
  it('a mid-game snapshot rehydrates and finishes with a verifiable replay', () => {
    const { core, seats, gameId } = makeCore();
    submit(core, gameId, seats[0]!, 'a', 1_000_100);
    submit(core, gameId, seats[1]!, { index: 1 }, 1_000_200);

    const json = JSON.stringify(core.snapshot());
    const revived = RoomCore.hydrate(miniGame, JSON.parse(json));
    expect(revived.turnIndex).toBe(2);

    let now = 1_000_300;
    while (revived.status === 'running') {
      const mover = revived.playersToMoveNow()[0]!;
      const seat = seats.find((s) => s.seat.player === mover)!;
      const { submission, signature } = signed(gameId, seat, revived.turnIndex, { index: 0 });
      const r = revived.submitMove((now += 100), seat.seat.agent_id, submission, signature);
      expect(r.ok).toBe(true);
    }

    const replay = revived.replayFile()!;
    expect(verifyChain(gameId, replay.log).ok).toBe(true);
    expect(replay.log.filter((e) => e.kind === 'move')).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Optional engine hooks (octoGame / octoGameBare pairs)
// ---------------------------------------------------------------------------

const OCTO_GAME_ID = 'game-octo-1';

function makeOctoSeats(n: number): Seat[] {
  return Array.from({ length: n }, (_, i) => {
    const kp = generateKeypair();
    return {
      seat: {
        player: playerId(i),
        agent_id: `octo-agent-${i}`,
        handle: `Octo${i}`,
        pubkey_ed25519: kp.publicKeyHex,
      },
      secretKey: kp.secretKeyHex,
    };
  });
}

function makeOcto(opts?: {
  game?: AnyGame;
  variant?: VariantConfig;
  seats?: Seat[];
  perMoveMs?: number;
  perSideMs?: number | null;
  nowMs?: number;
}): { core: RoomCore; seats: Seat[]; gameId: string; seatOf: (p: PlayerId) => Seat } {
  const seats = opts?.seats ?? makeOctoSeats(4);
  const core = RoomCore.create(opts?.nowMs ?? 1_000_000, {
    gameId: OCTO_GAME_ID,
    game: opts?.game ?? octoGame,
    variant: opts?.variant ?? {},
    seats: seats.map((s) => s.seat),
    division: 'open',
    rulesetVersion: '1.0.0',
    secretHex: SECRET,
    drandRound: DRAND_ROUND,
    drandRandomnessHex: DRAND,
    perMoveMs: opts?.perMoveMs ?? 60_000,
    ...(opts?.perSideMs !== undefined ? { perSideMs: opts.perSideMs } : {}),
    clockScale: 1,
  });
  const seatOf = (p: PlayerId): Seat => seats.find((s) => s.seat.player === p)!;
  return { core, seats, gameId: OCTO_GAME_ID, seatOf };
}

/** Log payloads of the given kind, as plain records. */
function payloads(core: RoomCore, kind: string): Record<string, Json>[] {
  return core.log.filter((e) => e.kind === kind).map((e) => e.payload as Record<string, Json>);
}

function aliveNow(core: RoomCore): PlayerId[] {
  return (core.publicStateSummary() as unknown as { public: { alive: PlayerId[] } }).public.alive;
}

/**
 * One full gather+lead cycle. Seats in `skip` never submit, so the shared
 * gather deadline expires and they are forced (one strike each). Returns the
 * clock it left off at.
 */
function octoCycle(
  core: RoomCore,
  seats: Seat[],
  seatOf: (p: PlayerId) => Seat,
  now: number,
  skip: PlayerId[],
): number {
  let t = now;
  for (const s of seats) {
    if (skip.includes(s.seat.player)) continue;
    if (!core.playersToMoveNow().includes(s.seat.player)) continue;
    const r = submit(core, OCTO_GAME_ID, s, { index: 0 }, (t += 10));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }
  if (core.waitingFor().length > 0) {
    t = core.deadlineAtMs!;
    core.timeout(t);
  }
  const lead = core.playersToMoveNow();
  if (core.status === 'running' && lead.length === 1) {
    const r = submit(core, OCTO_GAME_ID, seatOf(lead[0]!), { index: 0 }, (t += 10));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }
  return t + 10;
}

describe('non-terminal elimination: forfeitPlayer vs the terminal forfeit', () => {
  it('eliminates the seat mid-resolution and still applies every other held submission', () => {
    // THE STRIKE-CASCADE REGRESSION. Before eliminate() existed, an in-loop
    // forfeit returned out of resolveSimultaneous with the held map already
    // popped, silently discarding every remaining seat's submission.
    const { core, seats, gameId, seatOf } = makeOcto();
    const p1 = playerId(1);
    let now = 1_000_050;

    now = octoCycle(core, seats, seatOf, now, [p1]); // p1 strike 1
    now = octoCycle(core, seats, seatOf, now, [p1]); // p1 strike 2
    expect(core.strikes[p1]).toBe(2);
    expect(core.status).toBe('running');

    // Third gather: everyone but p1 submits, then the deadline expires.
    for (const s of seats) {
      if (s.seat.player === p1) continue;
      expect(submit(core, gameId, s, { index: 0 }, (now += 10)).ok).toBe(true);
    }
    const turnBefore = core.turnIndex;
    const strikesBefore = { ...core.strikes };
    core.timeout(core.deadlineAtMs!);

    // p1 struck out and left the table; the game did NOT end.
    expect(core.status).toBe('running');
    expect(core.strikes[p1]).toBe(3);
    expect(aliveNow(core)).toEqual([playerId(0), playerId(2), playerId(3)]);

    // No innocent seat took an unearned strike.
    for (const p of [playerId(0), playerId(2), playerId(3)]) {
      expect(core.strikes[p]).toBe(strikesBefore[p]);
    }

    // Every other held submission still applied, at the shared turn index.
    const applied = payloads(core, 'move').filter((p) => p.turn_index === turnBefore);
    expect(applied.map((p) => p.player)).toEqual([playerId(0), playerId(2), playerId(3)]);

    // The elimination is a FULL state entry, unsigned, and the turn advanced
    // exactly once across the whole resolution.
    const forfeits = core.log.filter((e) => e.kind === 'forfeit');
    expect(forfeits).toHaveLength(1);
    expect(forfeits[0]!.signature).toBeNull();
    expect(forfeits[0]!.payload).toMatchObject({
      turn_index: turnBefore,
      player: p1,
      reason: 'three_strikes',
    });
    expect(typeof (forfeits[0]!.payload as Record<string, Json>).state_hash).toBe('string');
    expect((forfeits[0]!.payload as Record<string, Json>).draws).toEqual([]);
    expect(core.turnIndex).toBe(turnBefore + 1);
    expect(verifyChain(gameId, core.log.slice()).ok).toBe(true);
  });

  it('BASELINE: the same script on a game without forfeitPlayer still forfeits the table', () => {
    const { core, seats, gameId, seatOf } = makeOcto({ game: octoGameBare });
    const p1 = playerId(1);
    let now = 1_000_050;
    now = octoCycle(core, seats, seatOf, now, [p1]);
    now = octoCycle(core, seats, seatOf, now, [p1]);
    expect(core.strikes[p1]).toBe(2);

    for (const s of seats) {
      if (s.seat.player === p1) continue;
      expect(submit(core, gameId, s, { index: 0 }, (now += 10)).ok).toBe(true);
    }
    core.timeout(core.deadlineAtMs!);

    expect(core.status).toBe('ended');
    expect(core.result).toMatchObject({ draw: false, reason: 'forfeit' });
    expect(core.result!.winners.sort()).toEqual([playerId(0), playerId(2), playerId(3)]);
    // Unchanged terminal payload: { player, reason } with no state_hash.
    const f = core.log.find((e) => e.kind === 'forfeit')!;
    expect(f.payload).toEqual({ player: p1, reason: 'three_strikes' });
  });

  it('a replay containing an elimination verifies offline, and tampering with it does not', () => {
    const { core, seats, gameId, seatOf } = makeOcto();
    const p1 = playerId(1);
    let now = 1_000_050;
    now = octoCycle(core, seats, seatOf, now, [p1]);
    now = octoCycle(core, seats, seatOf, now, [p1]);
    for (const s of seats) {
      if (s.seat.player === p1) continue;
      // One seat speaks, so the replay also exercises bindUtterance through
      // the verifier's copy of the shared resolver.
      const extra = s.seat.player === playerId(0) ? { utterance: 'sealed and signed' } : undefined;
      expect(submit(core, gameId, s, { index: 0 }, (now += 10), extra).ok).toBe(true);
    }
    core.timeout(core.deadlineAtMs!);
    expect(core.status).toBe('running');

    // Play the rest out normally.
    let guard = 0;
    while (core.status === 'running' && guard++ < 100) {
      const movers = core.playersToMoveNow();
      if (movers.length === 0) break;
      for (const m of movers) {
        if (core.status !== 'running' || !core.playersToMoveNow().includes(m)) continue;
        expect(submit(core, gameId, seatOf(m), { index: 0 }, (now += 10)).ok).toBe(true);
      }
    }
    expect(core.status).toBe('ended');

    const replay = core.replayFile()!;
    expect(replay.log.some((e) => e.kind === 'forfeit')).toBe(true);
    const report = verifyReplay(replay, { octo: octoGame });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);

    // The spoken move survives into the log verbatim, and NOTHING the room
    // forced ever carries words: bindUtterance runs only on a real submission.
    expect(payloads(core, 'move').some((p) => p.notation === 'a "sealed and signed"')).toBe(true);
    const timeouts = payloads(core, 'timeout');
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((p) => p.applied_notation === 'a')).toBe(true);

    // Rewriting the elimination's state_hash breaks the chain first…
    const tampered = JSON.parse(JSON.stringify(replay)) as typeof replay;
    const fe = tampered.log.find((e) => e.kind === 'forfeit')!;
    (fe.payload as Record<string, Json>).state_hash = '0'.repeat(64);
    expect(verifyReplay(tampered, { octo: octoGame }).ok).toBe(false);

    // …and dropping the whole entry (re-sealing the chain) is caught by the
    // very next entry's state hash, because the state was never advanced.
    const dropped = JSON.parse(JSON.stringify(replay)) as typeof replay;
    dropped.log = dropped.log.filter((e) => e.kind !== 'forfeit');
    dropped.log.forEach((e, i) => {
      e.seq = i;
    });
    rehashOctoLog(dropped);
    const droppedReport = verifyReplay(dropped, { octo: octoGame });
    expect(droppedReport.ok).toBe(false);
    expect(droppedReport.checks.find((c) => c.name === 'recomputation')?.ok).toBe(false);
  });

  it('a room with an eliminated seat snapshots, rehydrates and still finishes verifiably', () => {
    const { core, seats, gameId, seatOf } = makeOcto();
    const p1 = playerId(1);
    let now = 1_000_050;
    now = octoCycle(core, seats, seatOf, now, [p1]);
    now = octoCycle(core, seats, seatOf, now, [p1]);
    for (const s of seats) {
      if (s.seat.player === p1) continue;
      expect(submit(core, gameId, s, { index: 0 }, (now += 10)).ok).toBe(true);
    }
    core.timeout(core.deadlineAtMs!);
    expect(core.status).toBe('running');

    const revived = RoomCore.hydrate(octoGame, JSON.parse(JSON.stringify(core.snapshot())) as ReturnType<RoomCore['snapshot']>);
    expect(revived.playersToMoveNow()).not.toContain(p1);

    let guard = 0;
    let t = now + 1_000;
    while (revived.status === 'running' && guard++ < 100) {
      const movers = revived.playersToMoveNow();
      if (movers.length === 0) break;
      for (const m of movers) {
        if (revived.status !== 'running' || !revived.playersToMoveNow().includes(m)) continue;
        expect(submit(revived, gameId, seatOf(m), { index: 0 }, (t += 10)).ok).toBe(true);
      }
    }
    expect(revived.status).toBe('ended');
    expect(verifyReplay(revived.replayFile()!, { octo: octoGame }).ok).toBe(true);
  });

  it('a third illegal submission in a simultaneous phase eliminates and collection continues', () => {
    const { core, seats, gameId, seatOf } = makeOcto();
    const p1 = playerId(1);
    let now = 1_000_050;
    now = octoCycle(core, seats, seatOf, now, [p1]);
    now = octoCycle(core, seats, seatOf, now, [p1]);
    expect(core.strikes[p1]).toBe(2);

    // p1 burns its three attempts of this turn without ever submitting a move.
    expect((submit(core, gameId, seatOf(p1), 'zzz', (now += 10)) as SubmitReject).illegal_attempt).toBe(1);
    expect((submit(core, gameId, seatOf(p1), 'zzz', (now += 10)) as SubmitReject).illegal_attempt).toBe(2);
    const third = submit(core, gameId, seatOf(p1), 'zzz', (now += 10));
    expect(third.ok).toBe(true);

    expect(core.status).toBe('running');
    expect(core.strikes[p1]).toBe(3);
    expect(core.playersToMoveNow()).not.toContain(p1);
    expect(core.waitingFor()).not.toContain(p1);

    // The three survivors still finish the phase normally.
    for (const s of seats) {
      if (s.seat.player === p1) continue;
      expect(submit(core, gameId, s, { index: 0 }, (now += 10)).ok).toBe(true);
    }
    expect(core.status).toBe('running');
    expect(aliveNow(core)).toEqual([playerId(0), playerId(2), playerId(3)]);
  });

  it('a held move that became illegal eliminates its owner without touching the others', () => {
    // variant { shift: true }: the second seat to commit 'b' in a round is
    // rejected at RESOLUTION time — the one way a legally-held submission goes
    // stale under a simultaneous phase.
    const { core, seats, gameId, seatOf } = makeOcto({ variant: { shift: true } });
    const p1 = playerId(1);
    let now = 1_000_050;
    now = octoCycle(core, seats, seatOf, now, [p1]);
    now = octoCycle(core, seats, seatOf, now, [p1]);
    expect(core.strikes[p1]).toBe(2);

    // p0 and p1 both hold 'b'; p0 applies first, so p1's is stale.
    expect(submit(core, gameId, seatOf(playerId(0)), { index: 1 }, (now += 10)).ok).toBe(true);
    expect(submit(core, gameId, seatOf(p1), { index: 1 }, (now += 10)).ok).toBe(true);
    const turnBefore = core.turnIndex;
    expect(submit(core, gameId, seatOf(playerId(2)), { index: 0 }, (now += 10)).ok).toBe(true);
    expect(submit(core, gameId, seatOf(playerId(3)), { index: 0 }, (now += 10)).ok).toBe(true);

    expect(core.status).toBe('running');
    expect(core.strikes[p1]).toBe(3);
    expect(aliveNow(core)).toEqual([playerId(0), playerId(2), playerId(3)]);
    const applied = payloads(core, 'move').filter((p) => p.turn_index === turnBefore);
    expect(applied.map((p) => p.player)).toEqual([playerId(0), playerId(2), playerId(3)]);
    expect(applied[0]!.notation).toBe('b');
    expect(core.turnIndex).toBe(turnBefore + 1);
  });

  it('a third illegal submission in a SEQUENTIAL phase eliminates and advances the turn', () => {
    const { core, seats, gameId, seatOf } = makeOcto();
    const p0 = playerId(0);
    let now = 1_000_050;

    // p0 misses the gather deadline (strike 1) and then the lead deadline
    // (strike 2), leaving it the lone mover of the next lead phase.
    for (const s of seats) {
      if (s.seat.player === p0) continue;
      expect(submit(core, gameId, s, { index: 0 }, (now += 10)).ok).toBe(true);
    }
    core.timeout(core.deadlineAtMs!);
    expect(core.playersToMoveNow()).toEqual([p0]); // lead phase
    core.timeout(core.deadlineAtMs!);
    expect(core.strikes[p0]).toBe(2);
    now = core.deadlineAtMs! - 10_000;

    // A clean gather, so the next lead phase has p0 alone and still at 2.
    for (const s of seats) {
      expect(submit(core, gameId, s, { index: 0 }, (now += 10)).ok).toBe(true);
    }
    expect(core.playersToMoveNow()).toEqual([p0]); // lead phase again

    const turnBefore = core.turnIndex;
    // 'c' PARSES but apply() rejects it: the resolved-fine-then-refused branch.
    expect((submit(core, gameId, seatOf(p0), 'c', (now += 10)) as SubmitReject).illegal_attempt).toBe(1);
    expect((submit(core, gameId, seatOf(p0), 'c', (now += 10)) as SubmitReject).illegal_attempt).toBe(2);
    expect(submit(core, gameId, seatOf(p0), 'c', (now += 10)).ok).toBe(true);

    expect(core.status).toBe('running');
    expect(core.strikes[p0]).toBe(3);
    expect(aliveNow(core)).toEqual([playerId(1), playerId(2), playerId(3)]);
    expect(core.turnIndex).toBe(turnBefore + 1);
    expect(core.playersToMoveNow().length).toBeGreaterThan(0);
    expect(core.deadlineAtMs).not.toBeNull();
  });

  it('a third timeout strike in a SEQUENTIAL phase eliminates and advances the turn', () => {
    const { core, seats, gameId } = makeOcto();
    const p0 = playerId(0);
    let now = 1_000_050;
    for (const s of seats) {
      if (s.seat.player === p0) continue;
      expect(submit(core, gameId, s, { index: 0 }, (now += 10)).ok).toBe(true);
    }
    core.timeout(core.deadlineAtMs!); // strike 1 (gather)
    core.timeout(core.deadlineAtMs!); // strike 2 (lead, defaultMove applied)
    expect(core.strikes[p0]).toBe(2);

    // A clean gather, so the third strike lands on the SEQUENTIAL timeout
    // path — the one where nothing is applied and the seat simply leaves.
    now = core.deadlineAtMs! - 10_000;
    for (const s of seats) {
      expect(submit(core, gameId, s, { index: 0 }, (now += 10)).ok).toBe(true);
    }
    expect(core.playersToMoveNow()).toEqual([p0]);
    const turnBefore = core.turnIndex;
    core.timeout(core.deadlineAtMs!);

    expect(core.status).toBe('running');
    expect(core.strikes[p0]).toBe(3);
    expect(aliveNow(core)).toEqual([playerId(1), playerId(2), playerId(3)]);
    expect(core.turnIndex).toBe(turnBefore + 1);
    expect(core.playersToMoveNow().length).toBeGreaterThan(0);
  });

  it('a fallen flag in a SEQUENTIAL phase eliminates on time and the table plays on', () => {
    const { core, seats, gameId } = makeOcto({ perMoveMs: 60_000, perSideMs: 25_000 });
    const p0 = playerId(0);
    let now = 1_000_050;
    for (const s of seats) {
      if (s.seat.player === p0) continue;
      expect(submit(core, gameId, s, { index: 0 }, (now += 10)).ok).toBe(true);
    }
    core.timeout(core.deadlineAtMs!); // gather: charged the 20 s phase budget
    expect(core.playersToMoveNow()).toEqual([p0]);
    expect(core.clocks.cumulativeMs[p0]).toBe(20_000);

    const turnBefore = core.turnIndex;
    core.timeout(core.deadlineAtMs!); // lead: +5 s => the 25 s side budget is gone

    expect(core.status).toBe('running');
    expect(core.strikes[p0]).toBe(1); // a flag fall is not a strike
    expect(aliveNow(core)).toEqual([playerId(1), playerId(2), playerId(3)]);
    const f = core.log.filter((e) => e.kind === 'forfeit');
    expect(f).toHaveLength(1);
    expect(f[0]!.payload).toMatchObject({ player: p0, reason: 'time' });
    expect(core.turnIndex).toBe(turnBefore + 1);
  });

  it('a fallen flag eliminates on time and the phase still resolves for everyone else', () => {
    const { core, seats, gameId } = makeOcto({ perMoveMs: 60_000, perSideMs: 25_000 });
    const p1 = playerId(1);
    let now = 1_000_050;

    for (const s of seats) {
      if (s.seat.player === p1) continue;
      expect(submit(core, gameId, s, { index: 0 }, (now += 10)).ok).toBe(true);
    }
    core.timeout(core.deadlineAtMs!); // p1 charged one 20 s gather budget
    expect(core.status).toBe('running');
    expect(core.clocks.cumulativeMs[p1]).toBe(20_000);

    // lead phase (p0), then the next gather, which p1 misses again: 40 s > 25 s.
    expect(submit(core, gameId, seats[0]!, { index: 0 }, core.deadlineAtMs! - 100).ok).toBe(true);
    const turnBefore = core.turnIndex;
    for (const s of seats) {
      if (s.seat.player === p1) continue;
      expect(submit(core, gameId, s, { index: 0 }, core.deadlineAtMs! - 100).ok).toBe(true);
    }
    core.timeout(core.deadlineAtMs!);

    expect(core.status).toBe('running');
    expect(aliveNow(core)).toEqual([playerId(0), playerId(2), playerId(3)]);
    const f = core.log.filter((e) => e.kind === 'forfeit');
    expect(f).toHaveLength(1);
    expect(f[0]!.payload).toMatchObject({ player: p1, reason: 'time' });
    const applied = payloads(core, 'move').filter((p) => p.turn_index === turnBefore);
    expect(applied.map((p) => p.player)).toEqual([playerId(0), playerId(2), playerId(3)]);
  });
});

describe('phase-aware clocks, history window, resign/draw gates, end disclosure', () => {
  it('phaseBudgetMs drives the deadline AND the timeout charge (bare uses perMoveMs)', () => {
    const hooked = makeOcto({ perMoveMs: 60_000, nowMs: 1_000_000 });
    expect(hooked.core.deadlineAtMs).toBe(1_020_000); // gather: 20 s
    hooked.core.timeout(1_020_000);
    expect(hooked.core.clocks.cumulativeMs[P0]).toBe(20_000); // charged the PHASE
    expect(hooked.core.deadlineAtMs).toBe(1_025_000); // lead: 5 s

    const bare = makeOcto({ game: octoGameBare, perMoveMs: 60_000, nowMs: 1_000_000 });
    expect(bare.core.deadlineAtMs).toBe(1_060_000);
    bare.core.timeout(1_060_000);
    expect(bare.core.clocks.cumulativeMs[P0]).toBe(60_000);
    expect(bare.core.deadlineAtMs).toBe(1_120_000);
  });

  it('the side-clock flag falls on the CHARGED phase budget, not perMoveMs', () => {
    const hooked = makeOcto({ perMoveMs: 60_000, perSideMs: 25_000 });
    hooked.core.timeout(hooked.core.deadlineAtMs!);
    expect(hooked.core.status).toBe('running'); // charged 20 s of a 25 s budget

    const bare = makeOcto({ game: octoGameBare, perMoveMs: 60_000, perSideMs: 25_000 });
    bare.core.timeout(bare.core.deadlineAtMs!);
    expect(bare.core.status).toBe('ended'); // charged 60 s: flag down at once
    expect(bare.core.result?.reason).toBe('forfeit');
  });

  it('meta.historyWindow reaches buildView; a game without one keeps the default', () => {
    const hooked = makeOcto();
    const bare = makeOcto({ game: octoGameBare });
    let now = 1_000_050;
    for (const pair of [hooked, bare]) {
      now = octoCycle(pair.core, pair.seats, pair.seatOf, now, []);
    }
    expect(hooked.core.viewFor(P0, now).history.length).toBe(3); // meta.historyWindow
    expect(bare.core.viewFor(P0, now).history.length).toBe(5); // 4 gather + 1 lead
  });

  it('meta.allowsResign false rejects the resignation instead of crowning everyone else', () => {
    const hooked = makeOcto();
    const r = submit(hooked.core, hooked.gameId, hooked.seats[0]!, { index: 0 }, 1_000_100, {
      resign: true,
    }) as SubmitReject;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('resign_unavailable');
    expect(hooked.core.status).toBe('running');
    expect(hooked.core.log.some((e) => e.kind === 'resign')).toBe(false);

    const bare = makeOcto({ game: octoGameBare });
    expect(submit(bare.core, bare.gameId, bare.seats[0]!, { index: 0 }, 1_000_100, { resign: true }).ok).toBe(true);
    expect(bare.core.status).toBe('ended');
    expect(bare.core.result?.reason).toBe('resignation');
  });

  it('meta.allowsDrawOffer false closes the one-mover-phase draw hole', () => {
    // The hole: an offer made in a SEQUENTIAL phase registers with
    // validAtTurn = turn + 1, and the accept branch runs before the
    // simultaneous-phase rejection — so any seat can accept it on the next
    // (simultaneous) turn and end the game with winners: [].
    const hooked = makeOcto();
    let now = 1_000_050;
    for (const s of hooked.seats) {
      expect(submit(hooked.core, hooked.gameId, s, { index: 0 }, (now += 10)).ok).toBe(true);
    }
    expect(hooked.core.playersToMoveNow()).toHaveLength(1); // the lead phase
    const turnBefore = hooked.core.turnIndex;
    const rej = submit(hooked.core, hooked.gameId, hooked.seats[0]!, { index: 0 }, (now += 10), {
      draw_offer: true,
    }) as SubmitReject;
    expect(rej.ok).toBe(false);
    expect(rej.code).toBe('draw_offer_unavailable');
    expect(hooked.core.log.some((e) => e.kind === 'draw_offer')).toBe(false);
    expect(hooked.core.turnIndex).toBe(turnBefore); // the move did not apply
    expect(hooked.core.status).toBe('running');

    const bare = makeOcto({ game: octoGameBare });
    let bnow = 1_000_050;
    for (const s of bare.seats) {
      expect(submit(bare.core, bare.gameId, s, { index: 0 }, (bnow += 10)).ok).toBe(true);
    }
    expect(bare.core.playersToMoveNow()).toHaveLength(1);
    expect(submit(bare.core, bare.gameId, bare.seats[0]!, { index: 0 }, (bnow += 10), { draw_offer: true }).ok).toBe(true);
    expect(bare.core.log.some((e) => e.kind === 'draw_offer')).toBe(true);
    // Next (simultaneous) turn: a different seat accepts and the table is over.
    expect(submit(bare.core, bare.gameId, bare.seats[1]!, { index: 0 }, (bnow += 10), { draw_offer: true }).ok).toBe(true);
    expect(bare.core.status).toBe('ended');
    expect(bare.core.result).toMatchObject({ draw: true, reason: 'agreement', winners: [] });
  });

  it('revealOnEnd merges into the existing post-end reveal, never into a live event', () => {
    const hooked = makeOcto();
    let now = 1_000_050;
    let guard = 0;
    while (hooked.core.status === 'running' && guard++ < 100) {
      const movers = hooked.core.playersToMoveNow();
      if (movers.length === 0) break;
      for (const m of movers) {
        if (!hooked.core.playersToMoveNow().includes(m)) continue;
        expect(submit(hooked.core, hooked.gameId, hooked.seatOf(m), { index: 0 }, (now += 10)).ok).toBe(true);
      }
    }
    expect(hooked.core.status).toBe('ended');

    const events = hooked.core.eventsSince(0);
    const endSeq = events.find((e) => e.type === 'end')!.seq;
    const revealEv = events.find((e) => e.type === 'reveal')!;
    expect(revealEv.seq).toBeGreaterThan(endSeq);
    // The disclosure is in the reveal and nowhere before it.
    const probe = octoSecretProbe(P0);
    expect(JSON.stringify(revealEv.data)).toContain(probe);
    const preEnd = JSON.stringify(events.filter((e) => e.seq < endSeq).map((e) => e.data));
    expect(preEnd).not.toContain(probe);
    // The verifier's three commit-reveal fields survive the merge untouched.
    const revealLog = hooked.core.log[hooked.core.log.length - 1]!;
    expect(revealLog.kind).toBe('reveal');
    expect(revealLog.payload).toMatchObject({ reveal_secret: SECRET, drand_randomness: DRAND });
    expect(verifyReplay(hooked.core.replayFile()!, { octo: octoGame }).ok).toBe(true);

    // A game without revealOnEnd produces exactly the payload it always did.
    const bare = makeOcto({ game: octoGameBare });
    let bnow = 1_000_050;
    let bguard = 0;
    while (bare.core.status === 'running' && bguard++ < 100) {
      const movers = bare.core.playersToMoveNow();
      if (movers.length === 0) break;
      for (const m of movers) {
        if (!bare.core.playersToMoveNow().includes(m)) continue;
        expect(submit(bare.core, bare.gameId, bare.seatOf(m), { index: 0 }, (bnow += 10)).ok).toBe(true);
      }
    }
    expect(bare.core.log[bare.core.log.length - 1]!.payload).toEqual({
      reveal_secret: SECRET,
      final_seed: bare.core.replayFile()!.final_seed,
      drand_randomness: DRAND,
    });
  });

  it('the utterance channel is gated on meta.speechLimit and binds into the move', () => {
    const hooked = makeOcto();
    const bare = makeOcto({ game: octoGameBare });

    // A game with no channel rejects the field outright.
    const noChannel = submit(bare.core, bare.gameId, bare.seats[0]!, { index: 0 }, 1_000_100, {
      utterance: 'hello',
    }) as SubmitReject;
    expect(noChannel.code).toBe('bad_utterance');
    expect(noChannel.message).toBe('this game has no speech channel');

    const tooLong = submit(hooked.core, hooked.gameId, hooked.seats[0]!, { index: 0 }, 1_000_100, {
      utterance: 'x'.repeat(41),
    }) as SubmitReject;
    expect(tooLong.code).toBe('bad_utterance');

    const ok = submit(hooked.core, hooked.gameId, hooked.seats[0]!, { index: 0 }, 1_000_150, {
      utterance: 'well played',
    }) as SubmitOk;
    expect(ok.ok).toBe(true);
    // The words rode into the move, so they are in the notation, the history
    // and therefore the hashed state — not in a side channel.
    const held = payloads(hooked.core, 'move');
    expect(held).toHaveLength(0); // still collecting
    let now = 1_000_200;
    for (const s of hooked.seats.slice(1)) {
      expect(submit(hooked.core, hooked.gameId, s, { index: 0 }, (now += 10)).ok).toBe(true);
    }
    expect(payloads(hooked.core, 'move')[0]!.notation).toBe('a "well played"');

    // An over-long notation string is a rejection, never a strike.
    const long = submit(hooked.core, hooked.gameId, hooked.seats[0]!, `a ${'y'.repeat(2_100)}`, (now += 10)) as SubmitReject;
    expect(long.code).toBe('move_too_long');
    expect(long.illegal_attempt).toBeUndefined();
  });
});

/** Recomputes prev_hash/hash after an edit, so tamper tests reach the verifier. */
function rehashOctoLog(replay: { game_id: string; log: { seq: number; kind: string; payload: Json; prev_hash: string; hash: string }[] }): void {
  let prev = '0'.repeat(64);
  for (const e of replay.log) {
    e.prev_hash = prev;
    e.hash = sha256Hex(`ludus.log.v1:${replay.game_id}:${e.seq}:${prev}:${canonicalJson({ kind: e.kind, payload: e.payload })}`);
    prev = e.hash;
  }
}
