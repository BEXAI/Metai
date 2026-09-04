/**
 * RED TEAM red-team-rules — werewolf (spec games.werewolf, acceptance A1/A6/A11).
 *
 * Werewolf is the first game in the hall where a seat can be removed while the
 * table plays on, where three of five phases are simultaneous, and where the
 * substance of a move is free text. Each of those is a liveness surface the
 * twelve board games never had, so the attacks here are aimed at three things:
 *
 *  1. RULES. Hostile move bodies must become structured RuleErrors, never
 *     exceptions — a thrown TypeError inside apply() kills the room AND the
 *     offline verifier. Out-of-phase verbs, dead seats acting, targeting the
 *     dead, and a wolf eating its own pack must all be rejected by apply()
 *     with a specific code and no state mutation.
 *  2. THE ORACLE RULE (plan §4.6). A RuleError whose REACHABILITY depends on a
 *     hidden role is a role oracle any seat can query for free. apply() may
 *     branch on roles[actor] for night verbs only.
 *  3. LIVENESS. playersToMove() must never be [] while isTerminal() is null —
 *     rooms/core.ts throws "running but no one is to move" and rooms/room.ts
 *     catches that into a permanent 5-second alarm loop while POST /move
 *     returns 500 forever. That invariant is attacked here with hostile
 *     pickers AND by driving a real 8-seat RoomCore: a silent seat at night, a
 *     table where nobody submits at all, a seat that abandons and is
 *     eliminated mid-phase, a defence nobody answers, and a vote that
 *     deadlocks every single day for the whole game.
 *
 * Deterministic only: seeded SeedStreams, sha256-derived keys, explicit nowMs.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/crypto/canonical.ts';
import { signEd25519 } from '../../src/crypto/ed25519.ts';
import { publicKeyOf } from '../../src/identity/ed25519.ts';
import { createSeedStream } from '../../src/kernel/seed.ts';
import {
  isRuleError,
  playerId,
  type GameEvent,
  type Json,
  type MoveSubmission,
  type PlayerId,
  type RuleError,
  type SeedStream,
} from '../../src/kernel/types.ts';
import { verifyReplay } from '../../src/kernel/verify.ts';
import {
  moveSignMessage,
  RoomCore,
  type RoomSeat,
  type SubmitOk,
  type SubmitReject,
} from '../../src/rooms/core.ts';
import werewolf from '../../src/games/werewolf/index.ts';
import { DAY_LIMIT, MAX_SPEECH_CHARS, type Role } from '../../src/games/werewolf/board.ts';
import {
  applyMove,
  createInitialState,
  defaultMove,
  forfeitPlayer,
  isTerminal,
  legalMoves,
  livingSeats,
  playersToMove,
  type Seat,
  type WwMove,
  type WwState,
} from '../../src/games/werewolf/rules.ts';

const SEATS: PlayerId[] = Array.from({ length: 8 }, (_, i) => playerId(i));

const seed = (tag: string): SeedStream => createSeedStream(sha256Hex(`redteam-rules-werewolf:${tag}`));

// ---------------------------------------------------------------------------
// Pure-rules helpers
// ---------------------------------------------------------------------------

function fresh(tag = 'base'): WwState {
  return createInitialState(seed(`deal:${tag}`), SEATS, {});
}

/** apply() must have succeeded; returns the new state. */
function must(r: ReturnType<typeof applyMove>): WwState {
  if (isRuleError(r)) throw new Error(`unexpected RuleError ${r.code}: ${r.message}`);
  return r.state;
}

/** apply() must have been rejected — and must not have thrown getting there. */
function reject(fn: () => ReturnType<typeof applyMove>): RuleError {
  let out: ReturnType<typeof applyMove> | undefined;
  expect(() => {
    out = fn();
  }).not.toThrow();
  if (out === undefined || !isRuleError(out)) {
    throw new Error(`expected a RuleError, got ${JSON.stringify(out)}`);
  }
  return out;
}

function seatsWithRole(s: WwState, role: Role): Seat[] {
  return s.players.filter((p) => s.roles[p] === role);
}

type Chooser = (s: WwState, p: Seat, legal: WwMove[], pick: (n: number) => number) => WwMove;

/**
 * Applies one move for every seat the phase is waiting on, in the order
 * playersToMove reports — exactly the discipline rooms/core.ts uses when it
 * replays held submissions, and the one kernel/playout.ts and kernel/leakage.ts
 * both rely on (they capture playersToMove ONCE).
 */
function playPhase(s: WwState, choose: Chooser, tag = 'phase'): { state: WwState; events: GameEvent[] } {
  const movers = playersToMove(s);
  expect(movers.length, `no movers in phase ${s.phase} day ${s.day}`).toBeGreaterThan(0);
  const pickSeed = seed(`pick:${tag}`);
  const applySeed = seed(`apply:${tag}`);
  let state = s;
  let events: GameEvent[] = [];
  for (const p of movers) {
    const legal = legalMoves(state, p);
    expect(legal.length, `${p} to move with no legal moves in ${state.phase}`).toBeGreaterThan(0);
    const applied = applyMove(state, p, choose(state, p, legal, (n) => pickSeed.int('pick', n)), applySeed);
    if (isRuleError(applied)) {
      throw new Error(`apply rejected its own legal move for ${p}: ${applied.code}: ${applied.message}`);
    }
    state = applied.state;
    events = applied.events;
  }
  return { state, events };
}

/** Everyone takes the null act: stay_in / sleep / say '' / abstain. */
const silent: Chooser = (s, p, legal) => {
  expect(defaultMove(s, p, legal)).toEqual(legal[0]);
  return legal[0]!;
};

/** A full night in which the lowest-seat wolf eats `victim` and nobody guards. */
function nightKilling(s: WwState, victim: Seat, tag = 'kill'): WwState {
  const wolf = seatsWithRole(s, 'werewolf').filter((p) => s.alive[p] === true)[0]!;
  return playPhase(
    s,
    (st, p, legal) => (p === wolf ? { t: 'kill', target: victim, text: '' } : silent(st, p, legal, () => 0)),
    tag,
  ).state;
}

/** night -> talk r0 -> talk r1, everybody silent: lands in day_vote. */
function toDayVote(s: WwState, tag = 'to-vote'): WwState {
  let st = playPhase(s, silent, `${tag}:night`).state;
  expect(st.phase).toBe('day_talk');
  st = playPhase(st, silent, `${tag}:r0`).state;
  st = playPhase(st, silent, `${tag}:r1`).state;
  expect(st.phase).toBe('day_vote'); // nobody was accused, so the defence is skipped
  return st;
}

// ---------------------------------------------------------------------------
// 1. Hostile move bodies MUST be RuleErrors, never exceptions
// ---------------------------------------------------------------------------

describe('malformed werewolf moves MUST be RuleErrors, never exceptions', () => {
  it('null, undefined, non-objects and missing discriminants are rejected structurally', () => {
    const st = fresh('malformed');
    const bads: unknown[] = [
      null,
      undefined,
      42,
      'kill(p1)',
      [],
      {},
      { t: 5, text: '' },
      { t: 'kill' }, // no text
      { t: 'kill', target: 'p1' }, // no text
      { t: 'sleep', text: null },
      { t: 'sleep', text: 12345 },
      { t: 'sleep', text: { toString: () => 'x' } },
      { t: 'not_a_verb', text: '' },
      { t: 'kill', target: null, text: '' },
      { t: 'kill', target: { seat: 'p1' }, text: '' },
      { t: 'kill', target: ['p1'], text: '' },
    ];
    for (const bad of bads) {
      const r = reject(() => applyMove(st, 'p0', bad as WwMove, seed('m')));
      expect(typeof r.code, JSON.stringify(bad)).toBe('string');
      expect(typeof r.message).toBe('string');
    }
  });

  it('a rejected move mutates nothing: the previous state is byte-identical', () => {
    const st = fresh('immutable');
    const before = JSON.stringify(st);
    reject(() => applyMove(st, 'p0', { t: 'vote', target: 'p1', text: '' }, seed('m')));
    reject(() => applyMove(st, 'p0', { t: 'kill', target: 'p99', text: '' }, seed('m')));
    reject(() => applyMove(st, 'p0', { t: 'say', text: 'x'.repeat(5_000) }, seed('m')));
    expect(JSON.stringify(st)).toBe(before);
  });

  it('over-length and un-normalised text are RuleErrors that do not consume the turn', () => {
    let st = fresh('text');
    st = playPhase(st, silent, 'text:night').state; // -> day_talk, cap 600

    const tooLong = reject(() => applyMove(st, 'p0', { t: 'say', text: 'x'.repeat(MAX_SPEECH_CHARS + 1) }, seed('m')));
    expect(tooLong.code).toBe('text_too_long');
    expect(tooLong.message).toContain(String(MAX_SPEECH_CHARS + 1)); // the count, so the agent can shorten

    // A newline would break out of a fenced transcript line; the parser strips
    // it, so a hand-built move carrying one must fail LOUDLY here rather than
    // silently diverging a replay.
    const raw = reject(() => applyMove(st, 'p0', { t: 'say', text: 'line one\nline two' }, seed('m')));
    expect(raw.code).toBe('unnormalized_text');

    // The turn was never consumed: p0 is still to move and can still speak.
    expect(playersToMove(st)).toContain('p0');
    expect(isRuleError(applyMove(st, 'p0', { t: 'say', text: 'line one line two' }, seed('m')))).toBe(false);
  });

  it('an unknown role or verdict argument parses but is rejected by name', () => {
    let st = fresh('args');
    st = playPhase(st, silent, 'args:night').state;
    expect(reject(() => applyMove(st, 'p0', { t: 'claim', role: 'wizard', text: '' }, seed('m'))).code).toBe('bad_role');
    expect(
      reject(() => applyMove(st, 'p0', { t: 'report', target: 'p1', verdict: 'wizard', text: '' }, seed('m'))).code,
    ).toBe('bad_verdict');
  });
});

// ---------------------------------------------------------------------------
// 2. Out-of-phase verbs
// ---------------------------------------------------------------------------

describe('phase gating: every verb is legal in exactly one kind of phase', () => {
  it('night rejects every day verb, and day rejects every night verb', () => {
    const night = fresh('phases');
    const dayVerbs: WwMove[] = [
      { t: 'say', text: '' },
      { t: 'accuse', target: 'p1', text: '' },
      { t: 'defend', target: 'p1', text: '' },
      { t: 'claim', role: 'seer', text: '' },
      { t: 'report', target: 'p1', verdict: 'wolf', text: '' },
      { t: 'vote', target: 'p1', text: '' },
      { t: 'abstain', text: '' },
    ];
    for (const p of SEATS) {
      for (const m of dayVerbs) {
        expect(reject(() => applyMove(night, p, m, seed('m'))).code, `${p} ${m.t} at night`).toBe('wrong_act');
      }
    }

    const talk = playPhase(night, silent, 'phases:night').state;
    expect(talk.phase).toBe('day_talk');
    const nightVerbs: WwMove[] = [
      { t: 'kill', target: 'p1', text: '' },
      { t: 'stay_in', text: '' },
      { t: 'peek', target: 'p1', text: '' },
      { t: 'guard', target: 'p1', text: '' },
      { t: 'sleep', text: '' },
      { t: 'vote', target: 'p1', text: '' },
      { t: 'abstain', text: '' },
    ];
    for (const m of nightVerbs) {
      expect(reject(() => applyMove(talk, 'p0', m, seed('m'))).code, `${m.t} in day_talk`).toBe('wrong_act');
    }
  });

  it('day_vote takes only vote/abstain, and day_talk verbs are rejected there', () => {
    const vote = toDayVote(fresh('phases2'), 'phases2');
    for (const m of [
      { t: 'say', text: '' },
      { t: 'accuse', target: 'p1', text: '' },
      { t: 'claim', role: 'seer', text: '' },
      { t: 'report', target: 'p1', verdict: 'wolf', text: '' },
      { t: 'sleep', text: '' },
    ] as WwMove[]) {
      expect(reject(() => applyMove(vote, 'p0', m, seed('m'))).code, `${m.t} in day_vote`).toBe('wrong_act');
    }
    expect(isRuleError(applyMove(vote, 'p0', { t: 'abstain', text: '' }, seed('m')))).toBe(false);
    expect(isRuleError(applyMove(vote, 'p0', { t: 'vote', target: 'p1', text: '' }, seed('m')))).toBe(false);
  });

  it('a seat that has already acted in a simultaneous phase cannot act twice', () => {
    const night = fresh('twice');
    const after = must(applyMove(night, 'p0', { t: 'sleep', text: '' }, seed('m')));
    expect(playersToMove(after)).not.toContain('p0');
    expect(legalMoves(after, 'p0')).toEqual([]);
    expect(reject(() => applyMove(after, 'p0', { t: 'sleep', text: '' }, seed('m'))).code).toBe('not_your_turn');
  });

  it('only the accused answers the defence; every other living seat is not_your_turn', () => {
    // p1 is the sole accused, so the defence exists and has exactly one mover.
    let st = playPhase(fresh('defence'), silent, 'defence:night').state;
    st = playPhase(st, (s, p, legal) => (p === 'p0' ? { t: 'accuse', target: 'p1', text: '' } : legal[0]!), 'defence:r0').state;
    st = playPhase(st, silent, 'defence:r1').state;
    expect(st.phase).toBe('day_defense');
    expect(playersToMove(st)).toEqual(['p1']);
    for (const p of SEATS) {
      if (p === 'p1') continue;
      expect(reject(() => applyMove(st, p, { t: 'say', text: '' }, seed('m'))).code, p).toBe('not_your_turn');
      expect(legalMoves(st, p)).toEqual([]);
    }
    const after = must(applyMove(st, 'p1', { t: 'say', text: 'I am not the wolf' }, seed('m')));
    expect(after.phase).toBe('day_vote'); // the defence never leaves a zero-mover state
    expect(playersToMove(after)).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// 3. Dead seats
// ---------------------------------------------------------------------------

describe('a dead seat can never act again, in any phase', () => {
  it('the night victim is refused in day_talk, day_vote and the next night', () => {
    const s0 = fresh('dead');
    const victim = s0.players.find((p) => s0.roles[p] !== 'werewolf')!;
    let st = nightKilling(s0, victim, 'dead');
    expect(st.alive[victim]).toBe(false);
    expect(st.cause[victim]).toBe('wolves');
    expect(st.revealed[victim]).toBe(s0.roles[victim]);

    // day_talk: every speech act, from a corpse.
    for (const m of [
      { t: 'say', text: '' },
      { t: 'accuse', target: 'p0', text: '' },
      { t: 'defend', target: 'p0', text: '' },
      { t: 'claim', role: 'seer', text: '' },
      { t: 'report', target: 'p0', verdict: 'wolf', text: '' },
    ] as WwMove[]) {
      expect(reject(() => applyMove(st, victim, m, seed('m'))).code, m.t).toBe('dead');
    }
    expect(playersToMove(st)).not.toContain(victim);
    expect(legalMoves(st, victim)).toEqual([]);

    st = playPhase(st, silent, 'dead:r0').state;
    st = playPhase(st, silent, 'dead:r1').state;
    expect(st.phase).toBe('day_vote');
    expect(reject(() => applyMove(st, victim, { t: 'vote', target: 'p0', text: '' }, seed('m'))).code).toBe('dead');
    expect(reject(() => applyMove(st, victim, { t: 'abstain', text: '' }, seed('m'))).code).toBe('dead');

    st = playPhase(st, silent, 'dead:vote').state;
    expect(st.phase).toBe('night');
    expect(st.day).toBe(2);
    expect(reject(() => applyMove(st, victim, { t: 'sleep', text: '' }, seed('m'))).code).toBe('dead');
    expect(reject(() => applyMove(st, victim, { t: 'kill', target: 'p0', text: '' }, seed('m'))).code).toBe('dead');
    expect(playersToMove(st)).toHaveLength(7);
  });

  it('a seat id that was never seated is refused exactly like a dead one', () => {
    const st = fresh('ghost');
    expect(reject(() => applyMove(st, 'p99', { t: 'sleep', text: '' }, seed('m'))).code).toBe('dead');
    expect(legalMoves(st, 'p99')).toEqual([]);
  });

  it('nothing at all is accepted once the game is over', () => {
    // Drive to the wolves' win, then attack the terminal state.
    let st = fresh('over');
    let guard = 0;
    while (isTerminal(st) === null && guard++ < 40) {
      if (st.phase === 'night') {
        const wolf = seatsWithRole(st, 'werewolf').filter((p) => st.alive[p] === true)[0]!;
        const prey = livingSeats(st).find((p) => st.roles[p] !== 'werewolf')!;
        st = playPhase(st, (s, p, legal) => (p === wolf ? { t: 'kill', target: prey, text: '' } : legal[0]!), `over:${guard}`).state;
      } else {
        st = playPhase(st, silent, `over:${guard}`).state;
      }
    }
    const term = isTerminal(st)!;
    expect(term.reason).toBe('wolves');
    expect(st.phase).toBe('over');
    expect(playersToMove(st)).toEqual([]);
    for (const p of SEATS) {
      expect(legalMoves(st, p)).toEqual([]);
      expect(reject(() => applyMove(st, p, { t: 'sleep', text: '' }, seed('m'))).code).toBe('game_over');
    }
    // Winners are the whole team, dead members included.
    expect(term.winners).toEqual(seatsWithRole(st, 'werewolf'));
    expect(term.draw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Targeting the dead
// ---------------------------------------------------------------------------

describe('the dead are not targets: no vote, no accusation, no check, no second kill', () => {
  it('every targeting verb rejects a dead seat, and no legal move offers one', () => {
    const s0 = fresh('targets');
    const victim = s0.players.find((p) => s0.roles[p] !== 'werewolf' && p !== 'p0')!;
    let st = nightKilling(s0, victim, 'targets');
    expect(st.alive[victim]).toBe(false);

    // day_talk: accuse / defend / report a corpse.
    const speaker = livingSeats(st)[0]!;
    for (const m of [
      { t: 'accuse', target: victim, text: '' },
      { t: 'defend', target: victim, text: '' },
      { t: 'report', target: victim, verdict: 'wolf', text: '' },
    ] as WwMove[]) {
      expect(reject(() => applyMove(st, speaker, m, seed('m'))).code, m.t).toBe('bad_target');
    }
    for (const m of legalMoves(st, speaker)) {
      expect((m as { target?: string }).target, `legal_moves offered the dead ${victim}`).not.toBe(victim);
    }

    // day_vote: vote a corpse, and vote a seat that never existed.
    st = playPhase(st, silent, 'targets:r0').state;
    st = playPhase(st, silent, 'targets:r1').state;
    expect(st.phase).toBe('day_vote');
    expect(reject(() => applyMove(st, speaker, { t: 'vote', target: victim, text: '' }, seed('m'))).code).toBe('bad_target');
    expect(reject(() => applyMove(st, speaker, { t: 'vote', target: 'p99', text: '' }, seed('m'))).code).toBe('bad_target');
    expect(reject(() => applyMove(st, speaker, { t: 'vote', target: '', text: '' }, seed('m'))).code).toBe('bad_target');
    for (const m of legalMoves(st, speaker)) {
      expect((m as { target?: string }).target).not.toBe(victim);
    }

    // the next night: kill / peek / guard a corpse.
    st = playPhase(st, silent, 'targets:vote').state;
    expect(st.phase).toBe('night');
    const wolf = seatsWithRole(st, 'werewolf').filter((p) => st.alive[p] === true)[0]!;
    const seer = seatsWithRole(st, 'seer').filter((p) => st.alive[p] === true)[0];
    const doctor = seatsWithRole(st, 'doctor').filter((p) => st.alive[p] === true)[0];
    expect(reject(() => applyMove(st, wolf, { t: 'kill', target: victim, text: '' }, seed('m'))).code).toBe('bad_target');
    if (seer !== undefined) {
      expect(reject(() => applyMove(st, seer, { t: 'peek', target: victim, text: '' }, seed('m'))).code).toBe('bad_target');
    }
    if (doctor !== undefined) {
      expect(reject(() => applyMove(st, doctor, { t: 'guard', target: victim, text: '' }, seed('m'))).code).toBe('bad_target');
    }
  });

  it('a seat eliminated mid-ballot drops out of the tally and cannot be lynched posthumously', () => {
    const st0 = toDayVote(fresh('midballot'), 'midballot');
    const doomed = 'p3';
    // Every other seat votes for p3; p3 itself has not voted yet.
    let st = st0;
    for (const p of playersToMove(st0)) {
      if (p === doomed) continue;
      st = must(applyMove(st, p, { t: 'vote', target: doomed, text: '' }, seed('m')));
    }
    expect(playersToMove(st)).toEqual([doomed]);

    // p3 abandons its seat before casting. The seven ballots are already in.
    const out = forfeitPlayer(st, doomed)!;
    expect(out).not.toBeNull();
    const after = out.state;
    expect(after.cause[doomed]).toBe('abandoned');
    const round = after.voteHistory.find((v) => v.day === st.day)!;
    expect(round.lynched).toBeNull(); // seven votes for a seat that is no longer living
    // Exactly ONE seat died this day, and the other seven are untouched.
    expect(livingSeats(after)).toHaveLength(7);
    expect(isTerminal(after)).toBeNull();
    expect(playersToMove(after).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. The pack does not eat its own — and the oracle rule
// ---------------------------------------------------------------------------

describe('wolf targeting and the role-oracle rule', () => {
  it("a wolf's kill list excludes the pack, and killing a packmate is a named RuleError", () => {
    const st = fresh('pack');
    const pack = seatsWithRole(st, 'werewolf');
    expect(pack).toHaveLength(2);
    const [w0, w1] = pack as [Seat, Seat];

    // legal_moves: stay_in + every living NON-wolf. Nothing targets the pack.
    for (const w of pack) {
      const legal = legalMoves(st, w);
      expect(legal[0]).toEqual({ t: 'stay_in', text: '' });
      expect(legal).toHaveLength(1 + 6);
      for (const m of legal) {
        if (m.t !== 'kill') continue;
        expect(pack).not.toContain(m.target);
      }
    }

    // Submitting it anyway is rejected — and so is eating yourself.
    const own = reject(() => applyMove(st, w0, { t: 'kill', target: w1, text: '' }, seed('m')));
    expect(own.code).toBe('bad_target');
    expect(own.message).toBe('the pack does not eat its own');
    expect(reject(() => applyMove(st, w0, { t: 'kill', target: w0, text: '' }, seed('m'))).code).toBe('bad_target');
  });

  it('a non-wolf gets the SAME rejection for kill() whatever the target really is', () => {
    // ORACLE RULE. If the message or the code differed between a wolf target
    // and a villager target, every villager could read the whole role map by
    // submitting kill() eight times and diffing the rejections. apply() may
    // branch on roles[actor] at night; it must never branch on roles[target].
    const st = fresh('oracle');
    const villager = seatsWithRole(st, 'villager')[0]!;
    const wolf = seatsWithRole(st, 'werewolf')[0]!;
    const seer = seatsWithRole(st, 'seer')[0]!;
    const otherVillager = seatsWithRole(st, 'villager')[1]!;

    const answers = [wolf, seer, otherVillager].map((target) =>
      reject(() => applyMove(st, villager, { t: 'kill', target, text: '' }, seed('m'))),
    );
    for (const a of answers) {
      expect(a.code).toBe(answers[0]!.code);
      expect(a.message).toBe(answers[0]!.message);
    }
    // The same for the seer and the doctor's wrong-verb rejections.
    for (const bogus of [wolf, otherVillager]) {
      const r = reject(() => applyMove(st, seer, { t: 'guard', target: bogus, text: '' }, seed('m')));
      expect(r.code).toBe('wrong_act');
    }
  });

  it('the seer may check anyone but itself, and the check never changes what is legal', () => {
    const st = fresh('seer');
    const seer = seatsWithRole(st, 'seer')[0]!;
    expect(reject(() => applyMove(st, seer, { t: 'peek', target: seer, text: '' }, seed('m'))).code).toBe('bad_target');
    // Checking a wolf and checking a villager are equally legal: the verdict is
    // private to the seer, and nothing about the acceptance depends on it.
    for (const target of SEATS.filter((p) => p !== seer)) {
      expect(isRuleError(applyMove(st, seer, { t: 'peek', target, text: '' }, seed('m'))), target).toBe(false);
    }
    expect(legalMoves(st, seer)).toHaveLength(1 + 7);
  });

  it('the doctor may self-guard but not repeat a target on consecutive nights', () => {
    const st = fresh('doctor');
    const doctor = seatsWithRole(st, 'doctor')[0]!;
    expect(isRuleError(applyMove(st, doctor, { t: 'guard', target: doctor, text: '' }, seed('m')))).toBe(false);
    expect(legalMoves(st, doctor)).toHaveLength(1 + 8); // night 1: nobody is barred

    const guarded = SEATS.find((p) => p !== doctor)!;
    let n1 = playPhase(st, (s, p, legal) => (p === doctor ? { t: 'guard', target: guarded, text: '' } : legal[0]!), 'doctor:n1').state;
    n1 = playPhase(n1, silent, 'doctor:r0').state;
    n1 = playPhase(n1, silent, 'doctor:r1').state;
    n1 = playPhase(n1, silent, 'doctor:vote').state;
    expect(n1.phase).toBe('night');
    expect(n1.day).toBe(2);

    const repeat = reject(() => applyMove(n1, doctor, { t: 'guard', target: guarded, text: '' }, seed('m')));
    expect(repeat.code).toBe('repeat_guard');
    for (const m of legalMoves(n1, doctor)) {
      if (m.t === 'guard') expect(m.target).not.toBe(guarded);
    }
    // The bar reads only the doctor's OWN committed history, so it is
    // order-independent inside the simultaneous night.
    expect(isRuleError(applyMove(n1, doctor, { t: 'guard', target: doctor, text: '' }, seed('m')))).toBe(false);
  });

  it('claims and reports are never validated against the truth', () => {
    let st = playPhase(fresh('bluff'), silent, 'bluff:night').state;
    const liar = livingSeats(st)[0]!;
    for (const role of ['werewolf', 'seer', 'doctor', 'villager']) {
      expect(isRuleError(applyMove(st, liar, { t: 'claim', role, text: '' }, seed('m'))), role).toBe(false);
    }
    for (const target of livingSeats(st).filter((p) => p !== liar)) {
      for (const verdict of ['wolf', 'clear']) {
        expect(isRuleError(applyMove(st, liar, { t: 'report', target, verdict, text: '' }, seed('m')))).toBe(false);
      }
    }
    // …but you may not accuse or report YOURSELF (there is nothing to weigh).
    expect(reject(() => applyMove(st, liar, { t: 'accuse', target: liar, text: '' }, seed('m'))).code).toBe('bad_target');
    expect(reject(() => applyMove(st, liar, { t: 'report', target: liar, verdict: 'wolf', text: '' }, seed('m'))).code).toBe('bad_target');
    // Defending yourself IS legal, and it writes exactly one slot key.
    st = must(applyMove(st, liar, { t: 'defend', target: liar, text: '' }, seed('m')));
    expect(st.said[liar]).toEqual({ act: 'defend', target: liar, role: null, verdict: null, text: '' });
    expect(st.edges).toEqual([]); // materialised in settle(), in seat order, not here
    expect(st.transcript).toEqual([]);
    expect(st.seq).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Vote deadlock
// ---------------------------------------------------------------------------

describe('vote deadlock: a town that cannot agree must not stall the table', () => {
  it('a 4-4 tie is NO LYNCH and the game rolls straight into the next night', () => {
    const st0 = toDayVote(fresh('tie'), 'tie');
    const { state: st, events } = playPhase(
      st0,
      (_s, p) => ({ t: 'vote', target: SEATS.indexOf(p) < 4 ? 'p1' : 'p2', text: '' }),
      'tie:vote',
    );
    const round = st.voteHistory[0]!;
    expect(round.lynched).toBeNull();
    expect(livingSeats(st)).toHaveLength(8);
    const lynch = events.find((e) => e.type === 'lynch')!;
    expect((lynch.data as { reason: string }).reason).toBe('tie');
    expect((lynch.data as { seat: Seat | null }).seat).toBeNull();
    // LIVENESS: the deadlocked day still advances, and eight seats are to move.
    expect(st.phase).toBe('night');
    expect(st.day).toBe(2);
    expect(isTerminal(st)).toBeNull();
    expect(playersToMove(st)).toHaveLength(8);
  });

  it('an all-abstain ballot is NO LYNCH and reports itself as such', () => {
    const st0 = toDayVote(fresh('abstain'), 'abstain');
    const { state: st, events } = playPhase(st0, silent, 'abstain:vote');
    expect(st.voteHistory[0]!.lynched).toBeNull();
    const lynch = events.find((e) => e.type === 'lynch')!;
    expect((lynch.data as { reason: string; abstains: number }).reason).toBe('no_votes');
    expect((lynch.data as { abstains: number }).abstains).toBe(8);
    expect(livingSeats(st)).toHaveLength(8);
    expect(playersToMove(st)).toHaveLength(8);
  });

  it('a single vote against seven abstentions IS a strict plurality', () => {
    const st0 = toDayVote(fresh('single'), 'single');
    const { state: st } = playPhase(
      st0,
      (_s, p, legal) => (p === 'p0' ? { t: 'vote', target: 'p5', text: '' } : legal[0]!),
      'single:vote',
    );
    expect(st.voteHistory[0]!.lynched).toBe('p5');
    expect(st.alive['p5']).toBe(false);
    expect(st.cause['p5']).toBe('lynch');
  });

  it('a table that deadlocks EVERY day still terminates, at the day limit, for the wolves', () => {
    // The pathological liveness case: nobody ever dies. The wolves decline to
    // kill (stay_in), nobody speaks, every ballot is a full abstention. Without
    // the day limit this game would run forever.
    let st = fresh('forever');
    let phases = 0;
    while (isTerminal(st) === null) {
      expect(phases++, 'the day limit never bound').toBeLessThan(40);
      expect(playersToMove(st).length, `zero movers in ${st.phase}`).toBeGreaterThan(0);
      st = playPhase(st, silent, `forever:${phases}`).state;
    }
    const term = isTerminal(st)!;
    expect(term.reason).toBe('day_limit');
    expect(term.winners).toEqual(seatsWithRole(st, 'werewolf'));
    expect(st.day).toBe(DAY_LIMIT + 1);
    expect(livingSeats(st)).toHaveLength(8); // not a single death in the whole game
    expect(st.voteHistory).toHaveLength(DAY_LIMIT);
    expect(st.voteHistory.every((v) => v.lynched === null)).toBe(true);
    expect(playersToMove(st)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Liveness under hostile pickers (attack family 3)
// ---------------------------------------------------------------------------

/**
 * Runs one full hostile game. Throws (fails the test) on: empty playersToMove
 * in a non-terminal state, a mover with no legal moves, defaultMove escaping
 * the legal list, apply() rejecting a move from its own legal list, apply()
 * throwing, or non-termination.
 */
function hostilePlayout(tag: string, choose: Chooser, maxMoves = 400): { moves: number; reason: string; state: WwState } {
  const applySeed = seed(`hostile-apply:${tag}`);
  const pickSeed = seed(`hostile-pick:${tag}`);
  const pick = (n: number): number => pickSeed.int('pick', n);
  let state = createInitialState(seed(`hostile-deal:${tag}`), SEATS, {});
  let moves = 0;

  for (;;) {
    const term = isTerminal(state);
    if (term) return { moves, reason: term.reason, state };
    if (moves >= maxMoves) throw new Error(`werewolf/${tag}: no termination after ${maxMoves} moves`);

    const movers = playersToMove(state);
    if (movers.length === 0) {
      throw new Error(`werewolf/${tag}: DEADLOCK — non-terminal ${state.phase} day ${state.day} with nobody to move after ${moves} moves`);
    }
    for (const p of movers) {
      const legal = legalMoves(state, p);
      if (legal.length === 0) {
        throw new Error(`werewolf/${tag}: DEADLOCK — ${p} to move with zero legal moves in ${state.phase} after ${moves} moves`);
      }
      // The room's timeout path applies defaultMove without consulting the
      // list; if it ever escaped the list the clock would murder a seat.
      const d = defaultMove(state, p, legal);
      if (JSON.stringify(d) !== JSON.stringify(legal[0])) {
        throw new Error(`werewolf/${tag}: defaultMove ${JSON.stringify(d)} is not legal_moves[0] for ${p} in ${state.phase}`);
      }
      const move = choose(state, p, legal, pick);
      const applied = applyMove(state, p, move, applySeed);
      if (isRuleError(applied)) {
        throw new Error(`werewolf/${tag}: apply rejected its own legal move ${JSON.stringify(move)} -> ${applied.code}: ${applied.message}`);
      }
      state = applied.state;
      moves++;
      if (isTerminal(state)) break;
    }
  }
}

/** Take the LAST legal entry: wolves kill, the seer checks, the doctor guards. */
const predator: Chooser = (_s, _p, legal) => legal[legal.length - 1]!;

/** Accuse and lynch the lowest living seat; kill hard at night. */
const mob: Chooser = (s, _p, legal) => {
  if (s.phase === 'night') return legal[legal.length - 1]!;
  return legal[1] ?? legal[0]!; // accuse(lowest other) / vote(lowest living)
};

/** Talk endlessly, never vote: the accusation machine that lynches nobody. */
const filibuster: Chooser = (s, _p, legal, pick) => {
  if (s.phase === 'day_vote') return legal[0]!; // abstain, always
  if (s.phase === 'night') return legal[legal.length - 1]!;
  return legal[1 + pick(Math.max(1, legal.length - 1))]!;
};

/** Uniform seeded random over the whole legal list. */
const chaos: Chooser = (_s, _p, legal, pick) => legal[pick(legal.length)]!;

describe('werewolf liveness under hostile pickers (no stalls, bounded games)', () => {
  const TERMINAL_REASONS = ['village', 'wolves', 'day_limit'];

  it('predator / mob / filibuster / all-silent pickers never stall and always terminate', { timeout: 600_000 }, () => {
    const cases: [string, Chooser][] = [
      ['predator', predator],
      ['mob', mob],
      ['filibuster', filibuster],
      ['silent', (s, p, legal) => silent(s, p, legal, () => 0)],
    ];
    for (const [name, choose] of cases) {
      for (let g = 0; g < 3; g++) {
        const { moves, reason } = hostilePlayout(`${name}-${g}`, choose);
        expect(TERMINAL_REASONS, `${name}-${g}`).toContain(reason);
        // 33 applied moves per full cycle x DAY_LIMIT days is the hard ceiling.
        expect(moves).toBeLessThanOrEqual(33 * DAY_LIMIT + 8);
      }
    }
  });

  it('60 uniformly random games terminate, cover all three endings, and never deadlock', { timeout: 600_000 }, () => {
    const reasons = new Map<string, number>();
    for (let g = 0; g < 60; g++) {
      const { moves, reason } = hostilePlayout(`chaos-${g}`, chaos);
      expect(TERMINAL_REASONS, `chaos-${g}`).toContain(reason);
      expect(moves).toBeGreaterThan(8);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    // Every ending is reachable under random play; if one vanishes the phase
    // machine has grown a one-way door.
    for (const r of TERMINAL_REASONS) {
      expect(reasons.get(r) ?? 0, `${r} never occurred in 60 random games: ${JSON.stringify([...reasons])}`).toBeGreaterThan(0);
    }
  });

  it('forfeitPlayer repairs every phase: an abandoned seat never leaves a zero-mover state', () => {
    // Walk a random game and, at EVERY state, prove that eliminating each
    // living seat leaves a state that is terminal or has someone to move.
    let st = fresh('repair');
    const pickSeed = seed('repair:pick');
    let steps = 0;
    while (isTerminal(st) === null && steps++ < 30) {
      for (const p of livingSeats(st)) {
        const out = forfeitPlayer(st, p);
        expect(out, `forfeitPlayer declined a living seat ${p} in ${st.phase}`).not.toBeNull();
        const after = out!.state;
        expect(after.alive[p]).toBe(false);
        expect(after.cause[p]).toBe('abandoned');
        expect(after.revealed[p]).toBe(st.roles[p]);
        expect(after.nightActs[p]).toBeUndefined();
        expect(after.said[p]).toBeUndefined();
        expect(after.ballots[p]).toBeUndefined();
        if (isTerminal(after) === null) {
          expect(playersToMove(after).length, `zero movers after eliminating ${p} in ${st.phase}`).toBeGreaterThan(0);
        }
        // Already dead, or a finished game: forfeitPlayer must decline.
        expect(forfeitPlayer(after, p)).toBeNull();
      }
      st = playPhase(st, (_s, _p, legal) => legal[pickSeed.int('pick', legal.length)]!, `repair:${steps}`).state;
    }
  });

  it('eliminating the defender mid-defence opens the ballot instead of hanging', () => {
    let st = playPhase(fresh('defrepair'), silent, 'defrepair:night').state;
    st = playPhase(st, (s, p, legal) => (p === 'p0' ? { t: 'accuse', target: 'p4', text: '' } : legal[0]!), 'defrepair:r0').state;
    st = playPhase(st, silent, 'defrepair:r1').state;
    expect(st.phase).toBe('day_defense');
    expect(st.defender).toBe('p4');

    const out = forfeitPlayer(st, 'p4')!;
    expect(out).not.toBeNull();
    expect(out.state.phase).toBe('day_vote');
    expect(playersToMove(out.state)).toHaveLength(7);
    expect(out.events.some((e) => e.type === 'seat_lost' && e.visibility === 'public')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Room liveness: a real 8-seat RoomCore under the same attacks
// ---------------------------------------------------------------------------

const SECRET = '77'.repeat(32);
const DRAND = 'cd'.repeat(32);
const NIGHT_MS = 60_000;
const TALK_MS = 150_000;

interface TestSeat {
  seat: RoomSeat;
  secretKey: string;
}

function makeSeats(): TestSeat[] {
  return SEATS.map((player, i) => {
    const secretKey = sha256Hex(`redteam-rules-werewolf:seat:${i}`);
    return {
      seat: { player, agent_id: `agent-${i}`, handle: `agent${i}`, pubkey_ed25519: publicKeyOf(secretKey) },
      secretKey,
    };
  });
}

function makeRoom(tag: string): { core: RoomCore; seats: TestSeat[]; gameId: string } {
  const seats = makeSeats();
  const gameId = `rt-werewolf-${tag}`;
  const core = RoomCore.create(1_000_000, {
    gameId,
    game: werewolf,
    variant: {},
    seats: seats.map((s) => s.seat),
    division: 'open',
    rulesetVersion: '1.0.0',
    secretHex: SECRET,
    drandRound: 777,
    drandRandomnessHex: DRAND,
    clockScale: 1,
  });
  return { core, seats, gameId };
}

function submit(
  core: RoomCore,
  gameId: string,
  seat: TestSeat,
  move: MoveSubmission['move'],
  nowMs: number,
  extra?: Partial<MoveSubmission>,
) {
  const submission: MoveSubmission = { game_id: gameId, turn_index: core.turnIndex, move, ...extra };
  const signature = signEd25519(seat.secretKey, moveSignMessage(gameId, core.turnIndex, submission));
  return core.submitMove(nowMs, seat.seat.agent_id, submission, signature);
}

function roomState(core: RoomCore): WwState {
  return core.snapshot().state as unknown as WwState;
}

function kinds(core: RoomCore, kind: string): readonly { payload: Json }[] {
  return core.log.filter((e) => e.kind === kind) as unknown as readonly { payload: Json }[];
}

describe('room liveness: eight seats, one shared deadline, nobody can stall the table', () => {
  it('the night deadline is the full night budget for all eight movers (no side cap)', () => {
    const { core } = makeRoom('clock');
    // FATAL IF BROKEN: startTurnClock takes the MINIMUM over all movers of the
    // remaining side budget. At night every living seat is a mover, so ONE
    // capped seat would set the shared allowance to 1 ms and force, charge and
    // strike all eight in a single alarm. werewolf must stay uncapped.
    expect(core.clocks.perSideMs).toBeNull();
    expect(core.playersToMoveNow()).toHaveLength(8);
    expect(core.deadlineAtMs).toBe(1_000_000 + NIGHT_MS);
  });

  it('one silent seat at night does not deadlock — or strike — the other seven', () => {
    const { core, seats, gameId } = makeRoom('silent-seat');
    const deadline = core.deadlineAtMs!;
    let now = 1_000_100;

    let waiting: PlayerId[] = [];
    for (const s of seats) {
      if (s.seat.player === 'p3') continue;
      const r = submit(core, gameId, s, { index: 0 }, (now += 100)) as SubmitOk;
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.applied).toBe(false); // held until the phase resolves
      waiting = r.waiting_for ?? [];
      expect(core.deadlineAtMs).toBe(deadline); // ONE shared deadline, unchanged
      expect(core.turnIndex).toBe(0);
    }
    expect(waiting).toEqual(['p3']);

    const res = core.timeout(deadline);
    expect(res.fired).toBe(true);
    expect(core.status).toBe('running');

    // The seven who played are untouched; only p3 is struck.
    expect(core.strikes['p3']).toBe(1);
    for (const s of seats) {
      if (s.seat.player === 'p3') continue;
      expect(core.strikes[s.seat.player], s.seat.player).toBe(0);
    }
    expect(kinds(core, 'move')).toHaveLength(7);
    expect(kinds(core, 'timeout')).toHaveLength(1);
    expect((kinds(core, 'timeout')[0]!.payload as { player: string }).player).toBe('p3');

    // The phase resolved exactly once and the whole table moved on to the day.
    expect(core.turnIndex).toBe(1);
    const st = roomState(core);
    expect(st.phase).toBe('day_talk');
    expect(livingSeats(st)).toHaveLength(8); // p3 slept, it did not die
    expect(core.playersToMoveNow()).toHaveLength(8);
    expect(core.deadlineAtMs).toBe(deadline + TALK_MS); // the day budget, not the night one
  });

  it('all eight seats time out at once: one pass, eight strikes, the game plays on', () => {
    const { core } = makeRoom('all-timeout');
    const deadline = core.deadlineAtMs!;
    expect(core.waitingFor()).toHaveLength(8);

    const res = core.timeout(deadline);
    expect(res.fired).toBe(true);
    expect(core.status).toBe('running');

    const timeouts = kinds(core, 'timeout');
    expect(timeouts).toHaveLength(8);
    expect(timeouts.map((e) => (e.payload as { player: string }).player)).toEqual(SEATS); // seat order
    for (const p of SEATS) expect(core.strikes[p]).toBe(1);
    expect(kinds(core, 'move')).toHaveLength(0);
    expect(core.turnIndex).toBe(1);

    // Nobody died: the forced move is the game's OWN default, never a random
    // pick, so the clock can never choose a murder victim.
    const st = roomState(core);
    expect(livingSeats(st)).toHaveLength(8);
    expect(st.phase).toBe('day_talk');
    expect(st.nights).toEqual([{ day: 1, died: null }]);

    // Every night notation is the same redacted token.
    const replayable = core.eventsSince(0).filter((e) => e.type === 'timeout');
    expect(replayable).toHaveLength(8);
    for (const e of replayable) {
      expect((e.data as { notation: string }).notation).toBe('night');
    }

    // Idempotency: replaying the same alarm time changes nothing.
    const again = core.timeout(deadline);
    expect(again.fired).toBe(false);
    expect(kinds(core, 'timeout')).toHaveLength(8);
    for (const p of SEATS) expect(core.strikes[p]).toBe(1);
  });

  it('a seat that abandons is ELIMINATED mid-phase and the other seven play on unharmed', () => {
    const { core, seats, gameId } = makeRoom('abandon');
    let now = 1_000_100;

    // Three consecutive phases (night, talk r0, talk r1): seven seats answer,
    // p7 never does. The third timeout is p7's third strike.
    for (let phase = 0; phase < 3; phase++) {
      const deadline = core.deadlineAtMs!;
      for (const s of seats) {
        if (s.seat.player === 'p7') continue;
        expect(submit(core, gameId, s, { index: 0 }, (now += 50)).ok).toBe(true);
      }
      expect(core.waitingFor()).toEqual(['p7']);
      expect(core.timeout(deadline).fired).toBe(true);
      now = deadline + 10;
    }

    expect(core.status).toBe('running'); // NOT a seven-winner forfeit
    expect(core.strikes['p7']).toBe(3);
    for (const p of SEATS.filter((q) => q !== 'p7')) expect(core.strikes[p]).toBe(0);

    // The elimination is logged as a FULL state entry, unsigned.
    const forfeits = core.log.filter((e) => e.kind === 'forfeit');
    expect(forfeits).toHaveLength(1);
    const fp = forfeits[0]!.payload as Record<string, Json>;
    expect(fp['player']).toBe('p7');
    expect(fp['reason']).toBe('three_strikes');
    expect(typeof fp['state_hash']).toBe('string'); // the elimination shape
    expect(fp['draws']).toEqual([]); // forfeitPlayer takes no SeedStream
    expect(forfeits[0]!.signature).toBeNull();

    // The seat left the game; the table did not.
    const st = roomState(core);
    expect(st.alive['p7']).toBe(false);
    expect(st.cause['p7']).toBe('abandoned');
    expect(st.revealed['p7']).toBe(st.roles['p7']);
    expect(livingSeats(st)).toHaveLength(7);
    expect(core.playersToMoveNow()).toHaveLength(7);
    expect(core.playersToMoveNow()).not.toContain('p7');
    expect(core.turnIndex).toBe(3); // exactly one advance per resolved phase
    expect(core.eventsSince(0).some((e) => e.type === 'game:seat_lost')).toBe(true);

    // The seven survivors' held submissions all applied — no strike cascade.
    expect(kinds(core, 'move')).toHaveLength(21);

    // Finish the game by silence and prove the whole replay, elimination
    // included, verifies offline.
    let guard = 0;
    while (core.status === 'running' && guard++ < 60) {
      for (const p of core.playersToMoveNow()) {
        const s = seats.find((x) => x.seat.player === p)!;
        expect(submit(core, gameId, s, { index: 0 }, (now += 50)).ok, `${p} @${core.turnIndex}`).toBe(true);
      }
    }
    expect(core.status).toBe('ended');
    expect(core.result?.reason).not.toBe('forfeit');
    const replay = core.replayFile()!;
    const report = verifyReplay(replay, { werewolf });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('a bad INDEX inside a simultaneous phase still gets the frozen three-step policy', () => {
    const { core, seats, gameId } = makeRoom('bad-index');
    let now = 1_000_100;
    const p1 = seats[1]!;

    // An index failure is caught by the resolve ladder BEFORE the move is
    // held, so the two free attempts and the restated list are available even
    // at night.
    const r1 = submit(core, gameId, p1, { index: 999 }, (now += 100)) as SubmitReject;
    expect(r1.ok).toBe(false);
    expect(r1.code).toBe('illegal_move');
    expect(r1.illegal_attempt).toBe(1);
    expect(r1.legal_moves).toBeUndefined();

    const r2 = submit(core, gameId, p1, { index: -1 }, (now += 100)) as SubmitReject;
    expect(r2.illegal_attempt).toBe(2);
    expect(r2.legal_moves?.length).toBeGreaterThan(0);
    expect(core.strikes['p1']).toBe(0); // rejections never strike
    expect(core.turnIndex).toBe(0); // and never consume the turn

    // The third is forced + struck, but the seat is still only HELD: the other
    // seven are still collecting and must not be disturbed.
    const r3 = submit(core, gameId, p1, { index: 999 }, (now += 100)) as SubmitOk;
    expect(r3.ok).toBe(true);
    expect(r3.applied).toBe(false);
    expect(core.strikes['p1']).toBe(1);
    expect(core.turnIndex).toBe(0);
    for (const p of SEATS.filter((q) => q !== 'p1')) expect(core.strikes[p]).toBe(0);

    for (const s of seats) {
      if (s.seat.player === 'p1') continue;
      expect(submit(core, gameId, s, { index: 0 }, (now += 50)).ok).toBe(true);
    }
    expect(core.turnIndex).toBe(1);
    expect(core.status).toBe('running');
    expect(core.log.filter((e) => e.kind === 'move')).toHaveLength(8);
  });

  it('a rules-rejected act in a SIMULTANEOUS phase is held, struck once at resolution, and never cascades', () => {
    // DOCUMENTED ENGINE BEHAVIOUR, not a werewolf rule: submitSimultaneous
    // (core.ts) runs only the resolve ladder — it never calls apply() — so a
    // move the TOTAL parser accepts but the rules reject comes back
    // { ok: true, applied: false } and is only rejected when the phase
    // resolves. The frozen three-step illegal-move policy is therefore NOT
    // reachable for phase/target errors in the three simultaneous phases; the
    // seat pays one strike and gets a seeded random legal substitute instead.
    // What this test defends is the part that matters for liveness: the other
    // seven must be completely unaffected.
    //
    // The probe is `guard(p0)` FROM A WOLF, an in-phase verb the wolf's role
    // cannot perform. It used to be `vote(p0)` at night, but the parser's verb
    // table is now phase-scoped (notation.ts verbActsIn) precisely so that a
    // day verb — and every English sentence that starts with one — can no
    // longer become a silent strike here. Night verbs still reach apply(), so
    // this path is unchanged and still reachable.
    const { core, seats, gameId } = makeRoom('out-of-phase');
    let now = 1_000_100;
    const offender = seats[3]!; // a werewolf in this room's deal — asserted below
    const OFF: PlayerId = 'p3';

    const held = submit(core, gameId, offender, 'guard(p0)', (now += 100)) as SubmitOk;
    expect(held.ok).toBe(true);
    expect(held.applied).toBe(false);
    expect(core.strikes[OFF]).toBe(0); // nothing has been applied yet

    for (const s of seats) {
      if (s.seat.player === OFF) continue;
      expect(submit(core, gameId, s, { index: 0 }, (now += 50)).ok).toBe(true);
    }

    expect(core.turnIndex).toBe(1);
    expect(core.status).toBe('running');
    expect(core.strikes[OFF]).toBe(1);
    for (const p of SEATS.filter((q) => q !== OFF)) expect(core.strikes[p]).toBe(0);

    // The offender's entry is a forced move, and its notation is STILL the
    // redacted night token: a substitution can never leak what was substituted.
    const offMove = core.log.find(
      (e) => e.kind === 'move' && (e.payload as { player: string }).player === OFF,
    )!;
    expect((offMove.payload as { forced?: string }).forced).toBe('illegal');
    expect((offMove.payload as { notation: string }).notation).toBe('night');
    expect(core.log.filter((e) => e.kind === 'move')).toHaveLength(8);

    // HAZARD, pinned deliberately. The substitute is a seeded UNIFORM draw over
    // the seat's own legal night list (6 of a wolf's 7 entries are kills), NOT
    // the game's defaultMove. defaultMove protects the TIMEOUT path; it does
    // not protect the illegal-substitution path, so one malformed submission by
    // a wolf can order a killing the agent never asked for.
    const st = roomState(core);
    expect(st.roles[OFF]).toBe('werewolf');
    expect(st.kills).toEqual([{ day: 1, wolf: OFF, target: 'p2', died: true }]);
    expect(st.nights[0]).toEqual({ day: 1, died: 'p2' });
    expect(livingSeats(st)).toHaveLength(7);
    expect(core.playersToMoveNow()).toHaveLength(7); // and the table plays on
  });

  it('resign and draw_offer are refused, so no single seat can end the table', () => {
    const { core, seats, gameId } = makeRoom('no-exit');
    const r = submit(core, gameId, seats[4]!, { index: 0 }, 1_000_100, { resign: true }) as SubmitReject;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('resign_unavailable');
    const d = submit(core, gameId, seats[4]!, { index: 0 }, 1_000_200, { draw_offer: true }) as SubmitReject;
    expect(d.ok).toBe(false);
    expect(d.code).toBe('draw_offer_unavailable');
    expect(core.status).toBe('running');
    expect(core.turnIndex).toBe(0);
    expect(core.strikes['p4']).toBe(0); // rejections never strike
  });

  it('an unanswered DEFENCE (the one sequential phase) times out into the ballot', () => {
    const { core, seats, gameId } = makeRoom('defence');
    let now = 1_000_100;

    // night: everybody sleeps.
    for (const s of seats) expect(submit(core, gameId, s, { index: 0 }, (now += 50)).ok).toBe(true);
    // talk r0: every seat accuses p6 (index 6 is accuse(p6) for p0..p5, and
    // the list excludes the speaker, so p6 itself is asked for something else).
    for (const s of seats) {
      const move = s.seat.player === 'p6' ? ({ index: 0 } as const) : 'accuse(p6)';
      expect(submit(core, gameId, s, move, (now += 50)).ok).toBe(true);
    }
    // talk r1: silence.
    for (const s of seats) expect(submit(core, gameId, s, { index: 0 }, (now += 50)).ok).toBe(true);

    const st = roomState(core);
    expect(st.phase).toBe('day_defense');
    expect(st.defender).toBe('p6');
    expect(core.playersToMoveNow()).toEqual(['p6']);

    // Sequential phase: exactly ONE mover, so the clock is p6's alone.
    const deadline = core.deadlineAtMs!;
    expect(deadline).toBe(now + NIGHT_MS); // DEFENSE_BUDGET_MS === NIGHT_BUDGET_MS

    // Being the lone mover puts p6 back on the sequential path, where apply()
    // IS consulted at submission time — so a rules-rejected act here is a free
    // rejection with the specific rule code, not a silent strike. The probe is
    // an ARGUMENT error (`claim(wizard)`), not a foreign verb: the parser's
    // verb table is phase-scoped now (notation.ts verbActsIn), so `vote(p0)` in
    // a discussion phase is plain speech rather than a rule error — which is
    // the whole point, since the same string in a SIMULTANEOUS phase used to
    // cost a strike. Argument errors are untouched and still reach apply().
    const bad = submit(core, gameId, seats[6]!, 'claim(wizard)', (now += 10)) as SubmitReject;
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('illegal_move');
    expect(bad.illegal_attempt).toBe(1);
    expect(bad.message).toContain('bad_role');
    expect(core.strikes['p6']).toBe(0);
    expect(core.deadlineAtMs).toBe(deadline); // the rejection did not move the clock

    expect(core.timeout(deadline).fired).toBe(true);
    expect(core.status).toBe('running');
    expect(core.strikes['p6']).toBe(1);
    for (const p of SEATS.filter((q) => q !== 'p6')) expect(core.strikes[p]).toBe(0);

    const after = roomState(core);
    expect(after.phase).toBe('day_vote');
    expect(core.playersToMoveNow()).toHaveLength(8);
    // The forced defence is SILENCE, never fabricated words.
    const defenceRow = after.transcript.find((u) => u.act === 'defense')!;
    expect(defenceRow.speaker).toBe('p6');
    expect(defenceRow.text).toBe('');
  });

  it('a table that abstains every single day runs to the day limit and verifies offline', () => {
    const { core, seats, gameId } = makeRoom('deadlocked-town');
    let now = 1_000_100;
    let guard = 0;

    while (core.status === 'running') {
      expect(guard++, 'the room never terminated').toBeLessThan(60);
      const movers = core.playersToMoveNow();
      expect(movers.length, 'LIVENESS: running room with nobody to move').toBeGreaterThan(0);
      for (const p of movers) {
        const s = seats.find((x) => x.seat.player === p)!;
        expect(submit(core, gameId, s, { index: 0 }, (now += 50)).ok, `${p} @turn ${core.turnIndex}`).toBe(true);
      }
    }

    expect(core.result?.reason).toBe('day_limit');
    expect(core.result?.draw).toBe(false);
    expect(core.result?.winners).toHaveLength(2); // the pack, alive and whole
    // 4 turns a day (no defence is ever triggered) x DAY_LIMIT days.
    expect(core.turnIndex).toBe(4 * DAY_LIMIT);
    for (const p of SEATS) expect(core.strikes[p]).toBe(0);

    const st = roomState(core);
    expect(livingSeats(st)).toHaveLength(8);
    expect(st.voteHistory.every((v) => v.lynched === null)).toBe(true);

    // The reveal lands strictly after the end, and carries the full role map.
    const last = core.log[core.log.length - 1]!;
    expect(last.kind).toBe('reveal');
    expect((last.payload as { roles?: Json }).roles).toEqual(st.roles);

    const report = verifyReplay(core.replayFile()!, { werewolf });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Registry gates
// ---------------------------------------------------------------------------

describe('werewolf is a real registered game, not a stub', () => {
  it('every hook the room and the verifier reach for is wired', () => {
    expect(werewolf.meta.id).toBe('werewolf');
    expect(werewolf.meta.players).toEqual({ min: 8, max: 8 });
    expect(werewolf.meta.information).toBe('hidden');
    expect(werewolf.meta.allowsResign).toBe(false);
    expect(werewolf.meta.allowsDrawOffer).toBe(false);
    expect(werewolf.meta.speechLimit).toBe(MAX_SPEECH_CHARS);
    for (const hook of ['defaultMove', 'forfeitPlayer', 'phaseBudgetMs', 'bindUtterance', 'revealOnEnd'] as const) {
      expect(typeof werewolf[hook], hook).toBe('function');
    }
  });
});
