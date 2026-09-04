/**
 * RED TEAM red-team-liveness — werewolf, the ELIMINATION half (plan E3/E4,
 * gate ▲21). Everything here attacks one claim:
 *
 *   ONE SEAT'S THIRD STRIKE MUST COST EXACTLY ONE SEAT.
 *
 * Werewolf is the first game in the hall where a loss does not end the table.
 * `forfeitPlayer` turns a three-strikes or flag-fall loss into an in-game
 * death, so rooms/core.ts now has TWO exits — the terminal `forfeit()` every
 * other game takes, and the non-terminal `eliminate()` — and `eliminate()` is
 * reached from FIVE call sites, each of which used to be followed by an
 * unconditional `return` that was safe only because the game was over:
 *
 *   core.ts:930   third illegal in submitSequential (the defence phase)
 *   core.ts:951   third strike after apply() rejected a parsed move
 *   core.ts:1176  third illegal in submitSimultaneous, BEFORE the held move is
 *                 stored at :1182
 *   core.ts:1235  third strike on a timeout inside resolveSimultaneous, AFTER
 *                 the held map was popped into a local at :1208-1209
 *   core.ts:1326  third strike after a substitution, same loop
 *
 * A `return` at :1235 discards every remaining seat's already-accepted
 * submission — no log entry, no history row, no event, no rejection, even
 * though those agents were told { ok: true, applied: false } — never runs
 * advanceTurn, and leaves waitingFor() re-listing them for the alarm to force
 * and strike. One flaky agent then strike-cascades onto up to five innocent
 * seats, and a wolf that legitimately ordered a kill has it replaced by
 * `stay_in` because a DIFFERENT seat struck out. That is the regression this
 * file exists to prevent; every test below states the transactional property
 * as an assertion about the OTHER seats, not about the one that died.
 *
 * The second half is E4: `resign` and `draw_offer`. Both were treated as
 * advisory. `resign` is checked before the mover check, so any seated player —
 * INCLUDING one the game has already eliminated — could crown the other seven;
 * and the draw ACCEPT branch runs before the simultaneous-phase rejection, so
 * an offer registered in the one-mover defence was acceptable by any living
 * seat on the next turn, ending a hidden-role game with `winners: []` that
 * verifyReplay would sign off as a clean draw. Both are asserted against the
 * NEW code (the phase, the message and the absent side effect), because the
 * old rejection string still exists for a different reason.
 *
 * Deterministic only: sha256-derived keys, seeded streams, explicit nowMs.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { signEd25519 } from '../../src/crypto/ed25519.ts';
import { publicKeyOf } from '../../src/identity/ed25519.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import {
  playerId,
  type AnyGame,
  type Json,
  type MoveSubmission,
  type PlayerId,
  type SeedStream,
} from '../../src/kernel/types.ts';
import { verifyReplay } from '../../src/kernel/verify.ts';
import {
  moveSignMessage,
  RoomCore,
  type RoomSeat,
  type RoomSnapshot,
  type SubmitOk,
  type SubmitReject,
  type SubmitResult,
} from '../../src/rooms/core.ts';
import werewolfGame from '../../src/games/werewolf/index.ts';
import { legalMoves, livingSeats, type Seat, type WwState } from '../../src/games/werewolf/rules.ts';

const werewolf = werewolfGame as unknown as AnyGame;

const SEATS: PlayerId[] = Array.from({ length: 8 }, (_, i) => playerId(i));
const SECRET = '3c'.repeat(32);
const DRAND = '9e'.repeat(32);
const T0 = 2_000_000;

const seed = (tag: string): SeedStream => createSeedStream(sha256Hex(`redteam-liveness-werewolf:${tag}`));

// ---------------------------------------------------------------------------
// An 8-seat table with a wall clock that never accidentally crosses a deadline
// ---------------------------------------------------------------------------

interface TestSeat {
  seat: RoomSeat;
  secretKey: string;
}

interface Table {
  core: RoomCore;
  seats: TestSeat[];
  gameId: string;
  /** Wall-clock cursor. Every helper advances it; none ever passes a deadline. */
  now: number;
}

function makeTable(tag: string, game: AnyGame = werewolf): Table {
  const seats: TestSeat[] = SEATS.map((player, i) => {
    const secretKey = sha256Hex(`redteam-liveness-werewolf:${tag}:seat:${i}`);
    return {
      seat: { player, agent_id: `agent-${i}`, handle: `agent${i}`, pubkey_ed25519: publicKeyOf(secretKey) },
      secretKey,
    };
  });
  const gameId = `rt-ww-live-${tag}`;
  const core = RoomCore.create(T0, {
    gameId,
    game,
    variant: {},
    seats: seats.map((s) => s.seat),
    division: 'open',
    rulesetVersion: '1.0.0',
    secretHex: SECRET,
    drandRound: 909,
    drandRandomnessHex: DRAND,
    clockScale: 1,
  });
  return { core, seats, gameId, now: T0 + 100 };
}

function seatOf(t: Table, p: PlayerId): TestSeat {
  return t.seats.find((s) => s.seat.player === p)!;
}

function submit(t: Table, p: PlayerId, move: MoveSubmission['move'], extra?: Partial<MoveSubmission>): SubmitResult {
  const s = seatOf(t, p);
  const submission: MoveSubmission = { game_id: t.gameId, turn_index: t.core.turnIndex, move, ...extra };
  const signature = signEd25519(s.secretKey, moveSignMessage(t.gameId, t.core.turnIndex, submission));
  t.now += 50;
  return t.core.submitMove(t.now, s.seat.agent_id, submission, signature);
}

/** Every seat still waited on except `absent`, in waitingFor() order. */
function submitRest(t: Table, absent: readonly PlayerId[], move: (p: PlayerId) => MoveSubmission['move'], extra?: (p: PlayerId) => Partial<MoveSubmission> | undefined): void {
  for (const p of t.core.waitingFor()) {
    if (absent.includes(p)) continue;
    const r = submit(t, p, move(p), extra?.(p));
    expect(r.ok, `${p} @turn ${t.core.turnIndex}: ${JSON.stringify(r)}`).toBe(true);
  }
}

/** Fires the shared alarm exactly at the deadline and parks the cursor there. */
function fireDeadline(t: Table): void {
  const deadline = t.core.deadlineAtMs!;
  expect(deadline).not.toBeNull();
  const res = t.core.timeout(deadline);
  expect(res.fired, 'the alarm must fire at its own deadline').toBe(true);
  t.now = deadline + 10;
}

function stateOf(core: RoomCore): WwState {
  return core.snapshot().state as unknown as WwState;
}

interface Entry {
  seq: number;
  kind: string;
  payload: Record<string, Json>;
  signature: string | null;
}

function entries(core: RoomCore, kind?: string): Entry[] {
  return core.log
    .filter((e) => kind === undefined || e.kind === kind)
    .map((e) => ({ seq: e.seq, kind: e.kind, payload: e.payload as Record<string, Json>, signature: e.signature }));
}

function atTurn(core: RoomCore, kind: string, turn: number): Entry[] {
  return entries(core, kind).filter((e) => e.payload['turn_index'] === turn);
}

/** The seats an elimination log entry names, in log order. */
function eliminated(core: RoomCore): PlayerId[] {
  return entries(core, 'forfeit')
    .filter((e) => e.payload['state_hash'] !== undefined)
    .map((e) => e.payload['player'] as PlayerId);
}

/**
 * Runs the remaining game to its end with the null act, which is index 0 in
 * every phase. Returns the number of turns it took, and fails loudly on the
 * liveness invariant a room can actually die of.
 */
function playOutSilently(t: Table, cap = 60): number {
  let turns = 0;
  while (t.core.status === 'running') {
    expect(turns++, 'the room never terminated').toBeLessThan(cap);
    const movers = t.core.playersToMoveNow();
    expect(movers.length, `LIVENESS: running room with nobody to move at turn ${t.core.turnIndex}`).toBeGreaterThan(0);
    for (const p of movers) {
      expect(submit(t, p, { index: 0 }).ok, `${p} @turn ${t.core.turnIndex}`).toBe(true);
    }
  }
  return turns;
}

/**
 * Drives a FRESH table to the one sequential phase: night, then a discussion
 * round in which every other seat accuses `accused` (the accused itself takes
 * the null act — a self-accusation is a RuleError, and in a simultaneous phase
 * that is a held move struck at resolution), then a silent second round.
 */
function toDefence(t: Table, accused: PlayerId): void {
  submitRest(t, [], () => ({ index: 0 }));
  submitRest(t, [], (p) => (p === accused ? { index: 0 } : `accuse(${accused})`));
  submitRest(t, [], () => ({ index: 0 }));
  expect(stateOf(t.core).phase).toBe('day_defense');
  expect(stateOf(t.core).defender).toBe(accused);
  expect(t.core.playersToMoveNow()).toEqual([accused]);
  for (const p of SEATS) expect(t.core.strikes[p], p).toBe(0);
}

/**
 * Two full phases in which everybody but `victim` answers and the alarm then
 * forces the absentee: the victim comes out carrying exactly two strikes and
 * every other seat carrying none. Leaves the table in day_talk round 1.
 */
function strikeTwice(t: Table, victim: PlayerId): void {
  for (let phase = 0; phase < 2; phase++) {
    submitRest(t, [victim], () => ({ index: 0 }));
    expect(t.core.waitingFor()).toEqual([victim]);
    fireDeadline(t);
  }
  expect(t.core.strikes[victim]).toBe(2);
  for (const p of SEATS) if (p !== victim) expect(t.core.strikes[p], p).toBe(0);
  expect(stateOf(t.core).phase).toBe('day_talk');
  expect(stateOf(t.core).round).toBe(1);
}

// ---------------------------------------------------------------------------
// 1. The strike cascade: eliminate() must be transactional
// ---------------------------------------------------------------------------

describe('a third strike costs exactly one seat: no cascade onto the other seven', () => {
  it('a third strike inside resolveSimultaneous applies ALL seven other held moves and advances once', () => {
    // THE REGRESSION. p3 is deliberately in the middle of the seat order: the
    // resolution loop runs in seat order, so p4..p7 are the seats a `return`
    // at core.ts:1235 would silently discard — already-accepted submissions,
    // from agents that were told { ok: true, applied: false }, with no log
    // entry and no rejection to show for it.
    const t = makeTable('cascade');
    const VICTIM: PlayerId = 'p3';
    strikeTwice(t, VICTIM);

    const turn = t.core.turnIndex;
    const round = stateOf(t.core).round;
    expect(turn).toBe(2);
    // Seven distinct, attributable utterances. If a held submission is dropped,
    // its words are missing from the transcript and this test says which seat.
    const word = (p: PlayerId): string => `CASCADE-${p.toUpperCase()}-QZX`;
    submitRest(t, [VICTIM], () => ({ index: 0 }), (p) => ({ utterance: word(p) }));
    expect(t.core.waitingFor()).toEqual([VICTIM]);
    expect(t.core.turnIndex, 'the phase must not resolve while a mover is outstanding').toBe(turn);

    fireDeadline(t);

    // The table is still playing, and exactly one seat left it.
    expect(t.core.status, 'a werewolf elimination must never end the table').toBe('running');
    expect(t.core.strikes[VICTIM]).toBe(3);
    for (const p of SEATS) if (p !== VICTIM) expect(t.core.strikes[p], p).toBe(0);
    expect(eliminated(t.core)).toEqual([VICTIM]);

    const st = stateOf(t.core);
    expect(st.alive[VICTIM]).toBe(false);
    expect(st.cause[VICTIM]).toBe('abandoned');
    expect(st.revealed[VICTIM]).toBe(st.roles[VICTIM]);
    expect(livingSeats(st)).toHaveLength(7);

    // TRANSACTIONAL: all seven held submissions applied, in seat order, at the
    // shared turn index — including the four that come AFTER the eliminated
    // seat in the resolution loop.
    const applied = atTurn(t.core, 'move', turn);
    expect(applied.map((e) => e.payload['player'])).toEqual(SEATS.filter((p) => p !== VICTIM));
    for (const e of applied) {
      const sub = e.payload['submission'] as Record<string, Json>;
      expect(sub['utterance'], `${String(e.payload['player'])}'s own words were not the ones applied`).toBe(
        word(e.payload['player'] as PlayerId),
      );
    }
    // …and the words are in the state, not merely in the log.
    const spoken = new Set(st.transcript.filter((u) => u.day === st.day).map((u) => u.text));
    for (const p of SEATS) {
      if (p === VICTIM) continue;
      expect(spoken.has(word(p)), `${p}'s held speech never reached the transcript`).toBe(true);
    }

    // Nothing was applied FOR the eliminated seat: the forfeit beats the
    // forced default, so there is no timeout entry, no row for the round it
    // died in, and — on the two rounds it WAS forced through — no word the
    // engine invented on its behalf.
    expect(atTurn(t.core, 'timeout', turn)).toEqual([]);
    expect(st.transcript.filter((u) => u.speaker === VICTIM && u.round === round)).toEqual([]);
    for (const u of st.transcript) if (u.speaker === VICTIM) expect(u.text).toBe('');

    // advanceTurn ran EXACTLY once for the phase, and the survivors got a
    // fresh, single deadline rather than being re-listed for the alarm.
    expect(t.core.turnIndex).toBe(turn + 1);
    expect(t.core.snapshot().pendingSimultaneous).toEqual({});
    expect(t.core.playersToMoveNow()).toHaveLength(7);
    expect(t.core.waitingFor()).toHaveLength(7);
    expect(t.core.playersToMoveNow()).not.toContain(VICTIM);
    expect(atTurn(t.core, 'strike', turn)).toHaveLength(1);

    // The whole game — elimination included — still verifies offline.
    playOutSilently(t);
    expect(t.core.result?.reason).not.toBe('forfeit');
    const report = verifyReplay(t.core.replayFile()!, { werewolf });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('the eliminated seat is never struck, forced or re-listed again', () => {
    const t = makeTable('no-second-strike');
    const VICTIM: PlayerId = 'p2';
    strikeTwice(t, VICTIM);
    submitRest(t, [VICTIM], () => ({ index: 0 }));
    fireDeadline(t);
    expect(t.core.strikes[VICTIM]).toBe(3);
    const forfeitSeq = entries(t.core, 'forfeit')[0]!.seq;

    // A corpse cannot submit, and the refusal is the mover check — not a
    // strike, not a rejection that would let it keep spending the room's time.
    const dead = submit(t, VICTIM, { index: 0 }) as SubmitReject;
    expect(dead.ok).toBe(false);
    expect(dead.code).toBe('not_your_turn');
    expect(t.core.strikes[VICTIM]).toBe(3);

    // One more alarm, so the TIMEOUT path gets its own go at the dead seat:
    // timeout() forces everyone waitingFor() and charges the budget, and the
    // seat that left must not be in that set.
    expect(t.core.waitingFor()).not.toContain(VICTIM);
    fireDeadline(t);
    for (const p of SEATS) expect(t.core.strikes[p], p).toBe(p === VICTIM ? 3 : 1);

    // Then out to the end by submission, checking the same thing every phase.
    let phases = 0;
    while (t.core.status === 'running') {
      expect(phases++, 'the room never terminated').toBeLessThan(60);
      expect(t.core.playersToMoveNow().length, 'LIVENESS: running room with nobody to move').toBeGreaterThan(0);
      expect(t.core.playersToMoveNow()).not.toContain(VICTIM);
      expect(t.core.waitingFor()).not.toContain(VICTIM);
      for (const p of t.core.playersToMoveNow()) expect(submit(t, p, { index: 0 }).ok).toBe(true);
    }

    // NOT ONE later entry names the seat that already left.
    expect(t.core.strikes[VICTIM]).toBe(3);
    for (const e of entries(t.core)) {
      if (e.seq <= forfeitSeq) continue;
      if (e.kind === 'end' || e.kind === 'reveal') continue;
      expect(e.payload['player'], `entry ${e.seq} (${e.kind}) touched the eliminated seat`).not.toBe(VICTIM);
    }
    // The other seven wore the timeouts; none of them was eliminated for it.
    expect(eliminated(t.core)).toEqual([VICTIM]);
    const report = verifyReplay(t.core.replayFile()!, { werewolf });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('a third ILLEGAL at submission time eliminates, then the phase resolves on the last survivor', () => {
    // core.ts:1176 — the site that used to return BEFORE the held move was
    // stored at :1182. Two things must hold: collection continues (the room
    // must not sit on a deadline waiting for a seat that no longer exists),
    // and the eliminated seat contributes nothing to the resolution.
    const t = makeTable('third-illegal-sim');
    const VICTIM: PlayerId = 'p1';
    strikeTwice(t, VICTIM);
    const turn = t.core.turnIndex;

    const r1 = submit(t, VICTIM, { index: 9_999 }) as SubmitReject;
    expect(r1.ok).toBe(false);
    expect(r1.illegal_attempt).toBe(1);
    const r2 = submit(t, VICTIM, { index: -1 }) as SubmitReject;
    expect(r2.illegal_attempt).toBe(2);
    expect(r2.legal_moves?.length).toBeGreaterThan(0);
    expect(t.core.strikes[VICTIM], 'rejections never strike').toBe(2);

    const r3 = submit(t, VICTIM, { index: 9_999 }) as SubmitOk;
    expect(r3.ok).toBe(true);
    expect(t.core.strikes[VICTIM]).toBe(3);
    expect(t.core.status).toBe('running');
    expect(stateOf(t.core).alive[VICTIM]).toBe(false);

    // The phase is NOT over — six seats have yet to speak — and the room is
    // no longer waiting on the seat it just removed.
    expect(t.core.turnIndex).toBe(turn);
    expect(t.core.waitingFor()).not.toContain(VICTIM);
    expect(t.core.waitingFor()).toHaveLength(7);

    // It resolves the moment the last SURVIVOR submits, without an alarm.
    const before = t.core.deadlineAtMs;
    submitRest(t, [VICTIM], () => ({ index: 0 }));
    expect(t.core.turnIndex, 'the phase hung waiting for an eliminated seat').toBe(turn + 1);
    expect(t.core.deadlineAtMs).not.toBe(before);
    expect(atTurn(t.core, 'move', turn).map((e) => e.payload['player'])).toEqual(
      SEATS.filter((p) => p !== VICTIM),
    );
    expect(atTurn(t.core, 'timeout', turn)).toEqual([]);
    expect(eliminated(t.core)).toEqual([VICTIM]);
    for (const p of SEATS) if (p !== VICTIM) expect(t.core.strikes[p], p).toBe(0);

    playOutSilently(t);
    expect(verifyReplay(t.core.replayFile()!, { werewolf }).ok).toBe(true);
  });

  const SEQUENTIAL_CASES: [string, MoveSubmission['move']][] = [
    // core.ts:930 — the resolve ladder rejects the submission outright.
    ['an out-of-range index', { index: 9_999 }],
    // core.ts:951 — the ladder SUCCEEDS (the parser is shape-only) and apply()
    // is the one that rejects. Different return site, same required outcome.
    // An ARGUMENT error, not a foreign verb: the parser's verb table is
    // phase-scoped now (notation.ts verbActsIn), so `vote(p0)` in a discussion
    // phase is plain speech rather than a rule error — which is the point, as
    // the same string in a SIMULTANEOUS phase used to be a silent strike.
    // Argument errors are in-phase and still reach apply(), so this site is
    // unchanged and still reachable.
    ['a parsed-but-illegal argument', 'claim(wizard)'],
  ];

  for (const [label, bad] of SEQUENTIAL_CASES) {
    it(`a third strike in the one-mover DEFENCE eliminates and advances once — ${label}`, () => {
      const t = makeTable(`defence-${label.replace(/\W+/g, '-')}`);
      const VICTIM: PlayerId = 'p4';

      // night: the victim sleeps through it and takes strike 1.
      submitRest(t, [VICTIM], () => ({ index: 0 }));
      fireDeadline(t);
      // talk r0: everybody accuses the victim, which makes it the defender;
      // it is absent again and takes strike 2.
      submitRest(t, [VICTIM], () => `accuse(${VICTIM})`);
      fireDeadline(t);
      // talk r1: the victim answers this one, so it enters the defence with
      // exactly two strikes and the defence is the phase that kills it.
      for (const p of t.core.waitingFor()) expect(submit(t, p, { index: 0 }).ok).toBe(true);

      const st = stateOf(t.core);
      expect(st.phase).toBe('day_defense');
      expect(st.defender).toBe(VICTIM);
      expect(t.core.playersToMoveNow()).toEqual([VICTIM]);
      expect(t.core.strikes[VICTIM]).toBe(2);
      const turn = t.core.turnIndex;

      expect((submit(t, VICTIM, bad) as SubmitReject).illegal_attempt).toBe(1);
      expect((submit(t, VICTIM, bad) as SubmitReject).illegal_attempt).toBe(2);
      const third = submit(t, VICTIM, bad) as SubmitOk;
      expect(third.ok).toBe(true);

      // Eliminated, and the turn advanced EXACTLY once — nothing was applied
      // at it, so without that advance the survivors would inherit a stale
      // deadline and a stale illegal-attempt count.
      expect(t.core.status).toBe('running');
      expect(t.core.strikes[VICTIM]).toBe(3);
      expect(t.core.turnIndex).toBe(turn + 1);
      expect(eliminated(t.core)).toEqual([VICTIM]);
      expect(atTurn(t.core, 'move', turn)).toEqual([]);
      expect(atTurn(t.core, 'timeout', turn)).toEqual([]);

      // forfeitPlayer opened the ballot rather than leaving a phase whose only
      // mover is dead — the zero-mover state the room throws on.
      const after = stateOf(t.core);
      expect(after.phase).toBe('day_vote');
      expect(after.defender).toBeNull();
      expect(t.core.playersToMoveNow()).toHaveLength(7);
      for (const p of SEATS) if (p !== VICTIM) expect(t.core.strikes[p], p).toBe(0);
      // No words were ever put in the dead seat's mouth.
      for (const u of after.transcript) if (u.speaker === VICTIM) expect(u.text).toBe('');

      playOutSilently(t);
      expect(t.core.result?.reason).not.toBe('forfeit');
      expect(verifyReplay(t.core.replayFile()!, { werewolf }).ok).toBe(true);
    });
  }

  it('eight seats striking out at once end on a REAL result, never a seven-winner forfeit', () => {
    // The pathological table: nobody ever answers. Every seat reaches three
    // strikes in the same phase, so eliminate() is called eight times inside
    // ONE resolution loop. Two things must survive that: the game must end on
    // its own terminal condition (a whole team wins, dead members included),
    // and the seats the terminal state overtook must not be struck for a
    // phase the game had already left.
    const t = makeTable('mass-elimination');
    expect(t.core.clocks.perSideMs, 'a side cap would make ONE slow seat set a 1 ms deadline for all eight').toBeNull();

    fireDeadline(t); // night   -> strike 1 for all eight
    fireDeadline(t); // talk r0 -> strike 2 for all eight
    for (const p of SEATS) expect(t.core.strikes[p]).toBe(2);
    const turn = t.core.turnIndex;
    fireDeadline(t); // talk r1 -> the third strike, eight times over

    expect(t.core.status).toBe('ended');
    expect(t.core.turnIndex, 'advanceTurn must still run exactly once for the phase').toBe(turn + 1);

    // NOT a forfeit: the result is the game's own, and the winners are a whole
    // team — never the seven seats that happened to strike out later.
    const result = t.core.result!;
    expect(result.reason).not.toBe('forfeit');
    expect(['village', 'wolves']).toContain(result.reason);
    expect(result.draw).toBe(false);
    expect([2, 6]).toContain(result.winners.length);
    expect(result.winners.length).not.toBe(7);

    // Every logged forfeit is the ELIMINATION shape (a state entry), never the
    // terminal one, and never the flag-fall reason werewolf cannot reach.
    const forfeits = entries(t.core, 'forfeit');
    expect(forfeits.length).toBeGreaterThan(0);
    // Strictly fewer than eight: the loop stops eliminating the moment the
    // state goes terminal, because playersToMove() on a finished game is empty
    // and the guard at the top of the iteration skips every remaining seat.
    // Without that guard, forfeitPlayer would decline (it returns null on a
    // terminal state), eliminate() would fall back to the TERMINAL forfeit,
    // and the game would end with seven "winners" and a result verifyReplay
    // could not reconcile with isTerminal.
    expect(forfeits.length).toBeLessThan(8);
    for (const f of forfeits) {
      expect(f.payload['state_hash'], 'a terminal forfeit here would end the table').toBeDefined();
      expect(f.payload['reason']).toBe('three_strikes');
      expect(f.signature).toBeNull();
    }

    // The seats the terminal state overtook kept two strikes: the playersToMove
    // guard skipped them BEFORE recordStrike, so nobody is charged for a phase
    // that no longer existed. Nothing was applied at the phase at all.
    const st = stateOf(t.core);
    const gone = new Set(eliminated(t.core));
    for (const p of SEATS) {
      expect(t.core.strikes[p], p).toBe(gone.has(p) ? 3 : 2);
      expect(st.cause[p], p).toBe(gone.has(p) ? 'abandoned' : undefined);
    }
    expect(atTurn(t.core, 'timeout', turn)).toEqual([]);

    const report = verifyReplay(t.core.replayFile()!, { werewolf });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('a held move is never rejected at resolution, so the two substitution sites stay unreachable', () => {
    // core.ts:1260 and :1326 substitute a seeded random legal move when the
    // state shifted under a held submission — in a wolf's case, six of seven
    // legal night moves are kills, so a substitution can order a killing the
    // agent never asked for. Werewolf is built so that cannot happen: apply()
    // writes only slot-map keys, settle() materialises in seat order, and no
    // mover's move changes another mover's legal set. This is that property
    // restated at the ROOM level, under a submission order that is not seat
    // order — the only order the resolution loop does not use.
    for (const tag of ['scramble-a', 'scramble-b']) {
      const t = makeTable(tag);
      const pick = seed(`pick:${tag}`);
      let phases = 0;
      while (t.core.status === 'running') {
        expect(phases++, 'the room never terminated').toBeLessThan(60);
        const movers = t.core.playersToMoveNow();
        expect(movers.length, 'LIVENESS: running room with nobody to move').toBeGreaterThan(0);
        for (const p of pick.shuffle(`order:${phases}`, movers)) {
          const legal = legalMoves(stateOf(t.core), p as Seat);
          expect(legal.length).toBeGreaterThan(0);
          expect(submit(t, p, { index: pick.int(`move:${phases}`, legal.length) }).ok).toBe(true);
          if (t.core.status !== 'running') break;
        }
      }
      // Zero strikes, zero substitutions, zero eliminations: every seat played
      // exactly the move it chose.
      for (const p of SEATS) expect(t.core.strikes[p], `${tag} ${p}`).toBe(0);
      for (const e of entries(t.core, 'move')) expect(e.payload['forced']).toBeUndefined();
      expect(entries(t.core, 'forfeit')).toEqual([]);
      expect(entries(t.core, 'strike')).toEqual([]);
      expect(verifyReplay(t.core.replayFile()!, { werewolf }).ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. E4 — resign and the draw, both branches, both orders
// ---------------------------------------------------------------------------

describe('no seat can end a werewolf table by protocol instead of by play', () => {
  it('resign is refused BEFORE the mover check — even from a seat the game has eliminated', () => {
    const t = makeTable('resign-dead');
    const VICTIM: PlayerId = 'p5';
    strikeTwice(t, VICTIM);
    submitRest(t, [VICTIM], () => ({ index: 0 }));
    fireDeadline(t);
    expect(stateOf(t.core).alive[VICTIM]).toBe(false);

    // THE ORDERING CLAIM. core.ts checks `resign` before the mover check, so
    // the ONLY thing standing between a dead seat and a seven-winner
    // resignation is meta.allowsResign === false. A `not_your_turn` here would
    // mean the gate is being done by the mover check, which a LIVING
    // non-mover would sail straight past.
    const dead = submit(t, VICTIM, { index: 0 }, { resign: true }) as SubmitReject;
    expect(dead.ok).toBe(false);
    expect(dead.code).toBe('resign_unavailable');

    expect(t.core.status).toBe('running');
    expect(entries(t.core, 'resign')).toEqual([]);
    for (const p of SEATS) if (p !== VICTIM) expect(t.core.strikes[p], p).toBe(0);

    // …and a LIVING seat that is not to move gets the same answer, in the one
    // phase where "not to move" is a real state for a living seat: the
    // defence. `not_your_turn` here would mean the mover check is doing the
    // work — and the mover check is exactly what the resign branch skips.
    const d = makeTable('resign-bystander');
    toDefence(d, 'p6');
    const living = submit(d, 'p0', { index: 0 }, { resign: true }) as SubmitReject;
    expect(living.ok).toBe(false);
    expect(living.code).toBe('resign_unavailable');
    expect(d.core.status).toBe('running');
    expect(entries(d.core, 'resign')).toEqual([]);
  });

  it('NEGATIVE CONTROL: the same submission ends the table when the flag is not set', () => {
    // Without this, the test above has only shown that a room refused
    // something — not that the refusal is what saved the game. Werewolf with
    // meta.allowsResign left at its default hands seven seats the win on a
    // single signed request from the eighth.
    const resignable: AnyGame = {
      ...werewolf,
      meta: { ...werewolf.meta, allowsResign: true },
    };
    const t = makeTable('resign-control', resignable);
    const r = submit(t, 'p5', { index: 0 }, { resign: true }) as SubmitOk;
    expect(r.ok).toBe(true);
    expect(t.core.status).toBe('ended');
    expect(t.core.result?.reason).toBe('resignation');
    expect(t.core.result?.winners).toEqual(SEATS.filter((p) => p !== 'p5'));
  });

  it('a draw OFFER in the one-mover defence is refused by the new gate, and registers nothing', () => {
    // The pre-existing rejection at core.ts:826 only covers simultaneous
    // phases, so a test that merely asserts the CODE would pass even with the
    // meta flag unwired. day_defense has exactly one mover: :826 does not
    // fire, the offer would reach commitApplied and be registered with
    // validAtTurn = turn + 1 — i.e. acceptable by any living seat on the
    // ballot. The message and the absent side effect are what pin the new code.
    const t = makeTable('draw-defence');
    toDefence(t, 'p6');

    const r = submit(t, 'p6', { index: 0 }, { draw_offer: true }) as SubmitReject;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('draw_offer_unavailable');
    expect(r.message, 'this is the SIMULTANEOUS-phase message, not the new gate').not.toContain('simultaneous');
    expect(r.message).toContain('not available in this game');

    // Nothing was registered, nothing was logged, and the turn is untouched.
    expect(t.core.snapshot().pendingDrawOffer).toBeNull();
    expect(entries(t.core, 'draw_offer')).toEqual([]);
    expect(t.core.strikes['p6']).toBe(0);
    expect(t.core.status).toBe('running');
  });

  it('the draw-ACCEPT branch cannot slip past the simultaneous guard', () => {
    // The accept branch runs BEFORE the `movers.length > 1` rejection, so an
    // offer that exists at a simultaneous turn is accepted by the first seat
    // that asks — eight movers or not. Werewolf can no longer produce such an
    // offer, so it is planted directly on a genuine mid-game snapshot: the
    // question under test is the branch ORDER, not how the offer got there.
    const t = makeTable('draw-accept');
    submitRest(t, [], () => ({ index: 0 })); // night
    submitRest(t, [], () => ({ index: 0 })); // talk r0
    submitRest(t, [], () => ({ index: 0 })); // talk r1
    expect(stateOf(t.core).phase).toBe('day_vote');
    expect(t.core.playersToMoveNow()).toHaveLength(8);

    const planted = (): RoomSnapshot => {
      const snap = structuredClone(t.core.snapshot()) as RoomSnapshot;
      snap.pendingDrawOffer = { by: playerId(0), validAtTurn: snap.turnIndex };
      return snap;
    };

    const guarded = RoomCore.hydrate(werewolf, planted());
    const sub: MoveSubmission = {
      game_id: t.gameId,
      turn_index: guarded.turnIndex,
      move: { index: 0 },
      draw_offer: true,
    };
    const sig = signEd25519(seatOf(t, 'p1').secretKey, moveSignMessage(t.gameId, guarded.turnIndex, sub));
    const r = guarded.submitMove(t.now + 100, 'agent-1', sub, sig) as SubmitReject;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('draw_offer_unavailable');
    expect(r.message).toContain('not available in this game');
    expect(guarded.status).toBe('running');
    expect(guarded.result).toBeNull();
    expect(guarded.log.filter((e) => e.kind === 'draw_accept')).toHaveLength(0);

    // NEGATIVE CONTROL: the identical fixture with the flag unset ends the
    // game — eight movers, `winners: []`, reason 'agreement'. Two seats out of
    // eight would have decided a hidden-role game between them, and the
    // offline verifier signs it off as a clean draw, which is exactly why the
    // gate has to precede the accept branch rather than follow it.
    const drawable: AnyGame = { ...werewolf, meta: { ...werewolf.meta, allowsDrawOffer: true } };
    const open = RoomCore.hydrate(drawable, planted());
    const r2 = open.submitMove(t.now + 100, 'agent-1', sub, sig) as SubmitOk;
    expect(r2.ok).toBe(true);
    expect(open.status).toBe('ended');
    expect(open.result).toMatchObject({ winners: [], draw: true, reason: 'agreement' });
    expect(open.log.filter((e) => e.kind === 'draw_accept')).toHaveLength(1);
    const report = verifyReplay(open.replayFile()!, { werewolf: drawable });
    expect(report.ok, 'the forged draw verifies offline — the room is the only line of defence').toBe(true);
  });
});
