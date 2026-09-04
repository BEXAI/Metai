/**
 * Werewolf — pure rules. Eight seats, 2 werewolves / 1 seer / 1 doctor /
 * 4 villagers, over a phase machine:
 *
 *   night (every living seat) -> day_talk r0 -> day_talk r1
 *        -> day_defense (one seat, skipped when nobody was accused)
 *        -> day_vote (every living seat) -> night (day+1) ... -> over
 *
 * Speech is a MOVE PAYLOAD, not a side channel: every move variant carries
 * `text`, apply() phase-gates and length-gates it, and it lands in the state,
 * the state hash, the signed log and the offline verifier.
 *
 * All randomness is drawn from the SeedStream, and there is exactly one draw
 * site in the whole game:
 *   'deal:roles'   one Fisher-Yates shuffle of ROLE_MULTISET at setup =
 *                  EXACTLY SEVEN int() draws (src/kernel/seed.ts:75-83 loops
 *                  i = a.length-1 down to 1), maxExclusive 8,7,6,5,4,3,2.
 * Nothing else touches the seed: night kill ties break to the lowest-seat
 * wolf, lynch ties are no-lynch, and the defender is argmax with a lowest-seat
 * tiebreak. A WHOLE WEREWOLF REPLAY HAS SEVEN SEED DRAWS.
 *
 * Roles are never derived from seat index. src/match/pairing.ts:248-253
 * shuffles seats with the MATCH-layer secret, which the pairer holds at
 * creation time; roles come only from the room's commit-revealed final seed.
 */

import { canonicalJson, sha256Hex } from '../../crypto/canonical.ts';
import type {
  ApplyOk,
  GameEvent,
  GameResult,
  Json,
  PlayerId,
  RuleError,
  SeedStream,
  VariantConfig,
} from '../../kernel/types.ts';
import {
  DAY_LIMIT,
  DEFENSE_BUDGET_MS,
  GENESIS_DIGEST,
  NIGHT_BUDGET_MS,
  ROLES_CANON,
  ROLE_MULTISET,
  SEAT_COUNT,
  TALK_BUDGET_MS,
  TALK_ROUNDS,
  VERDICTS_CANON,
  VOTE_BUDGET_MS,
  capFor,
  isRoleName,
  isVerdictName,
  normalizeSpeech,
  type Cause,
  type Phase,
  type Role,
  type Verdict,
} from './board.ts';

// ---------------------------------------------------------------------------
// State and move shapes (plain JSON; `type`, not `interface`, so they satisfy
// Json's index signature). NO optional properties: absence is `| null` or
// key-absence in a Record, which canonicalJson (src/crypto/canonical.ts:31)
// skips, so key-absence survives the codec round-trip and hashes identically.
// ---------------------------------------------------------------------------

export type Seat = string; // 'p0'..'p7'

export type NightActT = 'kill' | 'stay_in' | 'peek' | 'guard' | 'sleep';

/** The act label a transcript row carries. */
export type UttAct = 'say' | 'accuse' | 'defend' | 'claim' | 'report' | 'defense' | 'ballot';

/** A day-phase speech act, before settle() materialises it. */
export type SaidAct = 'say' | 'accuse' | 'defend' | 'claim' | 'report';

export type Utterance = {
  /** Monotone; assigned in settle(), in SEAT order. */
  seq: number;
  day: number;
  /** 0..TALK_ROUNDS-1 in day_talk; -1 for the defence and for ballots. */
  round: number;
  speaker: Seat;
  act: UttAct;
  target: Seat | null;
  role: Role | null;
  verdict: Verdict | null;
  text: string;
};

export type NightAct = { t: NightActT; target: Seat | null; text: string };
export type SaidEntry = {
  act: SaidAct;
  target: Seat | null;
  role: Role | null;
  verdict: Verdict | null;
  text: string;
};
export type Ballot = { target: Seat | null; text: string };

export type WwState = {
  // ---- immutable setup ----
  players: Seat[];
  /** HIDDEN. Never leaves this module except through a viewer-scoped surface. */
  roles: Record<Seat, Role>;

  // ---- clock ----
  day: number;
  phase: Phase;
  round: number;
  seq: number;

  // ---- HIDDEN ledgers ----
  peeks: { day: number; seer: Seat; target: Seat; verdict: Verdict }[];
  guards: { day: number; doctor: Seat; target: Seat; saved: boolean }[];
  kills: { day: number; wolf: Seat; target: Seat; died: boolean }[];
  /** Wolf channel. SHARED between the pack, not owner-exclusive. */
  packLog: { day: number; from: Seat; text: string }[];
  /** Owner-exclusive night notes. */
  noteLog: { day: number; who: Seat; text: string }[];

  // ---- PUBLIC structure: permanent, prose-free ----
  alive: Record<Seat, boolean>;
  /** Dead seats only. */
  cause: Record<Seat, Cause>;
  /** Dead seats only. Every death reveals, for all three causes. */
  revealed: Record<Seat, Role>;
  claims: { day: number; seq: number; speaker: Seat; role: Role }[];
  reports: { day: number; seq: number; speaker: Seat; target: Seat; verdict: Verdict }[];
  edges: { day: number; seq: number; from: Seat; to: Seat; polarity: 'accuse' | 'defend' }[];
  voteHistory: { day: number; ballots: Record<Seat, Seat | null>; lynched: Seat | null }[];
  /** `died` ONLY. There is deliberately no public `saved` flag — see resolveNight. */
  nights: { day: number; died: Seat | null }[];
  defenders: { day: number; seat: Seat }[];

  // ---- PROSE: bounded to the CURRENT day ----
  transcript: Utterance[];
  archivedCount: number;
  /** Rolling sha256 chain over evicted transcript rows. Genesis: GENESIS_DIGEST. */
  archivedDigest: string;

  // ---- PER-PHASE SLOT MAPS. Key-presence IS the slot. ----
  nightActs: Record<Seat, NightAct>;
  said: Record<Seat, SaidEntry>;
  ballots: Record<Seat, Ballot>;
  defender: Seat | null;
  defended: boolean;
};

/**
 * `target`/`role`/`verdict` are typed `string`, NOT the narrow unions — the
 * landlord convention (landlord/rules.ts:128 types `prop: string`). That is
 * what makes parseMove TOTAL: vote(p99), claim(wizard) and report(p1,wizard)
 * all PARSE and are rejected by apply() with a specific RuleError, producing a
 * useful attempt-1 message instead of `unrecognized move`.
 *
 * There is no `pass` act. The silent day act is `say` with text '' — exactly
 * what legalMoves index 0 and defaultMove both produce — so a submitted
 * utterance is never silently discarded on the "silent" template.
 */
export type WwMove =
  // night (SIMULTANEOUS; every living seat is a mover)
  | { t: 'kill'; target: string; text: string } // werewolf only
  | { t: 'stay_in'; text: string } // werewolf: decline to kill
  | { t: 'peek'; target: string; text: string } // seer only
  | { t: 'guard'; target: string; text: string } // doctor only (self allowed)
  | { t: 'sleep'; text: string } // everyone else
  // day_talk / day_defense
  | { t: 'say'; text: string } // text '' == SILENCE
  | { t: 'accuse'; target: string; text: string }
  | { t: 'defend'; target: string; text: string }
  | { t: 'claim'; role: string; text: string }
  | { t: 'report'; target: string; verdict: string; text: string }
  // day_vote (SIMULTANEOUS)
  | { t: 'vote'; target: string; text: string }
  | { t: 'abstain'; text: string };

/** The one purpose string this game draws on. */
export const DEAL_PURPOSE = 'deal:roles';

/**
 * settle() tripwire. Each iteration either returns or strictly advances the
 * phase cycle, and one apply() can advance at most 5 phases
 * (night -> talk r0 -> talk r1 -> defence -> vote -> night), so this is never
 * reached. It is a bound, not a policy.
 */
export const SETTLE_MAX_STEPS = 16;

export function err(code: string, message: string): RuleError {
  return { error: true, code, message };
}

function ev(
  type: string,
  data: GameEvent['data'],
  visibility: 'public' | 'private' = 'public',
  to?: Seat[],
): GameEvent {
  const e: GameEvent = { type, data, visibility };
  if (to) e.to = to;
  return e;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Living seats, ALWAYS ascending by seat (s.players is seat-ordered). */
export function livingSeats(s: WwState): Seat[] {
  return s.players.filter((p) => s.alive[p] === true);
}

/** Every werewolf seat, alive or dead. A dead wolf already knew its pack. */
export function wolfSeats(s: WwState): Seat[] {
  return s.players.filter((p) => s.roles[p] === 'werewolf');
}

export function roleOf(s: WwState, p: Seat): Role {
  const r = s.roles[p];
  /* c8 ignore next */
  if (r === undefined) throw new Error(`werewolf: ${p} is not seated`);
  return r;
}

/**
 * The seat this doctor guarded most recently, or null. Reads only the doctor's
 * OWN already-committed history, so the "not two nights running" rule stays
 * order-independent inside a simultaneous night.
 */
export function lastGuardTarget(s: WwState, doctor: Seat): Seat | null {
  for (let i = s.guards.length - 1; i >= 0; i--) {
    const g = s.guards[i]!;
    if (g.doctor === doctor) return g.target;
  }
  return null;
}

/** Accusations `seat` has received today, counting every edge (both rounds). */
export function countAccusations(s: WwState, seat: Seat): number {
  let n = 0;
  for (const e of s.edges) {
    if (e.day === s.day && e.polarity === 'accuse' && e.to === seat) n++;
  }
  return n;
}

/**
 * The seat that goes to a defence: argmax of accusations received today among
 * LIVING seats, ties to the LOWEST seat index (strict `>` in an ascending
 * scan). Null when nobody was accused. ZERO SEED DRAWS.
 */
export function mostAccused(s: WwState): Seat | null {
  let best: Seat | null = null;
  let bestN = 0;
  for (const q of livingSeats(s)) {
    const n = countAccusations(s, q);
    if (n > bestN) {
      bestN = n;
      best = q;
    }
  }
  return best;
}

function phaseEvent(s: WwState): GameEvent {
  return ev(
    'phase',
    { day: s.day, phase: s.phase, round: s.round, pending: playersToMove(s) },
    'public',
  );
}

/** Raw (possibly non-string) move argument, for error messages. */
function rawArg(move: WwMove, key: 'target' | 'role' | 'verdict'): string {
  const v = (move as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : String(v);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function createInitialState(
  seed: SeedStream,
  players: PlayerId[],
  _variant: VariantConfig,
): WwState {
  if (players.length !== SEAT_COUNT) {
    throw new Error(`werewolf is an ${SEAT_COUNT}-seat game, got ${players.length}`);
  }
  // The entire randomness surface: one shuffle, seven int() draws.
  const dealt = seed.shuffle(DEAL_PURPOSE, ROLE_MULTISET);
  const s: WwState = {
    players: players.slice(),
    roles: {},
    day: 1,
    phase: 'night',
    round: 0,
    seq: 0,
    peeks: [],
    guards: [],
    kills: [],
    packLog: [],
    noteLog: [],
    alive: {},
    cause: {},
    revealed: {},
    claims: [],
    reports: [],
    edges: [],
    voteHistory: [],
    nights: [],
    defenders: [],
    transcript: [],
    archivedCount: 0,
    archivedDigest: GENESIS_DIGEST,
    nightActs: {},
    said: {},
    ballots: {},
    defender: null,
    defended: false,
  };
  for (let i = 0; i < players.length; i++) {
    const p = players[i]!;
    s.roles[p] = dealt[i]!;
    s.alive[p] = true;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

/**
 * The single source of truth for the result — deliberately NOT cached in the
 * state, because verify.ts:344-361 re-runs this on the recomputed final state
 * and a cached copy would be a second authority that could disagree.
 *
 * The check ORDER is load-bearing: `wolfAlive === 0` first means a lynch that
 * kills the last wolf on day 6 reads 'village', not 'day_limit', even after
 * dusk has already incremented the day.
 *
 * WINNERS INCLUDE DEAD TEAMMATES. A villager killed on night 1 wins a village
 * victory, and a seat removed by forfeitPlayer still wins with its team.
 */
export function isTerminal(s: WwState): GameResult | null {
  const wolves = s.players.filter((p) => s.roles[p] === 'werewolf');
  const village = s.players.filter((p) => s.roles[p] !== 'werewolf');
  const wolfAlive = wolves.filter((p) => s.alive[p] === true).length;
  const restAlive = village.filter((p) => s.alive[p] === true).length;
  const teams = teamsOf(s);

  if (wolfAlive === 0) return { winners: village, draw: false, reason: 'village', teams };
  if (wolfAlive >= restAlive) return { winners: wolves, draw: false, reason: 'wolves', teams };
  // An indecisive town loses. With 6 town votes against 2 wolf votes the town
  // can always out-vote a tie-forcing pack IF IT COORDINATES, so this is a
  // coordination tax, not a wolf freebie.
  if (s.day > DAY_LIMIT) return { winners: wolves, draw: false, reason: 'day_limit', teams };
  return null;
}

/** Team map for the rating layer. isTerminal also returns it inline. */
export function teamsOf(s: WwState): Record<Seat, string> {
  const teams: Record<Seat, string> = {};
  for (const p of s.players) teams[p] = s.roles[p] === 'werewolf' ? 'wolves' : 'village';
  return teams;
}

// ---------------------------------------------------------------------------
// Whose move
// ---------------------------------------------------------------------------

/**
 * MUST NEVER RETURN [] WHILE isTerminal() IS null. core.ts:1244-1248 throws
 * 'room ... is running but no one is to move'; rooms/room.ts:471-482 catches
 * that into a permanent 5-second alarm loop while POST /move returns 500
 * forever. settle() guarantees the state never RESTS in a zero-mover
 * configuration, and gate A1 (playout.ts) is the tripwire on every playout.
 *
 * EVERY LIVING SEAT ACTS EVERY NIGHT. buildView ships `to_move` to every
 * seated player (view.ts:58) and publicStateSummary publishes players_to_move
 * and waiting_for (core.ts:554-555): if night movers were {wolves, seer,
 * doctor}, every villager would read the exact power-role seat set off
 * `to_move` on night 1. It also keeps movers.length >= 2 all night, so the
 * night stays on the collect-then-resolve path (core.ts:760-763).
 */
export function playersToMove(s: WwState): Seat[] {
  if (s.phase === 'over') return [];
  if (isTerminal(s) !== null) return [];
  const living = livingSeats(s);
  switch (s.phase) {
    case 'night':
      return living.filter((p) => s.nightActs[p] === undefined);
    case 'day_talk':
      return living.filter((p) => s.said[p] === undefined);
    case 'day_defense':
      return s.defender !== null && s.alive[s.defender] === true && !s.defended
        ? [s.defender]
        : [];
    case 'day_vote':
      return living.filter((p) => s.ballots[p] === undefined);
    /* c8 ignore next 2 */
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Legal move enumeration
// ---------------------------------------------------------------------------

/**
 * Canonical order. INDEX 0 IS THE NULL ACT IN EVERY PHASE — stay_in for a
 * night wolf, sleep for every other night seat, `say` with text '' by day,
 * abstain in day_vote — and it deep-equals defaultMove() there.
 *
 * The reason is verified code, not taste: EVERY fallback path in the hall
 * lands on index 0 (agents/anthropic.ts:144 on a network error, :159 after an
 * unparseable repair round-trip, agents/mock-llm.ts:53 on script exhaustion).
 * Under any other ordering a transient 500 from the Messages API would make a
 * house wolf murder the lowest-seat living villager, deterministically, every
 * time. The cost — an index-0-only client is silent and inert — is the visible
 * skill floor this design wants.
 *
 * ORDER-INDEPENDENCE. submitSimultaneous resolves {index:n} against the state
 * AT SUBMISSION TIME (core.ts:1029 -> 776-782), not at resolution time. Every
 * branch below reads only `roles`, `alive`, `phase`, `guards` and the
 * speaker's own slot — none of which any move in a simultaneous phase mutates.
 *
 * Peak 34 entries at 8 alive, three orders of magnitude under the 5,000
 * maxMoves cap, so legalMovesPaged is not required.
 */
export function legalMoves(s: WwState, player: Seat): WwMove[] {
  if (!playersToMove(s).includes(player)) return [];
  const living = livingSeats(s);

  switch (s.phase) {
    case 'night': {
      const role = roleOf(s, player);
      if (role === 'werewolf') {
        // 7 @ 8 alive. Excluding the pack lives only in a wolf's own
        // legal_moves, and a wolf already knows its pack.
        const out: WwMove[] = [{ t: 'stay_in', text: '' }];
        for (const q of living) {
          if (s.roles[q] !== 'werewolf') out.push({ t: 'kill', target: q, text: '' });
        }
        return out;
      }
      if (role === 'seer') {
        const out: WwMove[] = [{ t: 'sleep', text: '' }]; // 8 @ 8 alive
        for (const q of living) if (q !== player) out.push({ t: 'peek', target: q, text: '' });
        return out;
      }
      if (role === 'doctor') {
        const last = lastGuardTarget(s, player);
        const out: WwMove[] = [{ t: 'sleep', text: '' }]; // 9 @ 8 alive, night 1
        for (const q of living) if (q !== last) out.push({ t: 'guard', target: q, text: '' });
        return out;
      }
      return [{ t: 'sleep', text: '' }]; // villager: exactly one option
    }

    case 'day_talk':
    case 'day_defense': {
      const out: WwMove[] = [{ t: 'say', text: '' }]; // 0: SILENCE
      for (const q of living) if (q !== player) out.push({ t: 'accuse', target: q, text: '' });
      for (const q of living) out.push({ t: 'defend', target: q, text: '' }); // self allowed
      for (const r of ROLES_CANON) out.push({ t: 'claim', role: r, text: '' });
      // report(q,v) starts at index 2L+4, q OUTER (excluding self), v INNER.
      for (const q of living) {
        if (q === player) continue;
        for (const v of VERDICTS_CANON) out.push({ t: 'report', target: q, verdict: v, text: '' });
      }
      return out;
    }

    case 'day_vote': {
      const out: WwMove[] = [{ t: 'abstain', text: '' }]; // 9 @ 8 alive
      for (const q of living) out.push({ t: 'vote', target: q, text: '' }); // self allowed
      return out;
    }

    /* c8 ignore next 2 */
    default:
      return [];
  }
}

/**
 * MANDATORY. Without it core.ts:1097-1099, core.ts:1286-1288 and
 * verify.ts:312-318 all fall back to a seeded random pick from `legal` under
 * the room's reserved timeout purpose — i.e. THE CLOCK PICKS A MURDER VICTIM
 * OR CASTS THE DECIDING LYNCH VOTE. By construction this deep-equals
 * legalMoves(s, p)[0] in every phase for every role. And because
 * bindUtterance is never called on the forced or timeout paths, a forced move
 * always carries text: '' — the engine can never attribute fabricated words
 * to an agent.
 */
export function defaultMove(s: WwState, p: Seat, _legal: WwMove[]): WwMove {
  if (s.phase === 'night') {
    return s.roles[p] === 'werewolf' ? { t: 'stay_in', text: '' } : { t: 'sleep', text: '' };
  }
  if (s.phase === 'day_vote') return { t: 'abstain', text: '' };
  return { t: 'say', text: '' };
}

/** Per-phase move budget, consumed by RoomCore.budgetMs(). */
export function phaseBudgetMs(s: WwState): number | null {
  switch (s.phase) {
    case 'night':
      return NIGHT_BUDGET_MS;
    case 'day_talk':
      return TALK_BUDGET_MS;
    case 'day_defense':
      return DEFENSE_BUDGET_MS;
    case 'day_vote':
      return VOTE_BUDGET_MS;
    case 'over':
      return null;
  }
}

// ---------------------------------------------------------------------------
// apply()
// ---------------------------------------------------------------------------

/**
 * ORDER-INDEPENDENCE CONTRACT — READ BEFORE EDITING.
 * night, day_talk and day_vote are SIMULTANEOUS: several seats move at one
 * shared turn index and rooms/core.ts:1070-1080 replays the held submissions
 * in strict SEAT ORDER. A held move that has become illegal by its turn costs
 * that seat a STRIKE plus a seeded random substitute (core.ts:1104-1119), and
 * three strikes eliminate the seat.
 * Therefore every branch below writes ONLY this player's own slot key
 * (nightActs[p] / said[p] / ballots[p]) and reads only (a) immutable setup,
 * (b) fields no move in the current phase mutates, (c) its own slot.
 * FORBIDDEN BY CONSTRUCTION: any rule depending on a running tally inside a
 * simultaneous phase ("you may not vote a seat already at majority", "max
 * three accusations per round", "the doctor may not guard tonight's kill
 * target"). Every one of those strikes p6 and p7 for a move that was legal
 * when they cast it.
 * ALSO FORBIDDEN: eliminating or de-queueing another mover mid-phase.
 * core.ts:1080 silently `continue`s past a held submission whose owner has
 * left playersToMove -- no log entry, no history, no event, no rejection, even
 * though that agent already received { ok:true, applied:false, waiting_for }.
 * All deaths resolve in settle(), after every submission is consumed.
 * ALSO FORBIDDEN: pushing to transcript/edges/claims/reports/seq here. Those
 * are materialised in settle(), in seat order, or the state hash becomes
 * order-dependent.
 *
 * THE ORACLE RULE: any RuleError whose REACHABILITY depends on a hidden role
 * is an oracle. apply() may branch on roles[actor] FOR NIGHT VERBS ONLY (the
 * actor already knows its own role and the rejection returns only to the
 * submitter, core.ts:806-830). It must NEVER branch on roles[target] in a way
 * that changes the returned error or the resulting public state. The one
 * permitted exception is that a wolf's kill list excludes fellow wolves.
 *
 * Never throws: a hostile move body must become a structured RuleError.
 */
export function applyMove(
  state: WwState,
  player: PlayerId,
  move: WwMove,
  _seed: SeedStream,
): ApplyOk<WwState> | RuleError {
  if (isTerminal(state) !== null) return err('game_over', 'the game has ended');
  if (state.alive[player] !== true) return err('dead', `${player} has been eliminated`);
  if (!playersToMove(state).includes(player)) {
    return err('not_your_turn', `${player} is not to move in phase ${state.phase}`);
  }
  if (typeof move !== 'object' || move === null || typeof (move as { t?: unknown }).t !== 'string') {
    return err('bad_move', 'move must be an object with a string "t"');
  }
  if (typeof (move as { text?: unknown }).text !== 'string') {
    return err('bad_text', 'move.text must be a string');
  }
  const text = move.text;
  const cap = capFor(state.phase);
  // Length is enforced HERE, not in the parser: truncating in parseMove would
  // silently change what an agent said and clip mid-word into the hash chain.
  // The turn is not consumed, so the agent can shorten and resubmit.
  if (text.length > cap) {
    return err('text_too_long', `text exceeds ${cap} characters (got ${text.length})`);
  }
  if (text !== normalizeSpeech(text)) {
    return err(
      'unnormalized_text',
      'text contains control, zero-width, bidi, or line-separator characters',
    );
  }

  const s = structuredClone(state);
  const events: GameEvent[] = [];

  switch (s.phase) {
    case 'night': {
      const bad = applyNight(s, player, move, text, events);
      if (bad !== null) return bad;
      break;
    }

    case 'day_talk':
    case 'day_defense': {
      const said = buildSaid(s, player, move, text);
      if ('error' in said) return said;
      s.said[player] = said;
      // Single mover, so this is not a simultaneous-order violation.
      if (s.phase === 'day_defense') s.defended = true;
      break;
    }

    case 'day_vote': {
      if (move.t === 'abstain') {
        s.ballots[player] = { target: null, text };
        break;
      }
      if (move.t === 'vote') {
        const target = rawArg(move, 'target');
        // Self-vote IS legal.
        if (s.alive[target] !== true) {
          return err('bad_target', `'${target}' is not a living seat`);
        }
        s.ballots[player] = { target, text };
        break;
      }
      return err('wrong_act', `in day_vote the moves are vote(seat) and abstain, not ${move.t}`);
    }

    /* c8 ignore next 2 */
    default:
      return err('wrong_phase', `no moves are accepted in phase ${s.phase}`);
  }

  settle(s, events);
  return { state: s, events };
}

/** Writes exactly one nightActs key, or returns the rejection. */
function applyNight(
  s: WwState,
  player: Seat,
  move: WwMove,
  text: string,
  events: GameEvent[],
): RuleError | null {
  const role = roleOf(s, player);
  const pack = wolfSeats(s);

  const record = (t: NightActT, target: Seat | null): null => {
    s.nightActs[player] = { t, target, text };
    if (text !== '') {
      // The words themselves land in packLog / noteLog in resolveNight, in
      // seat order; only the notification is emitted here.
      if (role === 'werewolf') {
        events.push(ev('pack_whisper', { day: s.day, from: player, text }, 'private', pack));
      } else {
        events.push(ev('night_note', { day: s.day, who: player, text }, 'private', [player]));
      }
    }
    return null;
  };

  if (role === 'werewolf') {
    if (move.t === 'stay_in') return record('stay_in', null);
    if (move.t === 'kill') {
      const target = rawArg(move, 'target');
      if (s.alive[target] !== true) return err('bad_target', `'${target}' is not a living seat`);
      if (s.roles[target] === 'werewolf') return err('bad_target', 'the pack does not eat its own');
      events.push(ev('kill_intent', { day: s.day, by: player, target }, 'private', pack));
      return record('kill', target);
    }
    return err('wrong_act', `a werewolf's night move is kill(seat) or stay_in, not ${move.t}`);
  }

  if (role === 'seer') {
    if (move.t === 'sleep') return record('sleep', null);
    if (move.t === 'peek') {
      const target = rawArg(move, 'target');
      if (target === player) return err('bad_target', 'the seer cannot check itself');
      if (s.alive[target] !== true) return err('bad_target', `'${target}' is not a living seat`);
      const verdict: Verdict = s.roles[target] === 'werewolf' ? 'wolf' : 'clear';
      events.push(ev('peek_result', { day: s.day, target, verdict }, 'private', [player]));
      return record('peek', target);
    }
    return err('wrong_act', `the seer's night move is peek(seat) or sleep, not ${move.t}`);
  }

  if (role === 'doctor') {
    if (move.t === 'sleep') return record('sleep', null);
    if (move.t === 'guard') {
      const target = rawArg(move, 'target');
      if (s.alive[target] !== true) return err('bad_target', `'${target}' is not a living seat`);
      // Reads only this doctor's OWN committed history, so it is
      // order-independent inside the simultaneous night. Self-guard is legal.
      if (target === lastGuardTarget(s, player)) {
        return err('repeat_guard', `the doctor may not guard ${target} two nights running`);
      }
      events.push(ev('guard_choice', { day: s.day, target }, 'private', [player]));
      return record('guard', target);
    }
    return err('wrong_act', `the doctor's night move is guard(seat) or sleep, not ${move.t}`);
  }

  if (move.t === 'sleep') return record('sleep', null);
  return err('wrong_act', `a villager's only night move is sleep, not ${move.t}`);
}

/**
 * Validates a day-phase speech act into its slot entry. `report` and `claim`
 * are NEVER validated against the truth — anyone may assert anything. That is
 * the bluff, and it is the game.
 */
function buildSaid(s: WwState, player: Seat, move: WwMove, text: string): SaidEntry | RuleError {
  switch (move.t) {
    case 'say':
      return { act: 'say', target: null, role: null, verdict: null, text };
    case 'accuse': {
      const target = rawArg(move, 'target');
      if (target === player) return err('bad_target', 'you cannot accuse yourself');
      if (s.alive[target] !== true) return err('bad_target', `'${target}' is not a living seat`);
      return { act: 'accuse', target, role: null, verdict: null, text };
    }
    case 'defend': {
      const target = rawArg(move, 'target');
      if (s.alive[target] !== true) return err('bad_target', `'${target}' is not a living seat`);
      return { act: 'defend', target, role: null, verdict: null, text }; // self allowed
    }
    case 'claim': {
      const role = rawArg(move, 'role');
      if (!isRoleName(role)) {
        return err('bad_role', `'${role}' is not a role (${ROLES_CANON.join(', ')})`);
      }
      return { act: 'claim', target: null, role, verdict: null, text };
    }
    case 'report': {
      const target = rawArg(move, 'target');
      const verdict = rawArg(move, 'verdict');
      if (target === player) return err('bad_target', 'you cannot report on yourself');
      if (s.alive[target] !== true) return err('bad_target', `'${target}' is not a living seat`);
      if (!isVerdictName(verdict)) {
        return err('bad_verdict', `'${verdict}' is not a verdict (${VERDICTS_CANON.join(', ')})`);
      }
      return { act: 'report', target, role: null, verdict, text };
    }
    default:
      return err(
        'wrong_act',
        `in ${s.phase} the moves are say, accuse(seat), defend(seat), claim(role) and report(seat,verdict), not ${move.t}`,
      );
  }
}

// ---------------------------------------------------------------------------
// settle() — the phase engine
// ---------------------------------------------------------------------------

/**
 * Runs after EVERY applied move (and after forfeitPlayer). Advances the phase
 * only when the LAST slot of the current phase is filled, then repeats so a
 * cascade (last ballot -> tally -> dusk -> night) completes inside one apply().
 *
 * INVARIANT on return: phase === 'over' || playersToMove(s).length > 0.
 *
 * Resolution therefore happens ONLY in the last actor's apply(). Both
 * leakage.ts:41-50 and playout.ts:83-105 capture playersToMove ONCE and then
 * apply each mover in sequence; if a mid-list apply transitioned the phase, a
 * later captured mover would get legalMoves === [] and the harness would
 * throw. Gates A1 and A10 both depend on this discipline.
 */
function settle(s: WwState, events: GameEvent[]): void {
  for (let step = 0; step < SETTLE_MAX_STEPS; step++) {
    if (s.phase === 'over') return;
    if (isTerminal(s) !== null) {
      s.phase = 'over';
      events.push(phaseEvent(s));
      return;
    }
    const living = livingSeats(s);

    if (s.phase === 'night') {
      if (living.some((p) => s.nightActs[p] === undefined)) return;
      resolveNight(s, events);
      continue;
    }

    if (s.phase === 'day_talk') {
      if (living.some((p) => s.said[p] === undefined)) return;
      drainSaid(s, events); // seat order; assigns seq
      s.said = {};
      if (s.round + 1 < TALK_ROUNDS) {
        s.round += 1;
        events.push(phaseEvent(s));
        continue;
      }
      s.round = 0;
      const d = mostAccused(s);
      if (d === null) {
        openVote(s, events);
        continue;
      }
      s.defender = d;
      s.defended = false;
      s.phase = 'day_defense';
      s.defenders.push({ day: s.day, seat: d });
      events.push(
        ev('defense', { day: s.day, seat: d, accusations: countAccusations(s, d) }, 'public'),
      );
      events.push(phaseEvent(s));
      continue;
    }

    if (s.phase === 'day_defense') {
      // A forfeit can kill the defender mid-phase; never rest with 0 movers.
      if (s.defender === null || s.alive[s.defender] !== true || s.defended) {
        openVote(s, events);
        continue;
      }
      return;
    }

    if (s.phase === 'day_vote') {
      if (living.some((p) => s.ballots[p] === undefined)) return;
      resolveVote(s, events);
      continue;
    }

    /* c8 ignore next 2 */
    return;
  }
  /* c8 ignore next 3 */
  /* Unreachable: each iteration returns or strictly advances the phase cycle,
     and one apply() can advance at most 5 phases. SETTLE_MAX_STEPS is a
     tripwire, not a policy. */
}

/**
 * Materialises the day's speech in SEAT order — the reason hash
 * order-independence is genuinely true rather than a tautology. The ledger
 * arrays (edges/claims/reports) get the TRUE act; the transcript row's `act`
 * is phase-derived, so a defence row is labelled 'defense' and a ballot row
 * 'ballot' while their payload (target/role/verdict) is preserved.
 */
function drainSaid(s: WwState, events: GameEvent[]): void {
  const isDefence = s.phase === 'day_defense';
  for (const p of s.players) {
    const e = s.said[p];
    if (e === undefined) continue;
    const seq = s.seq++;
    const round = isDefence ? -1 : s.round;
    const act: UttAct = isDefence ? 'defense' : e.act;
    s.transcript.push({
      seq,
      day: s.day,
      round,
      speaker: p,
      act,
      target: e.target,
      role: e.role,
      verdict: e.verdict,
      text: e.text,
    });
    if (e.act === 'accuse' && e.target !== null) {
      s.edges.push({ day: s.day, seq, from: p, to: e.target, polarity: 'accuse' });
    } else if (e.act === 'defend' && e.target !== null) {
      s.edges.push({ day: s.day, seq, from: p, to: e.target, polarity: 'defend' });
    } else if (e.act === 'claim' && e.role !== null) {
      s.claims.push({ day: s.day, seq, speaker: p, role: e.role });
    } else if (e.act === 'report' && e.target !== null && e.verdict !== null) {
      s.reports.push({ day: s.day, seq, speaker: p, target: e.target, verdict: e.verdict });
    }
    events.push(
      ev(
        'speech',
        {
          seq,
          day: s.day,
          round,
          speaker: p,
          act,
          target: e.target,
          role: e.role,
          verdict: e.verdict,
          text: e.text,
        },
        'public',
      ),
    );
  }
}

/** Drains any pending defence utterance and opens the ballot. */
function openVote(s: WwState, events: GameEvent[]): void {
  drainSaid(s, events); // no-op unless a defence utterance is pending
  s.said = {};
  s.ballots = {};
  s.phase = 'day_vote';
  events.push(phaseEvent(s));
}

/**
 * Night resolution, inside the last night actor's apply() via settle().
 *
 * THE SUPPRESSED SAVE FLAG. Announcing "the wolves attacked but the healer
 * saved them" hands the village a FREE BIT: a doctor exists, is alive, and
 * guessed right. Suppressing it makes a quiet night AMBIGUOUS between a doctor
 * save and a wolf `stay_in`, which turns stay_in into a genuine bluff and
 * makes the doctor's own knowledge worth something. `saved` stays in
 * state.guards for the doctor's private view and for the replay. It is the
 * archetypal DERIVED-HIDDEN field: it has no owner, so no substring probe can
 * express it, and only the permutation theorems plus the frozen-key-set
 * assertion catch a regression here.
 */
function resolveNight(s: WwState, events: GameEvent[]): void {
  const living = livingSeats(s);

  // 1. The doctor's guard for tonight (there is at most one doctor).
  let guardDoctor: Seat | null = null;
  let guarded: Seat | null = null;
  for (const p of living) {
    const a = s.nightActs[p];
    if (a !== undefined && a.t === 'guard' && a.target !== null) {
      guardDoctor = p;
      guarded = a.target;
      break;
    }
  }

  // 2. The kill target of the LOWEST-SEAT living werewolf that submitted one.
  //    Deterministic tie-break, ZERO SEED DRAWS — two wolves may disagree and
  //    seat order decides, which is itself a real in-fiction dynamic.
  let killer: Seat | null = null;
  let victim: Seat | null = null;
  for (const p of living) {
    if (s.roles[p] !== 'werewolf') continue;
    const a = s.nightActs[p];
    if (a !== undefined && a.t === 'kill' && a.target !== null) {
      killer = p;
      victim = a.target;
      break;
    }
  }

  // 3. Guard beats kill.
  let died: Seat | null = null;
  let saved = false;
  if (killer !== null && victim !== null) {
    if (victim === guarded) {
      saved = true;
    } else {
      s.alive[victim] = false;
      s.cause[victim] = 'wolves';
      s.revealed[victim] = roleOf(s, victim);
      died = victim;
    }
    s.kills.push({ day: s.day, wolf: killer, target: victim, died: died !== null });
  }
  if (guardDoctor !== null && guarded !== null) {
    s.guards.push({ day: s.day, doctor: guardDoctor, target: guarded, saved });
    // `doctor` is in the PAYLOAD, not just in `to`. This event is emitted from
    // resolveNight, which runs inside the LAST night mover's apply() — so it is
    // written onto THAT seat's log entry, and any reader that attributes an
    // event to its entry's `player` (the post-game truth overlay does exactly
    // that) would brand a random villager as the doctor. Every other sealed
    // kind carries its own owner (`from`, `who`, `by`) or is emitted in the
    // owner's own apply; this one is the exception, and the fix belongs here
    // rather than in a reader, because per plan §5.4 nothing may depend on `to`.
    events.push(
      ev('guard_outcome', { day: s.day, doctor: guardDoctor, target: guarded, saved }, 'private', [guardDoctor]),
    );
  }

  // 4. Seer peeks, in seat order.
  for (const p of living) {
    const a = s.nightActs[p];
    if (a === undefined || a.t !== 'peek' || a.target === null) continue;
    s.peeks.push({
      day: s.day,
      seer: p,
      target: a.target,
      verdict: s.roles[a.target] === 'werewolf' ? 'wolf' : 'clear',
    });
  }

  // 5. Night text ledgers, in seat order.
  for (const p of living) {
    const a = s.nightActs[p];
    if (a === undefined || a.text === '') continue;
    if (s.roles[p] === 'werewolf') s.packLog.push({ day: s.day, from: p, text: a.text });
    else s.noteLog.push({ day: s.day, who: p, text: a.text });
  }

  // 6. Dawn. `died` ONLY — no public `saved` flag.
  s.nights.push({ day: s.day, died });
  s.nightActs = {};
  s.said = {};
  s.round = 0;
  s.phase = 'day_talk';
  events.push(
    ev('dawn', { day: s.day, died, role: died !== null ? roleOf(s, died) : null }, 'public'),
  );
  events.push(phaseEvent(s));
}

/**
 * Ballot resolution. STRICT PLURALITY LYNCHES; ANY TIE IS NO LYNCH. Abstains
 * are excluded from the tally and reported separately. ZERO SEED DRAWS.
 */
function resolveVote(s: WwState, events: GameEvent[]): void {
  // 1. Ballots drain in SEAT ORDER into the transcript.
  const ballots: Record<Seat, Seat | null> = {};
  const tally: Record<Seat, number> = {};
  let abstains = 0;
  for (const p of s.players) {
    const b = s.ballots[p];
    if (b === undefined) continue;
    const seq = s.seq++;
    s.transcript.push({
      seq,
      day: s.day,
      round: -1,
      speaker: p,
      act: 'ballot',
      target: b.target,
      role: null,
      verdict: null,
      text: b.text,
    });
    ballots[p] = b.target;
    if (b.target === null) abstains++;
    else tally[b.target] = (tally[b.target] ?? 0) + 1;
  }

  // 2. Strict plurality over LIVING seats; a seat eliminated mid-phase simply
  //    drops out of the tally and cannot be lynched.
  let lynched: Seat | null = null;
  let bestN = 0;
  let tied = false;
  for (const q of livingSeats(s)) {
    const n = tally[q] ?? 0;
    if (n > bestN) {
      bestN = n;
      lynched = q;
      tied = false;
    } else if (n === bestN && n > 0) {
      tied = true;
    }
  }
  const reason = bestN === 0 ? 'no_votes' : tied ? 'tie' : 'plurality';
  if (bestN === 0 || tied) lynched = null;

  s.voteHistory.push({ day: s.day, ballots, lynched });
  events.push(ev('ballots', { day: s.day, ballots }, 'public'));

  if (lynched !== null) {
    s.alive[lynched] = false;
    s.cause[lynched] = 'lynch';
    s.revealed[lynched] = roleOf(s, lynched);
  }
  events.push(
    ev(
      'lynch',
      {
        day: s.day,
        seat: lynched,
        role: lynched !== null ? roleOf(s, lynched) : null,
        tally,
        abstains,
        reason,
      },
      'public',
    ),
  );

  // 3. Do NOT run dusk on a terminal state: settle()'s next iteration sets
  //    phase = 'over' and the final day's transcript stays visible.
  if (isTerminal(s) !== null) return;
  dusk(s, events);
}

/**
 * EVICTION KEYS ON state.day, NEVER ON A MEASURED BYTE BUDGET. The room and
 * the offline verifier must evict at the SAME MOVE or every subsequent
 * state_hash comparison (verify.ts:331) diverges from that point on — a
 * divergence that looks EXACTLY like tampering.
 *
 * INVARIANT: seq === archivedCount + transcript.length, before and after.
 */
function dusk(s: WwState, events: GameEvent[]): void {
  for (const row of s.transcript) {
    s.archivedDigest = sha256Hex(s.archivedDigest + canonicalJson(row as unknown as Json));
    s.archivedCount++;
  }
  s.transcript = [];
  s.nightActs = {};
  s.said = {};
  s.ballots = {};
  s.defender = null;
  s.defended = false;
  s.round = 0;
  s.day++;
  s.phase = 'night';
  events.push(phaseEvent(s));
}

// ---------------------------------------------------------------------------
// Non-terminal elimination
// ---------------------------------------------------------------------------

/**
 * Consumed by RoomCore.eliminate(). Returning a state converts a
 * three-strikes / flag-fall loss into an in-game elimination instead of ending
 * the game with seven winners. It takes no SeedStream and makes NO seed draws,
 * so kernel/verify.ts recomputes it exactly.
 *
 * MUST return non-null for ANY living seat in a non-terminal game, or
 * RoomCore.eliminate() falls back to forfeit() and crowns seven seats.
 *
 * The abandoned seat's role is revealed, uniformly with the other two causes.
 * That is intentional: it is what keeps `wolves_remaining` derivable from
 * public data, and an eliminated seat STILL WINS WITH ITS TEAM.
 */
export function forfeitPlayer(state: WwState, player: Seat): ApplyOk<WwState> | null {
  if (isTerminal(state) !== null) return null;
  if (state.alive[player] !== true) return null;
  const s = structuredClone(state);
  const events: GameEvent[] = [];
  s.alive[player] = false;
  s.cause[player] = 'abandoned';
  s.revealed[player] = roleOf(s, player);
  delete s.nightActs[player];
  delete s.said[player];
  delete s.ballots[player];
  if (s.defender === player) {
    s.defender = null;
    s.defended = true; // settle() opens the vote
  }
  events.push(
    ev(
      'seat_lost',
      { day: s.day, seat: player, role: roleOf(s, player), reason: 'abandoned' },
      'public',
    ),
  );
  settle(s, events); // repairs every phase, including cascades
  return { state: s, events };
}

/**
 * Merged by RoomCore.endGame into the payload of the EXISTING post-`end`
 * `reveal` log entry and spectator event — not emitted from apply(), which
 * would put a role map into a pre-`end` event and fail the e2e probe scan
 * (test/e2e/e2e.e2etest.ts:103-122).
 *
 * The role map only. The night prose, peeks, guards and kills reach the
 * spectator through the REPLAY (the private GameEvents), which the API serves
 * once status === 'ended'.
 */
export function revealOnEnd(s: WwState): Json {
  const roles: Record<string, Json> = {};
  for (const p of s.players) roles[p] = roleOf(s, p);
  return { roles };
}

// ---------------------------------------------------------------------------
// Leakage probes (gate A10)
// ---------------------------------------------------------------------------

/**
 * Distinctive strings that would only appear if this seat's hidden role or
 * private ledger leaked. MULTI-ENCODING BY NECESSITY: a single `"p4":"seer"`
 * probe matches only a verbatim state.roles dump, and NO legitimate werewolf
 * surface uses that encoding — privateView emits "your_role", viewStateString
 * emits "role", the dossier emits a table row — so a single-encoding probe set
 * could only ever catch the one leak nobody would write.
 *
 * DELIBERATELY NOT PROBED, and why:
 *  - The wolf PACK is a legitimately SHARED secret. leakage.ts:69-92 has no
 *    notion of one, so a pack probe would fire on the PARTNER'S CORRECT view.
 *    (Covered by coalition.test.ts instead.) This is also why privateView must
 *    ship `pack` as a sorted Seat[] and never a role map, and why the dossier
 *    must print pack members as bare seats.
 *  - Free-text NIGHT NOTES. The harness only ever applies legalMoves output,
 *    i.e. text: '', so a note probe can never fire under A10 — while colliding
 *    with legitimate public speech the moment a real game runs, because an
 *    agent may repeat its own note aloud by day.
 *  - The seer's peek encoded as {target, verdict}: canonical JSON of a PUBLIC
 *    `reports` row contains `"target":"p1","verdict":"wolf"` verbatim, so that
 *    fragment fires on correct behaviour. The probe below pins the raw ledger
 *    row shape (`"seer":...`), which no public surface can produce.
 *
 * The isTerminal clause is what lets revealOnEnd and the terminal publicView
 * be honest without failing the e2e pre-end scan. It DOES weaken A10 at
 * terminal states; that is a decision, not an accident.
 */
export function secretProbes(s: WwState, p: PlayerId): string[] {
  if (s.alive[p] !== true && s.revealed[p] !== undefined) return []; // dead roles are public
  if (isTerminal(s) !== null) return []; // post-terminal: the reveal is legal
  const role = s.roles[p];
  if (role === undefined) return [];
  const out: string[] = [
    `"${p}":"${role}"`, // canonical roles-map fragment
    `"seat":"${p}","role":"${role}"`, // the viewStateString `you` shape
    `${p} ${role.toUpperCase()}`, // the dossier row shape
  ];
  for (const k of s.peeks) {
    if (k.seer === p) out.push(`"seer":"${p}","target":"${k.target}","verdict":"${k.verdict}"`);
  }
  for (const g of s.guards) {
    if (g.doctor === p) out.push(`"doctor":"${p}"`);
  }
  return out;
}
