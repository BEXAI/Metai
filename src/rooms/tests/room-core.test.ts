/**
 * RoomCore tests: happy path + replay chain (A8/A11), the frozen three-step
 * illegal-move policy, timeouts/defaultMove/strikes/forfeit, resignation,
 * draw offer/accept, simultaneous-phase collection under one deadline, the
 * A10 spectator-leakage probe, protocol rejections, and snapshot/hydration.
 * All crypto is real (Ed25519 keys, hash chain, commit-reveal).
 */

import { describe, expect, it } from 'vitest';
import { verifyChain } from '../../crypto/chain.ts';
import { deriveFinalSeed, verifyCommitment } from '../../crypto/commit.ts';
import { generateKeypair, signEd25519, verifyEd25519 } from '../../crypto/ed25519.ts';
import type { Json, MoveSubmission, PlayerId, VariantConfig } from '../../kernel/types.ts';
import { moveSignMessage, RoomCore, type RoomSeat, type SubmitOk, type SubmitReject } from '../core.ts';
import { miniGame, miniGameNoDefault, P0, P1, secretProbe } from './mini-game.ts';

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
    expect(JSON.stringify(snap.privateViews[P0])).toContain(secretProbe(P0));

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
