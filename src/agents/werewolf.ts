/**
 * The werewolf house agent (plan §7.7) — the seat the hall fills when a table
 * cannot form from real entrants, and the rateable baseline every LLM is
 * measured against.
 *
 * Two tiers:
 *  - `silent`  always index 0, which this game defines as defaultMove: sleep /
 *    stay_in / say '' / abstain. The deliberate FLOOR, whose purpose is to make
 *    the spread measurable — if `basic` does not beat `silent`, and an LLM does
 *    not beat `basic`, the game is not measuring anything.
 *  - `basic`   a defensible real policy — "I believe structured claims and
 *    voting patterns, not speeches" — speaking from an engine-authored template
 *    bank with closed-enum slot fills from ledger facts and a seeded frame pick,
 *    so it is fully deterministic and A1/A2 and e2e replays hold.
 *
 * `random` (src/agents/random.ts) must NEVER take a seat here: a uniform pick
 * over legal_moves claim(seer)s and report(pN, wolf)s at random, which does not
 * add noise to the information channel — it destroys the one the real seer
 * needs. The roster filter that keeps it out lives in the pairer.
 *
 * THE ALLOW-LIST IS THE SAFETY PROPERTY, AND IT IS NARROWER THAN "read only the
 * engine's fields". `view.public` is NOT engine-authored throughout:
 * `public.transcript` is verbatim agent prose for the whole current day — the
 * single largest agent-text surface in the game, larger than `history`. So this
 * module destructures an EXPLICITLY ENUMERATED allow-list out of `public` and
 * out of `private`, and touches neither `public.transcript`, nor `history`, nor
 * `private_messages`, nor `board_text`. A test in
 * src/rooms/tests/house-driver.test.ts drives the agent through a recording
 * Proxy and asserts `transcript` is never dereferenced. With that the agent is
 * genuinely triple-duty: backfill, rateable baseline, and a valid A12 honeypot.
 *
 * Known limitations, stated rather than hidden:
 *  - A ledger-only agent cannot be lied to by prose, so an LLM wolf's best
 *    weapon is useless against a house-heavy table. Such tables therefore
 *    UNDER-measure a strong wolf and OVER-measure a strong seer. The answers are
 *    role-split W/L and not rating house-heavy tables — not pretending the
 *    number is clean.
 *  - It never `claim`s a role and a wolf never `report`s. Both are legitimate
 *    play; both are omitted so the baseline can never pollute the ledger with a
 *    fabricated check, and so its own role can never leak through its words.
 */

import { sha256Hex } from '../crypto/canonical.ts';
import { createSeedStream } from '../kernel/seed.ts';
import type { Json, SeedStream, ViewObject } from '../kernel/types.ts';
import { submissionByIndex, submissionByIndexWithUtterance, type HouseAdapter } from './adapter.ts';

export type WerewolfHouseTier = 'silent' | 'basic';

// ---------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------

type Seat = string;

interface Claim {
  speaker: Seat;
  role: string;
}
interface Report {
  speaker: Seat;
  target: Seat;
  verdict: string;
}
interface Edge {
  from: Seat;
  to: Seat;
  polarity: string;
}
interface Ballots {
  ballots: Record<Seat, Seat | null>;
  lynched: Seat | null;
}
interface DeadRow {
  seat: Seat;
  role: string | null;
}

/**
 * Exactly the nine public fields this policy is allowed to read. Written as one
 * destructuring so the allow-list is a single reviewable line rather than a
 * habit spread over the file — and so the recording-Proxy test sees precisely
 * these property reads and no others.
 */
interface Ledger {
  day: number;
  phase: string;
  alive: Seat[];
  dead: DeadRow[];
  claims: Claim[];
  reports: Report[];
  edges: Edge[];
  vote_history: Ballots[];
  nights: { died: Seat | null }[];
}

/** Exactly the five private fields this policy is allowed to read. */
interface Dossier {
  role: string;
  alive: boolean;
  pack: Seat[];
  peeked: Seat[];
  guarded: Seat[];
}

function arr(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}
function str(x: unknown): string {
  return typeof x === 'string' ? x : '';
}
function seats(x: unknown): Seat[] {
  return arr(x).filter((s): s is string => typeof s === 'string');
}

function ledgerOf(view: ViewObject): Ledger {
  // THE ALLOW-LIST. `transcript` is deliberately absent and must stay absent.
  const { day, phase, alive, dead, claims, reports, edges, vote_history, nights } = view.public as unknown as Record<
    string,
    unknown
  >;
  return {
    day: typeof day === 'number' ? day : 0,
    phase: str(phase),
    alive: seats(alive),
    dead: arr(dead).map((d) => {
      const r = d as Record<string, unknown>;
      return { seat: str(r.seat), role: typeof r.role === 'string' ? r.role : null };
    }),
    claims: arr(claims).map((c) => {
      const r = c as Record<string, unknown>;
      return { speaker: str(r.speaker), role: str(r.role) };
    }),
    reports: arr(reports).map((p) => {
      const r = p as Record<string, unknown>;
      return { speaker: str(r.speaker), target: str(r.target), verdict: str(r.verdict) };
    }),
    edges: arr(edges).map((e) => {
      const r = e as Record<string, unknown>;
      return { from: str(r.from), to: str(r.to), polarity: str(r.polarity) };
    }),
    vote_history: arr(vote_history).map((v) => {
      const r = v as Record<string, unknown>;
      const ballots: Record<Seat, Seat | null> = {};
      if (typeof r.ballots === 'object' && r.ballots !== null) {
        for (const [k, val] of Object.entries(r.ballots as Record<string, unknown>)) {
          ballots[k] = typeof val === 'string' ? val : null;
        }
      }
      return { ballots, lynched: typeof r.lynched === 'string' ? r.lynched : null };
    }),
    nights: arr(nights).map((n) => {
      const r = n as Record<string, unknown>;
      return { died: typeof r.died === 'string' ? r.died : null };
    }),
  };
}

function dossierOf(view: ViewObject): Dossier {
  // THE ALLOW-LIST. `your_notes` (this seat's own prose) is deliberately absent.
  const { your_role, you_alive, pack, your_peeks, your_guards } = view.private as unknown as Record<string, unknown>;
  return {
    role: str(your_role),
    alive: you_alive === true,
    pack: seats(pack),
    peeked: arr(your_peeks).map((k) => str((k as Record<string, unknown>).target)).filter((s) => s.length > 0),
    guarded: arr(your_guards).map((g) => str((g as Record<string, unknown>).target)).filter((s) => s.length > 0),
  };
}

// ---------------------------------------------------------------------------
// Reading the ledger
// ---------------------------------------------------------------------------

/**
 * Suspicion from PUBLIC STRUCTURE ONLY: checks, accusation edges, self-claims
 * and how a seat's past ballots aged against the revealed dead. No prose is
 * consulted, which is the whole point — and the whole limitation.
 *
 * A pack partner scores -Infinity so a wolf can never be steered onto its own
 * side by the ledger; every other branch is role-independent.
 */
function suspicionScores(l: Ledger, me: Seat, pack: readonly Seat[]): Map<Seat, number> {
  const revealed = new Map<Seat, string | null>(l.dead.map((d) => [d.seat, d.role]));
  const seerClaimants = new Set(l.claims.filter((c) => c.role === 'seer').map((c) => c.speaker));
  const scores = new Map<Seat, number>();
  for (const q of l.alive) {
    if (q === me) continue;
    if (pack.includes(q)) {
      scores.set(q, Number.NEGATIVE_INFINITY);
      continue;
    }
    let s = 0;
    for (const r of l.reports) {
      if (r.target !== q) continue;
      s += r.verdict === 'wolf' ? 4 : r.verdict === 'clear' ? -3 : 0;
    }
    for (const e of l.edges) {
      if (e.to !== q) continue;
      s += e.polarity === 'accuse' ? 1 : e.polarity === 'defend' ? -1 : 0;
    }
    for (const c of l.claims) {
      if (c.speaker !== q) continue;
      // Nobody honest claims the wolf role, and two seer claims cannot both be
      // true — the ledger says how many are outstanding, never which one lies.
      if (c.role === 'werewolf') s += 8;
      else if (c.role === 'seer' && seerClaimants.size > 1) s += 3;
    }
    for (const v of l.vote_history) {
      if (v.lynched === null) continue;
      const ballot = v.ballots[q];
      if (ballot === undefined || ballot === null) continue;
      const role = revealed.get(v.lynched) ?? null;
      if (role === null) continue;
      if (ballot === v.lynched) s += role === 'werewolf' ? -2 : 1;
    }
    scores.set(q, s);
  }
  return scores;
}

/**
 * How much this seat matters to the village: the seats a wolf wants dead and a
 * doctor wants alive, read off the same public ledger.
 */
function threatScores(l: Ledger, exclude: readonly Seat[]): Map<Seat, number> {
  const scores = new Map<Seat, number>();
  for (const q of l.alive) {
    if (exclude.includes(q)) continue;
    let s = 0;
    for (const c of l.claims) {
      if (c.speaker !== q) continue;
      if (c.role === 'seer') s += 5;
      else if (c.role === 'doctor') s += 4;
    }
    for (const r of l.reports) if (r.speaker === q) s += 2;
    for (const e of l.edges) if (e.to === q && e.polarity === 'defend') s += 1;
    scores.set(q, s);
  }
  return scores;
}

/**
 * The highest-scoring seat, ties broken by the agent's OWN seed so seven house
 * seats do not vote as one block. Deterministic given (agent_id, game_id).
 */
function argmax(scores: Map<Seat, number>, seed: SeedStream, purpose: string, floor: number): Seat | null {
  let best = Number.NEGATIVE_INFINITY;
  for (const v of scores.values()) if (v > best) best = v;
  if (!Number.isFinite(best) || best < floor) return null;
  const tied = [...scores.entries()].filter(([, v]) => v === best).map(([k]) => k).sort();
  if (tied.length === 0) return null;
  return tied[seed.int(purpose, tied.length)] ?? null;
}

// ---------------------------------------------------------------------------
// legal_moves lookup (engine-authored; indices shift as seats die)
// ---------------------------------------------------------------------------

type MoveFields = { t: string; target?: string; role?: string; verdict?: string };

function fieldsOf(move: Json): MoveFields {
  const m = move as unknown as Record<string, unknown>;
  const out: MoveFields = { t: str(m.t) };
  if (typeof m.target === 'string') out.target = m.target;
  if (typeof m.role === 'string') out.role = m.role;
  if (typeof m.verdict === 'string') out.verdict = m.verdict;
  return out;
}

/** Index of the first legal move matching the predicate, or null. */
function indexOf(view: ViewObject, pred: (m: MoveFields) => boolean): number | null {
  for (const entry of view.legal_moves) {
    if (pred(fieldsOf(entry.move))) return entry.index;
  }
  return null;
}

function targetsOf(view: ViewObject, t: string): Seat[] {
  const out: Seat[] = [];
  for (const entry of view.legal_moves) {
    const f = fieldsOf(entry.move);
    if (f.t === t && f.target !== undefined) out.push(f.target);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The phrase bank
// ---------------------------------------------------------------------------

/**
 * Fixed frames, closed-enum slot fills from ledger facts, seeded pick. Nothing
 * here is copied from another seat's words, and no frame names the speaker's
 * own role — so a wolf can never out itself by speaking, and the utterance is
 * as inert as the ledger it was built from.
 *
 * Frames stay under the 200-char ballot cap so the same bank is safe in every
 * phase; the room caps at view.speech.limit regardless.
 */
const FRAMES = {
  accuse: [
    (t: Seat, n: number) => `I have ${t} at the top of my list: ${n} public marks against them and nothing on the ledger that answers it.`,
    (t: Seat, n: number) => `Voting the ledger, not the speeches. ${t} carries ${n} marks. Say something structural or I stay there.`,
    (t: Seat, n: number) => `${t} is my read. ${n} marks, no check clearing them. Persuade me with a claim, not with tone.`,
    (t: Seat, n: number) => `Nothing has moved ${t} off the top for me: ${n} marks and no counter-evidence on the record.`,
  ],
  defend: [
    (t: Seat) => `I am not on ${t} today. The marks against them are talk, and talk is not the ledger.`,
    (t: Seat) => `Leaving ${t} alone until a check or a vote pattern says otherwise.`,
    (t: Seat) => `${t} has done nothing the record can hold against them. I want a better target.`,
    (t: Seat) => `Pressure on ${t} looks like momentum, not evidence. I am off it.`,
  ],
  report: [
    (t: Seat, v: string) => `Putting it on the record: my check on ${t} came back ${v}. Weigh it against what else you have.`,
    (t: Seat, v: string) => `On the record, ${t} is ${v}. That is a permanent ledger row, not a speech.`,
    (t: Seat, v: string) => `Result on ${t}: ${v}. I would rather be wrong on the record than quiet.`,
    (t: Seat, v: string) => `${t} reads ${v}. Do what you like with it, but it is now permanent.`,
  ],
  say: [
    (a: number, w: number) => `${a} of us left, ${w} wolves among them. I am waiting for a claim or a check; speeches do not move me.`,
    (a: number, _w: number) => `No structural read yet with ${a} alive. I will follow the ledger, not the loudest seat.`,
    (a: number, w: number) => `${w} wolves, ${a} seats. Somebody with information should spend it before the next night.`,
    (a: number, _w: number) => `Holding. Nothing in the record separates the ${a} of us yet. Give me a check to work with.`,
  ],
  hold: [
    () => `No check and no vote pattern points anywhere yet, so I am not casting a vote I cannot defend.`,
    () => `Abstaining. A guess today is a free wolf tomorrow.`,
    () => `Nothing on the record justifies a lynch, so I am not adding one.`,
    () => `I will not vote on atmosphere. Bring me a claim and I will move.`,
  ],
  self: [
    () => `The record does not put me anywhere. I have voted the ledger every day and I will keep doing that.`,
    () => `Nothing structural has been shown against me. Check my ballots against the reveals.`,
    () => `I am the easy vote, not the right one. My votes are on the record; read them.`,
    () => `If I were what you say, my ballots would look different. They are permanent — go and look.`,
  ],
  night: [
    (t: Seat) => `${t} tonight.`,
    (t: Seat) => `Taking ${t}.`,
    (t: Seat) => `${t} is the one that matters.`,
    (t: Seat) => `Going for ${t}.`,
  ],
  rest: [
    () => `Nothing to add tonight.`,
    () => `Sitting still.`,
    () => `Quiet night from me.`,
    () => `No move worth making.`,
  ],
} as const;

function pickFrame<T>(bank: readonly T[], seed: SeedStream, turn: number): T {
  return bank[seed.int(`ww:phrase:${turn}`, bank.length)]!;
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

interface Choice {
  index: number;
  utterance: string;
}

function marksAgainst(l: Ledger, q: Seat): number {
  let n = 0;
  for (const e of l.edges) if (e.to === q && e.polarity === 'accuse') n += 1;
  for (const r of l.reports) if (r.target === q && r.verdict === 'wolf') n += 1;
  return n;
}

function chooseNight(view: ViewObject, l: Ledger, d: Dossier, seed: SeedStream): Choice {
  const turn = view.turn_index;
  if (d.role === 'werewolf') {
    // legal_moves already excludes the pack, so the threat read cannot loop back.
    const options = targetsOf(view, 'kill');
    const threats = threatScores(l, l.alive.filter((q) => !options.includes(q)));
    const target = argmax(threats, seed, `ww:kill:${turn}`, Number.NEGATIVE_INFINITY) ?? options[0] ?? null;
    const index = target === null ? null : indexOf(view, (m) => m.t === 'kill' && m.target === target);
    if (index !== null && target !== null) {
      return { index, utterance: pickFrame(FRAMES.night, seed, turn)(target) };
    }
    return { index: 0, utterance: pickFrame(FRAMES.rest, seed, turn)() };
  }
  if (d.role === 'seer') {
    const options = targetsOf(view, 'peek').filter((q) => !d.peeked.includes(q));
    const scores = suspicionScores(l, view.you.player, d.pack);
    const ranked = new Map([...scores].filter(([q]) => options.includes(q)));
    const target = argmax(ranked, seed, `ww:peek:${turn}`, Number.NEGATIVE_INFINITY) ?? options[0] ?? null;
    const index = target === null ? null : indexOf(view, (m) => m.t === 'peek' && m.target === target);
    if (index !== null) return { index, utterance: pickFrame(FRAMES.rest, seed, turn)() };
    return { index: 0, utterance: pickFrame(FRAMES.rest, seed, turn)() };
  }
  if (d.role === 'doctor') {
    // Guard whoever the village most needs alive; the same-seat-twice rule has
    // already been applied to legal_moves.
    const options = targetsOf(view, 'guard');
    const threats = threatScores(l, l.alive.filter((q) => !options.includes(q)));
    const target =
      argmax(threats, seed, `ww:guard:${turn}`, 1) ??
      (options.includes(view.you.player) ? view.you.player : (options[0] ?? null));
    const index = target === null ? null : indexOf(view, (m) => m.t === 'guard' && m.target === target);
    if (index !== null) return { index, utterance: pickFrame(FRAMES.rest, seed, turn)() };
  }
  // Villager: `sleep` is the only legal move, and it must still be submitted.
  return { index: 0, utterance: pickFrame(FRAMES.rest, seed, turn)() };
}

function chooseTalk(view: ViewObject, l: Ledger, d: Dossier, seed: SeedStream): Choice {
  const me = view.you.player;
  const turn = view.turn_index;

  // A seer spends its checks; a wolf never fabricates one.
  if (d.role === 'seer') {
    const spoken = new Set(l.reports.filter((r) => r.speaker === me).map((r) => r.target));
    for (const entry of view.legal_moves) {
      const f = fieldsOf(entry.move);
      if (f.t !== 'report' || f.target === undefined || f.verdict === undefined) continue;
      if (spoken.has(f.target) || !d.peeked.includes(f.target)) continue;
      // Only ever the verdict this seat actually holds: the peek ledger is
      // private and closed-enum, so a report can never be invented here.
      if (verdictHeld(view, f.target) !== f.verdict) continue;
      return { index: entry.index, utterance: pickFrame(FRAMES.report, seed, turn)(f.target, f.verdict) };
    }
  }

  const scores = suspicionScores(l, me, d.pack);
  const top = argmax(scores, seed, `ww:accuse:${turn}`, 1);
  if (top !== null) {
    const index = indexOf(view, (m) => m.t === 'accuse' && m.target === top);
    if (index !== null) return { index, utterance: pickFrame(FRAMES.accuse, seed, turn)(top, marksAgainst(l, top)) };
  }

  // Under pressure with nothing to point at: answer the record, not the words.
  if (marksAgainst(l, me) > 0) {
    const index = indexOf(view, (m) => m.t === 'defend' && m.target === me);
    if (index !== null) return { index, utterance: pickFrame(FRAMES.self, seed, turn)() };
  }

  const wolves = Math.max(0, 2 - l.dead.filter((x) => x.role === 'werewolf').length);
  return { index: 0, utterance: pickFrame(FRAMES.say, seed, turn)(l.alive.length, wolves) };
}

/**
 * The verdict this seat holds on `target` from its OWN peek ledger. Returns ''
 * when it holds none — a seat that never peeked can never report.
 *
 * Reads `private.your_peeks` through the same allow-listed accessor rather than
 * widening the Dossier shape, because the verdict is the one field of a peek
 * row that must never be inferred from anything public.
 */
function verdictHeld(view: ViewObject, target: Seat): string {
  const { your_peeks } = view.private as unknown as Record<string, unknown>;
  for (const k of arr(your_peeks)) {
    const r = k as Record<string, unknown>;
    if (str(r.target) === target) return str(r.verdict);
  }
  return '';
}

function chooseDefense(view: ViewObject, l: Ledger, seed: SeedStream): Choice {
  const me = view.you.player;
  const index = indexOf(view, (m) => m.t === 'defend' && m.target === me);
  if (index !== null) return { index, utterance: pickFrame(FRAMES.self, seed, view.turn_index)() };
  const wolves = Math.max(0, 2 - l.dead.filter((x) => x.role === 'werewolf').length);
  return { index: 0, utterance: pickFrame(FRAMES.say, seed, view.turn_index)(l.alive.length, wolves) };
}

function chooseVote(view: ViewObject, l: Ledger, d: Dossier, seed: SeedStream): Choice {
  const turn = view.turn_index;
  const scores = suspicionScores(l, view.you.player, d.pack);
  const top = argmax(scores, seed, `ww:vote:${turn}`, 1);
  if (top !== null) {
    const index = indexOf(view, (m) => m.t === 'vote' && m.target === top);
    if (index !== null) return { index, utterance: pickFrame(FRAMES.accuse, seed, turn)(top, marksAgainst(l, top)) };
  }
  // Index 0 is `abstain`. A guess today is a free wolf tomorrow.
  return { index: 0, utterance: pickFrame(FRAMES.hold, seed, turn)() };
}

// ---------------------------------------------------------------------------

/**
 * Seed purposes are per-turn and per-decision (`ww:vote:<turn>` etc.), so a
 * repeat ask on the same turn — after a rejection, or a second driver wake —
 * advances the counter rather than repeating, exactly like random.ts.
 */
export function createWerewolfHouseAgent(
  agentId: string,
  gameId: string,
  tier: WerewolfHouseTier = 'basic',
): HouseAdapter {
  const seed: SeedStream = createSeedStream(sha256Hex(`werewolf-house:${agentId}:${gameId}`));
  return {
    kind: `werewolf-house-${tier}`,
    agentId,
    // eslint-disable-next-line @typescript-eslint/require-await
    async chooseMove(view: ViewObject) {
      if (view.legal_moves.length === 0) {
        throw new Error(`werewolf house agent ${agentId}: view carries no legal moves`);
      }
      // The floor: index 0 is defaultMove in every phase, and silence is a
      // legal move everywhere.
      if (tier === 'silent') return submissionByIndex(view, 0);

      const ledger = ledgerOf(view);
      const dossier = dossierOf(view);
      const choice =
        ledger.phase === 'night'
          ? chooseNight(view, ledger, dossier, seed)
          : ledger.phase === 'day_vote'
            ? chooseVote(view, ledger, dossier, seed)
            : ledger.phase === 'day_defense'
              ? chooseDefense(view, ledger, seed)
              : chooseTalk(view, ledger, dossier, seed);

      // Defensive: a shifted index is a strike, so never ship one the view did
      // not offer. Index 0 always exists and is always legal.
      const index = view.legal_moves.some((e) => e.index === choice.index) ? choice.index : 0;
      return submissionByIndexWithUtterance(view, index, choice.utterance);
    },
  };
}
