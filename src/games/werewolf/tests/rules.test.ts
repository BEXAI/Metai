/**
 * Werewolf rules fixtures: the deal and its seven seed draws, legal-move
 * enumeration (including the load-bearing "index 0 is the null act in every
 * phase" property), every role's night power, the whole phase machine
 * night -> talk r0 -> talk r1 -> defence -> vote -> dusk -> night, the dawn
 * reveal and its suppressed save flag, vote resolution with plurality, ties
 * and abstentions, DAY_LIMIT expiry, and every win condition for both
 * factions.
 *
 * Fixtures mutate `roles` / `alive` / `phase` directly, the landlord
 * convention (landlord/tests/helpers.ts `grant`): the deal is a seeded shuffle
 * and hunting for a seed that produces a given seating is both slower and less
 * legible than stating the seating outright.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../crypto/canonical.ts';
import { createSeedStream } from '../../../kernel/seed.ts';
import { isRuleError, type GameEvent, type RuleError, type SeedStream } from '../../../kernel/types.ts';
import {
  DAY_LIMIT,
  GENESIS_DIGEST,
  MAX_BALLOT_CHARS,
  MAX_NIGHT_CHARS,
  MAX_SPEECH_CHARS,
  ROLES_CANON,
  ROLE_MULTISET,
  SEAT_COUNT,
  TALK_ROUNDS,
  VERDICTS_CANON,
  type Role,
} from '../board.ts';
import {
  DEAL_PURPOSE,
  applyMove,
  countAccusations,
  createInitialState,
  defaultMove,
  forfeitPlayer,
  isTerminal,
  lastGuardTarget,
  legalMoves,
  livingSeats,
  mostAccused,
  playersToMove,
  teamsOf,
  type Seat,
  type WwMove,
  type WwState,
} from '../rules.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEATS: Seat[] = Array.from({ length: SEAT_COUNT }, (_, i) => `p${i}`);

/**
 * The seating every scripted fixture uses unless it says otherwise:
 * wolves p0 and p4, seer p2, doctor p5, villagers p1/p3/p6/p7. It is a
 * permutation of ROLE_MULTISET, asserted below, so nothing here depends on a
 * composition the game does not actually deal.
 */
const LAYOUT: Role[] = [
  'werewolf', // p0
  'villager', // p1
  'seer', // p2
  'villager', // p3
  'werewolf', // p4
  'doctor', // p5
  'villager', // p6
  'villager', // p7
];

const WOLVES = ['p0', 'p4'];
const VILLAGE = ['p1', 'p2', 'p3', 'p5', 'p6', 'p7'];

function seed(tag = 'werewolf fixture'): SeedStream {
  return createSeedStream(sha256Hex(tag));
}

/** A dealt opening position. Roles come from the seed, not from LAYOUT. */
function dealt(tag = 'werewolf fixture'): WwState {
  return createInitialState(seed(tag), SEATS, {});
}

/** An opening position with the roles overwritten to LAYOUT. */
function fresh(layout: Role[] = LAYOUT): WwState {
  const s = dealt();
  for (let i = 0; i < SEATS.length; i++) s.roles[SEATS[i]!] = layout[i]!;
  return s;
}

const SEED = seed('apply');

function mustApply(s: WwState, p: Seat, move: WwMove): { state: WwState; events: GameEvent[] } {
  const res = applyMove(s, p, move, SEED);
  if (isRuleError(res)) {
    throw new Error(`${p} ${JSON.stringify(move)} rejected: ${res.code} ${res.message}`);
  }
  return res;
}

function mustReject(s: WwState, p: Seat, move: WwMove): RuleError {
  const res = applyMove(s, p, move, SEED);
  if (!isRuleError(res)) throw new Error(`expected ${p} ${JSON.stringify(move)} to be rejected`);
  return res;
}

/**
 * Applies one move per current mover, in seat order, capturing the mover list
 * ONCE — exactly what rooms/core.ts:1070-1080 and the playout harness do, and
 * the discipline that makes "resolution happens only in the last actor's
 * apply()" testable.
 */
function fillPhase(
  s: WwState,
  moves: Record<Seat, WwMove>,
): { state: WwState; events: GameEvent[]; lastEvents: GameEvent[] } {
  const movers = playersToMove(s);
  expect(movers.length).toBeGreaterThan(0);
  let cur = s;
  const events: GameEvent[] = [];
  let lastEvents: GameEvent[] = [];
  for (const p of movers) {
    const mv = moves[p];
    if (mv === undefined) throw new Error(`fixture has no move for mover ${p}`);
    const r = mustApply(cur, p, mv);
    cur = r.state;
    lastEvents = r.events;
    events.push(...r.events);
  }
  return { state: cur, events, lastEvents };
}

/** Every mover plays its own null act (legalMoves[0]). */
function fillPhaseNull(s: WwState): { state: WwState; events: GameEvent[]; lastEvents: GameEvent[] } {
  const moves: Record<Seat, WwMove> = {};
  for (const p of playersToMove(s)) moves[p] = legalMoves(s, p)[0]!;
  return fillPhase(s, moves);
}

function eventsOf(events: GameEvent[], type: string): GameEvent[] {
  return events.filter((e) => e.type === type);
}

function data(e: GameEvent): Record<string, unknown> {
  return e.data as unknown as Record<string, unknown>;
}

/** Puts the state into a fresh day_vote with an empty ballot box. */
function atVote(s: WwState, day = 1): WwState {
  s.day = day;
  s.phase = 'day_vote';
  s.round = 0;
  s.ballots = {};
  s.said = {};
  s.nightActs = {};
  return s;
}

/** Kills a seat outside the rules engine, the way a previous day would have. */
function slay(s: WwState, p: Seat, cause: 'lynch' | 'wolves' | 'abandoned' = 'wolves'): void {
  s.alive[p] = false;
  s.cause[p] = cause;
  s.revealed[p] = s.roles[p]!;
}

// ---------------------------------------------------------------------------
// The deal
// ---------------------------------------------------------------------------

describe('werewolf setup and the deal', () => {
  it('opens on night 1 with eight living seats and a genesis digest', () => {
    const s = dealt();
    expect(s.players).toEqual(SEATS);
    expect(s.day).toBe(1);
    expect(s.phase).toBe('night');
    expect(s.round).toBe(0);
    expect(s.seq).toBe(0);
    expect(s.archivedCount).toBe(0);
    expect(s.archivedDigest).toBe(GENESIS_DIGEST);
    expect(livingSeats(s)).toEqual(SEATS);
    expect(s.cause).toEqual({});
    expect(s.revealed).toEqual({});
    expect(s.defender).toBeNull();
    expect(s.defended).toBe(false);
    expect(playersToMove(s)).toEqual(SEATS);
    expect(isTerminal(s)).toBeNull();
  });

  it('deals exactly ROLE_MULTISET, from one shuffle and SEVEN int() draws', () => {
    // src/kernel/seed.ts:75-83 loops i = a.length-1 down to 1, so an 8-item
    // Fisher-Yates is SEVEN draws, not eight. If anyone ever adds a coin-flip
    // tiebreak for a lynch or a night kill, this assertion fails immediately.
    const sd = seed('deal-3');
    const s = createInitialState(sd, SEATS, {});
    const draws = sd.draws();
    expect(draws).toHaveLength(7);
    expect(draws.map((d) => d.purpose)).toEqual(Array(7).fill(DEAL_PURPOSE));
    expect(draws.map((d) => d.kind)).toEqual(Array(7).fill('int'));
    expect(draws.map((d) => d.arg)).toEqual([8, 7, 6, 5, 4, 3, 2]);
    expect(SEATS.map((p) => s.roles[p]!).slice().sort()).toEqual(ROLE_MULTISET.slice().sort());
  });

  it('a whole random game draws on the seed SEVEN times and never again', () => {
    // The stream that dealt the roles is handed to EVERY apply(), so if a
    // future tiebreak ever reaches for randomness this count moves.
    const sd = seed('deal-whole-game');
    let s = createInitialState(sd, SEATS, {});
    const pick = seed('deal-whole-game:pick');
    let moves = 0;
    while (isTerminal(s) === null) {
      for (const p of playersToMove(s)) {
        const legal = legalMoves(s, p);
        const res = applyMove(s, p, legal[pick.int('pick', legal.length)]!, sd);
        if (isRuleError(res)) throw new Error(`${p}: ${res.code} ${res.message}`);
        s = res.state;
        moves++;
      }
    }
    expect(moves).toBeGreaterThan(20);
    expect(moves).toBeLessThan(400);
    expect(sd.draws()).toHaveLength(7);
  });

  it('is deterministic in the seed and does not key roles to seat index', () => {
    expect(dealt('same').roles).toEqual(dealt('same').roles);
    const seen: Record<Seat, Set<Role>> = {};
    for (const p of SEATS) seen[p] = new Set<Role>();
    for (let i = 0; i < 200; i++) {
      const s = dealt(`spread:${i}`);
      for (const p of SEATS) seen[p]!.add(s.roles[p]!);
    }
    for (const p of SEATS) expect([...seen[p]!].sort()).toEqual([...ROLES_CANON].sort());
  });

  it('refuses any seat count but eight', () => {
    expect(() => createInitialState(seed(), SEATS.slice(0, 6), {})).toThrow(/8-seat game/);
    expect(() => createInitialState(seed(), [...SEATS, 'p8'], {})).toThrow(/8-seat game/);
  });

  it('the fixture layout is a real permutation of the dealt composition', () => {
    expect([...LAYOUT].sort()).toEqual([...ROLE_MULTISET].sort());
  });
});

// ---------------------------------------------------------------------------
// Legal moves
// ---------------------------------------------------------------------------

describe('werewolf legal move enumeration', () => {
  it('night: wolf 7, seer 8, doctor 9, villager 1 at eight alive', () => {
    const s = fresh();
    expect(legalMoves(s, 'p0')).toEqual([
      { t: 'stay_in', text: '' },
      ...['p1', 'p2', 'p3', 'p5', 'p6', 'p7'].map((q) => ({ t: 'kill', target: q, text: '' })),
    ]);
    expect(legalMoves(s, 'p2')).toEqual([
      { t: 'sleep', text: '' },
      ...SEATS.filter((q) => q !== 'p2').map((q) => ({ t: 'peek', target: q, text: '' })),
    ]);
    expect(legalMoves(s, 'p5')).toEqual([
      { t: 'sleep', text: '' },
      ...SEATS.map((q) => ({ t: 'guard', target: q, text: '' })), // self-guard allowed
    ]);
    expect(legalMoves(s, 'p1')).toEqual([{ t: 'sleep', text: '' }]);
  });

  it('the doctor may not re-guard last night, and the exclusion is his own history', () => {
    const s = fresh();
    s.guards.push({ day: 1, doctor: 'p5', target: 'p1', saved: false });
    s.day = 2;
    expect(lastGuardTarget(s, 'p5')).toBe('p1');
    expect(lastGuardTarget(s, 'p2')).toBeNull();
    const legal = legalMoves(s, 'p5');
    expect(legal).toHaveLength(8); // sleep + 7 guards
    expect(legal).not.toContainEqual({ t: 'guard', target: 'p1', text: '' });
    expect(legal).toContainEqual({ t: 'guard', target: 'p5', text: '' });
  });

  it('day speech: 34 entries at eight alive, in the canonical index order', () => {
    const s = fresh();
    s.phase = 'day_talk';
    const legal = legalMoves(s, 'p0');
    const L = 8;
    expect(legal).toHaveLength(4 * L + 2); // 34
    expect(legal[0]).toEqual({ t: 'say', text: '' });
    expect(legal.slice(1, L)).toEqual(
      SEATS.filter((q) => q !== 'p0').map((q) => ({ t: 'accuse', target: q, text: '' })),
    );
    expect(legal.slice(L, 2 * L)).toEqual(SEATS.map((q) => ({ t: 'defend', target: q, text: '' })));
    expect(legal.slice(2 * L, 2 * L + 4)).toEqual(
      ROLES_CANON.map((r) => ({ t: 'claim', role: r, text: '' })),
    );
    // report(q,v) starts at 2L+4, q OUTER excluding the speaker, v INNER.
    expect(legal[2 * L + 4]).toEqual({ t: 'report', target: 'p1', verdict: 'wolf', text: '' });
    expect(legal[2 * L + 5]).toEqual({ t: 'report', target: 'p1', verdict: 'clear', text: '' });
    expect(legal.at(-1)).toEqual({ t: 'report', target: 'p7', verdict: 'clear', text: '' });
  });

  it('the report block excludes the SPEAKER, so index 2L+4 differs per seat', () => {
    // "State the formula, never a number": for p0 the first report target is
    // p1; for p4 it is p0. A doc or trap that hard-codes one is wrong.
    const s = fresh();
    s.phase = 'day_talk';
    expect(legalMoves(s, 'p4')[2 * 8 + 4]).toEqual({
      t: 'report',
      target: 'p0',
      verdict: 'wolf',
      text: '',
    });
    for (const p of SEATS) {
      const legal = legalMoves(s, p);
      expect(legal.some((m) => m.t === 'report' && m.target === p)).toBe(false);
      expect(legal.some((m) => m.t === 'accuse' && m.target === p)).toBe(false);
      expect(legal).toContainEqual({ t: 'defend', target: p, text: '' }); // self-defence is legal
    }
  });

  it('day_vote: abstain then every living seat, self included', () => {
    const s = atVote(fresh());
    slay(s, 'p3');
    const legal = legalMoves(s, 'p0');
    expect(legal).toEqual([
      { t: 'abstain', text: '' },
      ...livingSeats(s).map((q) => ({ t: 'vote', target: q, text: '' })),
    ]);
    expect(legal).toHaveLength(8);
    expect(legal).toContainEqual({ t: 'vote', target: 'p0', text: '' });
    expect(legal).not.toContainEqual({ t: 'vote', target: 'p3', text: '' });
  });

  it('a seat that is not to move — dead, already acted, or off-phase — gets nothing', () => {
    const s = fresh();
    slay(s, 'p3');
    expect(legalMoves(s, 'p3')).toEqual([]);
    const after = mustApply(s, 'p1', { t: 'sleep', text: '' }).state;
    expect(legalMoves(after, 'p1')).toEqual([]);
    const def = fresh();
    def.phase = 'day_defense';
    def.defender = 'p2';
    expect(legalMoves(def, 'p0')).toEqual([]);
    expect(legalMoves(def, 'p2')).toHaveLength(34);
  });
});

// ---------------------------------------------------------------------------
// Index 0 is the null act — the fallback-safety property
// ---------------------------------------------------------------------------

describe('werewolf index 0 is the null act in EVERY phase', () => {
  it('night: stay_in for a wolf, sleep for everyone else', () => {
    const s = fresh();
    expect(legalMoves(s, 'p0')[0]).toEqual({ t: 'stay_in', text: '' }); // werewolf
    expect(legalMoves(s, 'p4')[0]).toEqual({ t: 'stay_in', text: '' }); // werewolf
    expect(legalMoves(s, 'p2')[0]).toEqual({ t: 'sleep', text: '' }); // seer
    expect(legalMoves(s, 'p5')[0]).toEqual({ t: 'sleep', text: '' }); // doctor
    expect(legalMoves(s, 'p1')[0]).toEqual({ t: 'sleep', text: '' }); // villager
  });

  it('day_talk, day_defense and day_vote', () => {
    const talk = fresh();
    talk.phase = 'day_talk';
    for (const p of SEATS) expect(legalMoves(talk, p)[0]).toEqual({ t: 'say', text: '' });

    const def = fresh();
    def.phase = 'day_defense';
    def.defender = 'p3';
    expect(legalMoves(def, 'p3')[0]).toEqual({ t: 'say', text: '' });

    const vote = atVote(fresh());
    for (const p of SEATS) expect(legalMoves(vote, p)[0]).toEqual({ t: 'abstain', text: '' });
  });

  it('defaultMove deep-equals legalMoves[0] for every mover in every phase of a whole game', () => {
    // This is the property every fallback path in the hall relies on:
    // agents/anthropic.ts and agents/mock-llm.ts all land on index 0, and
    // core.ts forces defaultMove on a timeout. If the two ever disagree, a
    // network blip casts a real vote or picks a murder victim.
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      let s = createInitialState(seed(`null-act:${i}`), SEATS, {});
      const pick = seed(`null-act:${i}:pick`);
      while (isTerminal(s) === null) {
        for (const p of playersToMove(s)) {
          const legal = legalMoves(s, p);
          expect(legal[0]).toEqual(defaultMove(s, p, legal));
          expect(legal[0]!.text).toBe(''); // a forced move never carries words
          seen.add(`${s.phase}:${s.roles[p]}`);
          s = mustApply(s, p, legal[pick.int('pick', legal.length)]!).state;
        }
      }
    }
    // Night 1 always seats all four roles, so this half is exhaustive.
    for (const role of ROLES_CANON) expect([...seen]).toContain(`night:${role}`);
    for (const phase of ['day_talk', 'day_defense', 'day_vote']) {
      expect([...seen].some((k) => k.startsWith(`${phase}:`))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Role powers
// ---------------------------------------------------------------------------

describe('werewolf night powers', () => {
  it('the pack does not eat its own, and cannot eat the dead or the unseated', () => {
    const s = fresh();
    slay(s, 'p3');
    expect(mustReject(s, 'p0', { t: 'kill', target: 'p4', text: '' })).toMatchObject({
      code: 'bad_target',
      message: 'the pack does not eat its own',
    });
    expect(mustReject(s, 'p0', { t: 'kill', target: 'p0', text: '' }).code).toBe('bad_target');
    expect(mustReject(s, 'p0', { t: 'kill', target: 'p3', text: '' }).message).toContain(
      "'p3' is not a living seat",
    );
    expect(mustReject(s, 'p0', { t: 'kill', target: 'p99', text: '' }).code).toBe('bad_target');
    const ok = mustApply(s, 'p0', { t: 'kill', target: 'p1', text: '' });
    expect(ok.state.nightActs['p0']).toEqual({ t: 'kill', target: 'p1', text: '' });
    expect(eventsOf(ok.events, 'kill_intent')[0]).toEqual({
      type: 'kill_intent',
      data: { day: 1, by: 'p0', target: 'p1' },
      visibility: 'private',
      to: WOLVES,
    });
  });

  it('the seer cannot check itself and learns wolf/clear truthfully', () => {
    const s = fresh();
    expect(mustReject(s, 'p2', { t: 'peek', target: 'p2', text: '' })).toMatchObject({
      code: 'bad_target',
      message: 'the seer cannot check itself',
    });
    const onWolf = mustApply(s, 'p2', { t: 'peek', target: 'p4', text: '' });
    expect(data(eventsOf(onWolf.events, 'peek_result')[0]!)).toEqual({
      day: 1,
      target: 'p4',
      verdict: 'wolf',
    });
    const onTown = mustApply(s, 'p2', { t: 'peek', target: 'p5', text: '' });
    expect(data(eventsOf(onTown.events, 'peek_result')[0]!)['verdict']).toBe('clear');
    expect(eventsOf(onTown.events, 'peek_result')[0]!.to).toEqual(['p2']);
  });

  it('the doctor may guard himself but not the same seat two nights running', () => {
    const s = fresh();
    const self = mustApply(s, 'p5', { t: 'guard', target: 'p5', text: '' });
    expect(self.state.nightActs['p5']).toEqual({ t: 'guard', target: 'p5', text: '' });
    expect(data(eventsOf(self.events, 'guard_choice')[0]!)).toEqual({ day: 1, target: 'p5' });

    s.guards.push({ day: 1, doctor: 'p5', target: 'p1', saved: false });
    s.day = 2;
    expect(mustReject(s, 'p5', { t: 'guard', target: 'p1', text: '' })).toMatchObject({
      code: 'repeat_guard',
      message: 'the doctor may not guard p1 two nights running',
    });
    expect(isRuleError(applyMove(s, 'p5', { t: 'guard', target: 'p2', text: '' }, SEED))).toBe(false);
  });

  it('a villager has exactly one night move and every role is gated to its own verbs', () => {
    const s = fresh();
    expect(mustReject(s, 'p1', { t: 'guard', target: 'p0', text: '' })).toMatchObject({
      code: 'wrong_act',
      message: "a villager's only night move is sleep, not guard",
    });
    expect(mustReject(s, 'p1', { t: 'peek', target: 'p0', text: '' }).code).toBe('wrong_act');
    expect(mustReject(s, 'p1', { t: 'kill', target: 'p0', text: '' }).code).toBe('wrong_act');
    expect(mustReject(s, 'p0', { t: 'peek', target: 'p1', text: '' }).message).toContain(
      "a werewolf's night move is kill(seat) or stay_in",
    );
    expect(mustReject(s, 'p0', { t: 'sleep', text: '' }).code).toBe('wrong_act');
    expect(mustReject(s, 'p2', { t: 'guard', target: 'p1', text: '' }).message).toContain(
      "the seer's night move is peek(seat) or sleep",
    );
    expect(mustReject(s, 'p5', { t: 'peek', target: 'p1', text: '' }).message).toContain(
      "the doctor's night move is guard(seat) or sleep",
    );
    expect(mustReject(s, 'p1', { t: 'vote', target: 'p0', text: '' }).code).toBe('wrong_act');
    expect(mustApply(s, 'p1', { t: 'sleep', text: '' }).state.nightActs['p1']).toEqual({
      t: 'sleep',
      target: null,
      text: '',
    });
  });

  it('a night move writes only its own slot and never removes another mover', () => {
    // The precondition rooms/core.ts:1080 relies on: a held submission whose
    // owner has left playersToMove is silently dropped, so no apply() in a
    // simultaneous phase may de-queue a peer.
    const s = fresh();
    const before = playersToMove(s);
    const after = mustApply(s, 'p0', { t: 'kill', target: 'p3', text: 'quiet one' }).state;
    expect(playersToMove(after)).toEqual(before.filter((p) => p !== 'p0'));
    expect(Object.keys(after.nightActs)).toEqual(['p0']);
    // No ledger moves until the last actor resolves the night.
    expect(after.kills).toEqual([]);
    expect(after.packLog).toEqual([]);
    expect(after.alive['p3']).toBe(true);
    expect(after.phase).toBe('night');
    for (const q of playersToMove(after)) {
      expect(legalMoves(after, q)).toEqual(legalMoves(s, q));
    }
  });
});

// ---------------------------------------------------------------------------
// Night resolution and dawn
// ---------------------------------------------------------------------------

describe('werewolf night resolution and the dawn reveal', () => {
  const quietNight = (s: WwState): Record<Seat, WwMove> => {
    const moves: Record<Seat, WwMove> = {};
    for (const p of livingSeats(s)) moves[p] = defaultMove(s, p, []);
    return moves;
  };

  it('resolves only in the LAST actor apply(): the kill, the reveal, and dawn', () => {
    const s = fresh();
    const moves = quietNight(s);
    moves['p0'] = { t: 'kill', target: 'p3', text: 'p3 it is.' };
    moves['p2'] = { t: 'peek', target: 'p4', text: 'checking p4' };
    moves['p5'] = { t: 'guard', target: 'p1', text: '' };
    const { state, lastEvents } = fillPhase(s, moves);

    expect(state.alive['p3']).toBe(false);
    expect(state.cause['p3']).toBe('wolves');
    expect(state.revealed['p3']).toBe('villager');
    expect(state.kills).toEqual([{ day: 1, wolf: 'p0', target: 'p3', died: true }]);
    expect(state.peeks).toEqual([{ day: 1, seer: 'p2', target: 'p4', verdict: 'wolf' }]);
    expect(state.guards).toEqual([{ day: 1, doctor: 'p5', target: 'p1', saved: false }]);
    expect(state.packLog).toEqual([{ day: 1, from: 'p0', text: 'p3 it is.' }]);
    expect(state.noteLog).toEqual([{ day: 1, who: 'p2', text: 'checking p4' }]);
    expect(state.nights).toEqual([{ day: 1, died: 'p3' }]);
    expect(state.nightActs).toEqual({});
    expect(state.phase).toBe('day_talk');
    expect(state.round).toBe(0);
    expect(playersToMove(state)).toEqual(['p0', 'p1', 'p2', 'p4', 'p5', 'p6', 'p7']);

    // Everything the night produced was emitted by the last mover's apply.
    expect(lastEvents.map((e) => e.type)).toEqual(['guard_outcome', 'dawn', 'phase']);
    expect(data(eventsOf(lastEvents, 'dawn')[0]!)).toEqual({
      day: 1,
      died: 'p3',
      role: 'villager',
    });
  });

  it('the lowest-seat wolf decides when the pack disagrees', () => {
    const s = fresh();
    const moves = quietNight(s);
    moves['p0'] = { t: 'kill', target: 'p3', text: '' };
    moves['p4'] = { t: 'kill', target: 'p6', text: '' };
    const { state } = fillPhase(s, moves);
    expect(state.alive['p3']).toBe(false);
    expect(state.alive['p6']).toBe(true);
    expect(state.kills).toEqual([{ day: 1, wolf: 'p0', target: 'p3', died: true }]);

    // The high-seat wolf alone still kills; seat order is only a tiebreak.
    const solo = fresh();
    const m2 = quietNight(solo);
    m2['p4'] = { t: 'kill', target: 'p6', text: '' };
    expect(fillPhase(solo, m2).state.alive['p6']).toBe(false);
  });

  it('a guarded victim survives and the save is NOT announced', () => {
    const s = fresh();
    const moves = quietNight(s);
    moves['p0'] = { t: 'kill', target: 'p3', text: '' };
    moves['p5'] = { t: 'guard', target: 'p3', text: '' };
    const { state, lastEvents } = fillPhase(s, moves);

    expect(state.alive['p3']).toBe(true);
    expect(state.kills).toEqual([{ day: 1, wolf: 'p0', target: 'p3', died: false }]);
    expect(state.guards).toEqual([{ day: 1, doctor: 'p5', target: 'p3', saved: true }]);
    expect(state.nights).toEqual([{ day: 1, died: null }]);
    // The derived-hidden field: `saved` exists in the doctor's ledger and
    // NOWHERE in the public night record or the dawn event.
    expect(Object.keys(state.nights[0]!).sort()).toEqual(['day', 'died']);
    expect(data(eventsOf(lastEvents, 'dawn')[0]!)).toEqual({ day: 1, died: null, role: null });
    // `doctor` is carried in the payload, not only in `to`: resolveNight runs
    // inside the LAST night mover's apply(), so a reader that attributed this
    // event to its log entry's player would name the wrong seat.
    expect(eventsOf(lastEvents, 'guard_outcome')[0]).toEqual({
      type: 'guard_outcome',
      data: { day: 1, doctor: 'p5', target: 'p3', saved: true },
      visibility: 'private',
      to: ['p5'],
    });
  });

  it('a save and a wolf stay_in produce byte-identical public night records', () => {
    const saved = fresh();
    const sm = quietNight(saved);
    sm['p0'] = { t: 'kill', target: 'p3', text: '' };
    sm['p5'] = { t: 'guard', target: 'p3', text: '' };
    const a = fillPhase(saved, sm);

    const quiet = fresh();
    const qm = quietNight(quiet); // p0 stays in, p5 sleeps
    const b = fillPhase(quiet, qm);

    expect(a.state.nights).toEqual(b.state.nights);
    expect(a.state.alive).toEqual(b.state.alive);
    expect(eventsOf(a.lastEvents, 'dawn').map(data)).toEqual(
      eventsOf(b.lastEvents, 'dawn').map(data),
    );
    // ...while the private ledgers differ, which is the whole point.
    expect(a.state.guards).not.toEqual(b.state.guards);
    expect(b.state.kills).toEqual([]);
  });

  it('night text is routed by role: wolves to the pack log, everyone else to their own', () => {
    const s = fresh();
    const moves = quietNight(s);
    moves['p0'] = { t: 'stay_in', text: 'nothing tonight' };
    moves['p4'] = { t: 'stay_in', text: 'agreed' };
    moves['p1'] = { t: 'sleep', text: 'p6 felt off' };
    const { state, events } = fillPhase(s, moves);
    expect(state.packLog).toEqual([
      { day: 1, from: 'p0', text: 'nothing tonight' },
      { day: 1, from: 'p4', text: 'agreed' },
    ]);
    expect(state.noteLog).toEqual([{ day: 1, who: 'p1', text: 'p6 felt off' }]);
    const whispers = eventsOf(events, 'pack_whisper');
    expect(whispers).toHaveLength(2);
    for (const w of whispers) {
      expect(w.visibility).toBe('private');
      expect(w.to).toEqual(WOLVES);
    }
    expect(eventsOf(events, 'night_note')[0]!.to).toEqual(['p1']);
    // A wordless act emits nothing at all.
    expect(eventsOf(events, 'night_note')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The full phase machine
// ---------------------------------------------------------------------------

describe('werewolf phase transitions', () => {
  it('walks night -> talk r0 -> talk r1 -> defence -> vote -> dusk -> night', () => {
    let s = fresh();

    // --- NIGHT 1: p3 is eaten -------------------------------------------
    const night: Record<Seat, WwMove> = {};
    for (const p of SEATS) night[p] = defaultMove(s, p, []);
    night['p0'] = { t: 'kill', target: 'p3', text: '' };
    night['p2'] = { t: 'peek', target: 'p4', text: '' };
    night['p5'] = { t: 'guard', target: 'p1', text: '' };
    s = fillPhase(s, night).state;
    expect(s.phase).toBe('day_talk');
    expect(s.round).toBe(0);
    const living = ['p0', 'p1', 'p2', 'p4', 'p5', 'p6', 'p7'];
    expect(livingSeats(s)).toEqual(living);

    // --- DAY TALK, round 0 ----------------------------------------------
    const r0 = fillPhase(s, {
      p0: { t: 'say', text: '' },
      p1: { t: 'accuse', target: 'p4', text: 'p4 answered before the question landed' },
      p2: { t: 'report', target: 'p4', verdict: 'wolf', text: 'I checked p4' },
      p4: { t: 'defend', target: 'p4', text: 'nonsense' },
      p5: { t: 'accuse', target: 'p4', text: '' },
      p6: { t: 'claim', role: 'villager', text: '' },
      p7: { t: 'say', text: '' },
    });
    s = r0.state;
    expect(s.phase).toBe('day_talk');
    expect(s.round).toBe(1);
    expect(s.said).toEqual({});
    // Materialised in SEAT order with contiguous seq — the property that makes
    // the state hash order-independent under simultaneous replay.
    expect(s.transcript.map((u) => u.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(s.transcript.map((u) => u.speaker)).toEqual(living);
    expect(s.transcript.map((u) => u.act)).toEqual([
      'say',
      'accuse',
      'report',
      'defend',
      'accuse',
      'claim',
      'say',
    ]);
    expect(s.transcript.every((u) => u.day === 1 && u.round === 0)).toBe(true);
    expect(s.edges).toEqual([
      { day: 1, seq: 1, from: 'p1', to: 'p4', polarity: 'accuse' },
      { day: 1, seq: 3, from: 'p4', to: 'p4', polarity: 'defend' },
      { day: 1, seq: 4, from: 'p5', to: 'p4', polarity: 'accuse' },
    ]);
    expect(s.claims).toEqual([{ day: 1, seq: 5, speaker: 'p6', role: 'villager' }]);
    expect(s.reports).toEqual([
      { day: 1, seq: 2, speaker: 'p2', target: 'p4', verdict: 'wolf' },
    ]);
    expect(eventsOf(r0.events, 'speech')).toHaveLength(7);
    expect(s.seq).toBe(s.archivedCount + s.transcript.length);

    // --- DAY TALK, round 1 -> the defence --------------------------------
    const r1 = fillPhase(s, {
      p0: { t: 'say', text: '' },
      p1: { t: 'say', text: '' },
      p2: { t: 'say', text: '' },
      p4: { t: 'accuse', target: 'p2', text: 'p2 is fabricating a check' },
      p5: { t: 'say', text: '' },
      p6: { t: 'say', text: '' },
      p7: { t: 'say', text: '' },
    });
    s = r1.state;
    expect(s.transcript.map((u) => u.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(countAccusations(s, 'p4')).toBe(2);
    expect(countAccusations(s, 'p2')).toBe(1);
    expect(mostAccused(s)).toBe('p4');
    expect(s.phase).toBe('day_defense');
    expect(s.round).toBe(0);
    expect(s.defender).toBe('p4');
    expect(s.defended).toBe(false);
    expect(s.defenders).toEqual([{ day: 1, seat: 'p4' }]);
    expect(playersToMove(s)).toEqual(['p4']);
    expect(data(eventsOf(r1.events, 'defense')[0]!)).toEqual({
      day: 1,
      seat: 'p4',
      accusations: 2,
    });

    // --- THE DEFENCE -> the ballot ---------------------------------------
    const def = mustApply(s, 'p4', { t: 'claim', role: 'villager', text: 'I am nobody special' });
    s = def.state;
    expect(s.phase).toBe('day_vote');
    expect(s.defended).toBe(true);
    expect(s.said).toEqual({});
    expect(s.ballots).toEqual({});
    const defenceRow = s.transcript.at(-1)!;
    expect(defenceRow).toEqual({
      seq: 14,
      day: 1,
      round: -1, // the defence is outside the talk rounds
      speaker: 'p4',
      act: 'defense', // phase-derived label; the payload survives
      target: null,
      role: 'villager',
      verdict: null,
      text: 'I am nobody special',
    });
    expect(s.claims.at(-1)).toEqual({ day: 1, seq: 14, speaker: 'p4', role: 'villager' });
    expect(playersToMove(s)).toEqual(living);

    // --- THE BALLOT -> the lynch -> dusk ---------------------------------
    const vote = fillPhase(s, {
      p0: { t: 'vote', target: 'p2', text: '' },
      p1: { t: 'vote', target: 'p4', text: 'the check stands' },
      p2: { t: 'vote', target: 'p4', text: '' },
      p4: { t: 'vote', target: 'p2', text: '' },
      p5: { t: 'vote', target: 'p4', text: '' },
      p6: { t: 'vote', target: 'p4', text: '' },
      p7: { t: 'abstain', text: '' },
    });
    s = vote.state;
    expect(s.alive['p4']).toBe(false);
    expect(s.cause['p4']).toBe('lynch');
    expect(s.revealed['p4']).toBe('werewolf');
    expect(s.voteHistory).toEqual([
      {
        day: 1,
        ballots: { p0: 'p2', p1: 'p4', p2: 'p4', p4: 'p2', p5: 'p4', p6: 'p4', p7: null },
        lynched: 'p4',
      },
    ]);
    expect(data(eventsOf(vote.events, 'lynch')[0]!)).toEqual({
      day: 1,
      seat: 'p4',
      role: 'werewolf',
      tally: { p2: 2, p4: 4 },
      abstains: 1,
      reason: 'plurality',
    });

    // DUSK: 22 rows archived (7 + 7 + 1 + 7), the prose evicted, day 2 opened.
    expect(s.archivedCount).toBe(22);
    expect(s.seq).toBe(22);
    expect(s.transcript).toEqual([]);
    expect(s.archivedDigest).not.toBe(GENESIS_DIGEST);
    expect(s.archivedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(s.day).toBe(2);
    expect(s.phase).toBe('night');
    expect(s.round).toBe(0);
    expect(s.defender).toBeNull();
    expect(s.defended).toBe(false);
    expect(s.ballots).toEqual({});
    // The permanent ledgers survive dusk; only the prose is evicted.
    expect(s.claims).toHaveLength(2);
    expect(s.reports).toHaveLength(1);
    expect(s.edges).toHaveLength(4);

    // --- NIGHT 2: the doctor may not repeat p1 ---------------------------
    expect(playersToMove(s)).toEqual(['p0', 'p1', 'p2', 'p5', 'p6', 'p7']);
    const docLegal = legalMoves(s, 'p5');
    expect(docLegal).toHaveLength(6); // sleep + 5 living seats, minus p1
    expect(docLegal).not.toContainEqual({ t: 'guard', target: 'p1', text: '' });
    expect(mustReject(s, 'p5', { t: 'guard', target: 'p1', text: '' }).code).toBe('repeat_guard');
  });

  it('skips the defence entirely when nobody was accused', () => {
    let s = fresh();
    s = fillPhaseNull(s).state; // quiet night
    expect(s.phase).toBe('day_talk');
    for (let r = 0; r < TALK_ROUNDS; r++) {
      const before = s.round;
      s = fillPhaseNull(s).state; // everyone says nothing
      if (r + 1 < TALK_ROUNDS) expect(s.round).toBe(before + 1);
    }
    expect(mostAccused(s)).toBeNull();
    expect(s.phase).toBe('day_vote');
    expect(s.defender).toBeNull();
    expect(s.defenders).toEqual([]);
    expect(s.transcript).toHaveLength(16); // two silent rounds of eight
  });

  it('a defence utterance can itself accuse, and the vote still opens', () => {
    const s = fresh();
    s.phase = 'day_defense';
    s.defender = 'p3';
    s.defended = false;
    const after = mustApply(s, 'p3', { t: 'accuse', target: 'p6', text: 'ask p6' }).state;
    expect(after.phase).toBe('day_vote');
    expect(after.edges).toEqual([{ day: 1, seq: 0, from: 'p3', to: 'p6', polarity: 'accuse' }]);
    expect(after.transcript[0]!.act).toBe('defense');
    expect(playersToMove(after)).toEqual(SEATS);
  });

  it('never rests with zero movers while the game is live, in any phase', () => {
    for (let i = 0; i < 8; i++) {
      const sd = seed(`no-movers:${i}`);
      let s = createInitialState(sd, SEATS, {});
      const pick = seed(`no-movers:${i}:pick`);
      const phases = new Set<string>();
      while (isTerminal(s) === null) {
        phases.add(s.phase);
        const movers = playersToMove(s);
        expect(movers.length).toBeGreaterThan(0);
        expect(s.seq).toBe(s.archivedCount + s.transcript.length);
        for (const p of movers) {
          const legal = legalMoves(s, p);
          s = mustApply(s, p, legal[pick.int('pick', legal.length)]!).state;
        }
      }
      expect(playersToMove(s)).toEqual([]);
      expect(s.phase).toBe('over');
      expect(phases).toContain('night');
      expect(phases).toContain('day_talk');
      expect(phases).toContain('day_vote');
    }
  });
});

// ---------------------------------------------------------------------------
// Day speech validation
// ---------------------------------------------------------------------------

describe('werewolf day speech validation', () => {
  const talking = (): WwState => {
    const s = fresh();
    s.phase = 'day_talk';
    return s;
  };

  it('gates targets, roles and verdicts without ever consulting the truth', () => {
    const s = talking();
    slay(s, 'p3');
    expect(mustReject(s, 'p0', { t: 'accuse', target: 'p0', text: '' })).toMatchObject({
      code: 'bad_target',
      message: 'you cannot accuse yourself',
    });
    expect(mustReject(s, 'p0', { t: 'accuse', target: 'p3', text: '' }).code).toBe('bad_target');
    expect(mustReject(s, 'p0', { t: 'report', target: 'p0', verdict: 'wolf', text: '' })).toMatchObject(
      { code: 'bad_target', message: 'you cannot report on yourself' },
    );
    expect(mustReject(s, 'p0', { t: 'claim', role: 'wizard', text: '' })).toMatchObject({
      code: 'bad_role',
      message: "'wizard' is not a role (werewolf, seer, doctor, villager)",
    });
    expect(mustReject(s, 'p0', { t: 'report', target: 'p1', verdict: 'maybe', text: '' })).toMatchObject(
      { code: 'bad_verdict', message: "'maybe' is not a verdict (wolf, clear)" },
    );
    expect(mustReject(s, 'p0', { t: 'vote', target: 'p1', text: '' }).code).toBe('wrong_act');
    expect(mustReject(s, 'p0', { t: 'sleep', text: '' }).code).toBe('wrong_act');

    // A plain villager may claim seer, and a wolf may report the seer as a
    // wolf. Nothing is checked against roles: that is the bluff.
    expect(mustApply(s, 'p1', { t: 'claim', role: 'seer', text: '' }).state.said['p1']).toEqual({
      act: 'claim',
      target: null,
      role: 'seer',
      verdict: null,
      text: '',
    });
    for (const v of VERDICTS_CANON) {
      expect(
        isRuleError(applyMove(s, 'p0', { t: 'report', target: 'p2', verdict: v, text: '' }, SEED)),
      ).toBe(false);
    }
  });

  it('caps text per phase and rejects unnormalised bytes, without consuming the turn', () => {
    const talk = talking();
    const long = 'x'.repeat(MAX_SPEECH_CHARS + 1);
    expect(mustReject(talk, 'p0', { t: 'say', text: long })).toMatchObject({
      code: 'text_too_long',
      message: `text exceeds ${MAX_SPEECH_CHARS} characters (got ${MAX_SPEECH_CHARS + 1})`,
    });
    expect(talk.said['p0']).toBeUndefined(); // the turn is not consumed
    expect(
      isRuleError(applyMove(talk, 'p0', { t: 'say', text: 'x'.repeat(MAX_SPEECH_CHARS) }, SEED)),
    ).toBe(false);

    const night = fresh();
    expect(mustReject(night, 'p1', { t: 'sleep', text: 'x'.repeat(MAX_NIGHT_CHARS + 1) }).message).toContain(
      `text exceeds ${MAX_NIGHT_CHARS} characters`,
    );
    const vote = atVote(fresh());
    expect(mustReject(vote, 'p1', { t: 'abstain', text: 'x'.repeat(MAX_BALLOT_CHARS + 1) }).message).toContain(
      `text exceeds ${MAX_BALLOT_CHARS} characters`,
    );

    // Built with String.fromCharCode so this file contains no literal
    // control, zero-width or bidi bytes: those are exactly what an editor or
    // a formatter silently mangles, and a mangled fixture stops testing the
    // thing it names.
    const ch = (c: number): string => String.fromCharCode(c);
    const hostile = [
      'line' + ch(0x0a) + 'break',
      'carriage' + ch(0x0d) + 'return',
      'tab' + ch(0x09) + 'smuggle',
      'zero' + ch(0x200b) + 'width',
      'bidi' + ch(0x202e) + 'override',
      'line' + ch(0x2028) + 'separator',
      'para' + ch(0x2029) + 'separator',
      'bom' + ch(0xfeff) + 'mark',
      'null' + ch(0x00) + 'byte',
      ' leading',
      'trailing ',
      'double  space',
    ];
    for (const text of hostile) {
      expect(mustReject(talk, 'p0', { t: 'say', text })).toMatchObject({
        code: 'unnormalized_text',
        message: 'text contains control, zero-width, bidi, or line-separator characters',
      });
    }
    expect(mustReject(talk, 'p0', { t: 'say', text: 42 as unknown as string }).code).toBe('bad_text');
    expect(mustReject(talk, 'p0', { t: 'nope', text: '' } as unknown as WwMove).code).toBe('wrong_act');
    expect(mustReject(talk, 'p0', null as unknown as WwMove).code).toBe('bad_move');
  });

  it('refuses the dead, the out-of-turn and the already-spoken', () => {
    const s = talking();
    slay(s, 'p3');
    expect(mustReject(s, 'p3', { t: 'say', text: '' })).toMatchObject({
      code: 'dead',
      message: 'p3 has been eliminated',
    });
    const after = mustApply(s, 'p0', { t: 'say', text: '' }).state;
    expect(mustReject(after, 'p0', { t: 'say', text: '' })).toMatchObject({
      code: 'not_your_turn',
      message: 'p0 is not to move in phase day_talk',
    });
    const def = fresh();
    def.phase = 'day_defense';
    def.defender = 'p2';
    expect(mustReject(def, 'p0', { t: 'say', text: '' }).code).toBe('not_your_turn');
  });
});

// ---------------------------------------------------------------------------
// The ballot
// ---------------------------------------------------------------------------

describe('werewolf vote resolution', () => {
  /** Casts a full ballot from a seat -> target map (null = abstain). */
  function ballot(s: WwState, box: Record<Seat, Seat | null>): { state: WwState; events: GameEvent[] } {
    const moves: Record<Seat, WwMove> = {};
    for (const p of playersToMove(s)) {
      const target = box[p];
      moves[p] = target === null || target === undefined
        ? { t: 'abstain', text: '' }
        : { t: 'vote', target, text: '' };
    }
    const r = fillPhase(s, moves);
    return { state: r.state, events: r.events };
  }

  it('a strict plurality lynches, reveals the role and archives the ballots', () => {
    const s = atVote(fresh());
    const { state, events } = ballot(s, {
      p0: 'p6',
      p1: 'p6',
      p2: 'p6',
      p3: 'p0',
      p4: 'p0',
      p5: null,
      p6: null,
      p7: null,
    });
    expect(state.alive['p6']).toBe(false);
    expect(state.cause['p6']).toBe('lynch');
    expect(state.revealed['p6']).toBe('villager');
    expect(data(eventsOf(events, 'lynch')[0]!)).toEqual({
      day: 1,
      seat: 'p6',
      role: 'villager',
      tally: { p0: 2, p6: 3 },
      abstains: 3,
      reason: 'plurality',
    });
    expect(data(eventsOf(events, 'ballots')[0]!)['ballots']).toEqual({
      p0: 'p6',
      p1: 'p6',
      p2: 'p6',
      p3: 'p0',
      p4: 'p0',
      p5: null,
      p6: null,
      p7: null,
    });
    // Ballot rows drain in seat order, outside the talk rounds.
    expect(state.archivedCount).toBe(8);
    expect(state.seq).toBe(8);
    expect(state.day).toBe(2);
  });

  it('ANY tie is no lynch, at two seats or at three', () => {
    const two = ballot(atVote(fresh()), {
      p0: 'p1',
      p1: 'p0',
      p2: null,
      p3: null,
      p4: null,
      p5: null,
      p6: null,
      p7: null,
    });
    expect(two.state.voteHistory[0]!.lynched).toBeNull();
    expect(livingSeats(two.state)).toEqual(SEATS);
    expect(data(eventsOf(two.events, 'lynch')[0]!)).toMatchObject({
      seat: null,
      role: null,
      reason: 'tie',
      abstains: 6,
    });

    const three = ballot(atVote(fresh()), {
      p0: 'p5',
      p1: 'p5',
      p2: 'p6',
      p3: 'p6',
      p4: 'p7',
      p5: 'p7',
      p6: null,
      p7: null,
    });
    expect(three.state.voteHistory[0]!.lynched).toBeNull();
    expect(data(eventsOf(three.events, 'lynch')[0]!)['reason']).toBe('tie');

    // A tie broken by one extra vote does lynch — the tie flag must reset.
    const broken = ballot(atVote(fresh()), {
      p0: 'p5',
      p1: 'p5',
      p2: 'p6',
      p3: 'p6',
      p4: 'p7',
      p5: 'p7',
      p6: 'p7',
      p7: null,
    });
    expect(broken.state.voteHistory[0]!.lynched).toBe('p7');
    expect(data(eventsOf(broken.events, 'lynch')[0]!)['reason']).toBe('plurality');
  });

  it('abstentions are excluded from the tally and reported separately', () => {
    const all = ballot(atVote(fresh()), Object.fromEntries(SEATS.map((p) => [p, null])));
    expect(all.state.voteHistory[0]!.lynched).toBeNull();
    expect(data(eventsOf(all.events, 'lynch')[0]!)).toMatchObject({
      tally: {},
      abstains: 8,
      reason: 'no_votes',
    });
    expect(livingSeats(all.state)).toEqual(SEATS);

    // Seven abstentions do not out-weigh a single vote.
    const lonely = ballot(atVote(fresh()), {
      p0: 'p2',
      p1: null,
      p2: null,
      p3: null,
      p4: null,
      p5: null,
      p6: null,
      p7: null,
    });
    expect(lonely.state.voteHistory[0]!.lynched).toBe('p2');
    expect(data(eventsOf(lonely.events, 'lynch')[0]!)).toMatchObject({
      tally: { p2: 1 },
      abstains: 7,
      reason: 'plurality',
    });
  });

  it('a self-vote is legal and counts; a vote for a dead seat is not', () => {
    const s = atVote(fresh());
    slay(s, 'p3');
    expect(mustReject(s, 'p0', { t: 'vote', target: 'p3', text: '' }).message).toContain(
      "'p3' is not a living seat",
    );
    expect(mustReject(s, 'p0', { t: 'vote', target: 'nobody', text: '' }).code).toBe('bad_target');
    expect(mustReject(s, 'p0', { t: 'say', text: '' })).toMatchObject({
      code: 'wrong_act',
      message: 'in day_vote the moves are vote(seat) and abstain, not say',
    });
    const self = ballot(s, {
      p0: 'p0',
      p1: 'p0',
      p2: null,
      p4: null,
      p5: null,
      p6: null,
      p7: null,
    });
    expect(self.state.alive['p0']).toBe(false);
    expect(self.state.voteHistory[0]!.ballots['p0']).toBe('p0');
  });

  it('ballot rows drain in SEAT order, on round -1, with the words verbatim', () => {
    // Inspected on a game-ending ballot, because dusk evicts the transcript
    // on every other path.
    const s = atVote(fresh());
    for (const p of ['p1', 'p2', 'p3']) slay(s, p);
    slay(s, 'p0', 'lynch'); // one wolf (p4) against p5, p6, p7
    const { state } = fillPhase(s, {
      p4: { t: 'abstain', text: 'not my problem' },
      p5: { t: 'vote', target: 'p4', text: 'the check stands' },
      p6: { t: 'vote', target: 'p4', text: '' },
      p7: { t: 'vote', target: 'p4', text: '' },
    });
    expect(state.phase).toBe('over');
    const row = (seq: number, speaker: Seat, target: Seat | null, text: string) => ({
      seq,
      day: 1,
      round: -1,
      speaker,
      act: 'ballot',
      target,
      role: null,
      verdict: null,
      text,
    });
    expect(state.transcript).toEqual([
      row(0, 'p4', null, 'not my problem'),
      row(1, 'p5', 'p4', 'the check stands'),
      row(2, 'p6', 'p4', ''),
      row(3, 'p7', 'p4', ''),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Terminal conditions
// ---------------------------------------------------------------------------

describe('werewolf terminal conditions', () => {
  it('village wins when the last wolf dies, and dead teammates win with it', () => {
    const s = fresh();
    slay(s, 'p1'); // a villager eaten on night 1
    slay(s, 'p0', 'lynch');
    expect(isTerminal(s)).toBeNull(); // p4 still prowling
    slay(s, 'p4', 'lynch');
    const r = isTerminal(s)!;
    expect(r.reason).toBe('village');
    expect(r.draw).toBe(false);
    expect(r.winners).toEqual(VILLAGE); // includes the dead p1
    expect(r.teams).toEqual(teamsOf(s));
    expect(r.teams).toEqual({
      p0: 'wolves',
      p1: 'village',
      p2: 'village',
      p3: 'village',
      p4: 'wolves',
      p5: 'village',
      p6: 'village',
      p7: 'village',
    });
  });

  it('wolves win on parity, not on a majority', () => {
    const s = fresh();
    for (const p of ['p1', 'p2', 'p3']) slay(s, p);
    expect(isTerminal(s)).toBeNull(); // 2 wolves vs 3 town
    slay(s, 'p5');
    const r = isTerminal(s)!; // 2 vs 2
    expect(r.reason).toBe('wolves');
    expect(r.winners).toEqual(WOLVES);
    expect(r.draw).toBe(false);

    // One wolf against one villager is also parity.
    const solo = fresh();
    for (const p of ['p1', 'p2', 'p3', 'p5', 'p6']) slay(solo, p);
    slay(solo, 'p0', 'lynch');
    expect(isTerminal(solo)).toMatchObject({ reason: 'wolves', winners: WOLVES });
  });

  it('a lynch that ends the game does NOT run dusk, and the day stays put', () => {
    const s = atVote(fresh());
    for (const p of ['p1', 'p2', 'p3']) slay(s, p);
    slay(s, 'p0', 'lynch'); // one wolf left, 4 town: not terminal yet
    expect(isTerminal(s)).toBeNull();
    const moves: Record<Seat, WwMove> = {};
    for (const p of playersToMove(s)) moves[p] = { t: 'vote', target: 'p4', text: '' };
    const { state } = fillPhase(s, moves);
    expect(state.phase).toBe('over');
    expect(state.day).toBe(1); // no dusk on a terminal state
    expect(state.transcript).toHaveLength(4); // the final day's prose survives
    expect(state.archivedCount).toBe(0);
    expect(isTerminal(state)).toMatchObject({ reason: 'village' });
    expect(playersToMove(state)).toEqual([]);
    expect(legalMoves(state, 'p5')).toEqual([]);
    expect(mustReject(state, 'p5', { t: 'say', text: '' })).toMatchObject({
      code: 'game_over',
      message: 'the game has ended',
    });
  });

  it('DAY_LIMIT expires the game in the wolves favour, one day later', () => {
    const s = atVote(fresh(), DAY_LIMIT);
    expect(isTerminal(s)).toBeNull(); // day 6 is still playable
    const moves: Record<Seat, WwMove> = {};
    for (const p of playersToMove(s)) moves[p] = { t: 'abstain', text: '' };
    const { state } = fillPhase(s, moves);
    expect(state.day).toBe(DAY_LIMIT + 1); // dusk ran, then the limit bound
    expect(state.phase).toBe('over');
    expect(isTerminal(state)).toMatchObject({
      reason: 'day_limit',
      winners: WOLVES,
      draw: false,
    });
  });

  it('the check ORDER is load-bearing: a day-6 kill of the last wolf reads village', () => {
    const s = fresh();
    s.day = DAY_LIMIT + 1;
    slay(s, 'p0', 'lynch');
    slay(s, 'p4', 'lynch');
    expect(isTerminal(s)!.reason).toBe('village'); // NOT day_limit
    // Parity also outranks the limit.
    const parity = fresh();
    parity.day = DAY_LIMIT + 1;
    for (const p of ['p1', 'p2', 'p3', 'p5'] as const) slay(parity, p);
    expect(isTerminal(parity)!.reason).toBe('wolves');
  });

  it('an ELIMINATED seat still wins with its team', () => {
    const s = fresh();
    const out = forfeitPlayer(s, 'p1')!;
    expect(out).not.toBeNull();
    expect(out.state.alive['p1']).toBe(false);
    expect(out.state.cause['p1']).toBe('abandoned');
    expect(out.state.revealed['p1']).toBe('villager');
    expect(data(eventsOf(out.events, 'seat_lost')[0]!)).toEqual({
      day: 1,
      seat: 'p1',
      role: 'villager',
      reason: 'abandoned',
    });
    const s2 = out.state;
    slay(s2, 'p0', 'lynch');
    slay(s2, 'p4', 'lynch');
    const r = isTerminal(s2)!;
    expect(r.reason).toBe('village');
    expect(r.winners).toContain('p1');
    // An elimination is never terminal on its own while both sides survive.
    expect(forfeitPlayer(fresh(), 'p9')).toBeNull();
    const dead = fresh();
    slay(dead, 'p3');
    expect(forfeitPlayer(dead, 'p3')).toBeNull();
  });

  it('a draw is never possible', () => {
    for (let i = 0; i < 24; i++) {
      const sd = seed(`draws:${i}`);
      let s = createInitialState(sd, SEATS, {});
      const pick = seed(`draws:${i}:pick`);
      while (isTerminal(s) === null) {
        for (const p of playersToMove(s)) {
          const legal = legalMoves(s, p);
          s = mustApply(s, p, legal[pick.int('pick', legal.length)]!).state;
        }
      }
      const r = isTerminal(s)!;
      expect(r.draw).toBe(false);
      expect(r.winners.length).toBeGreaterThan(0);
      expect(['village', 'wolves', 'day_limit']).toContain(r.reason);
      const team = r.reason === 'village' ? 'village' : 'wolves';
      expect(r.winners.slice().sort()).toEqual(
        s.players.filter((p) => r.teams![p] === team).sort(),
      );
    }
  });
});
