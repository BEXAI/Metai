/**
 * Werewolf views and the ASCII dossier.
 *
 * INVARIANT V — the thing everything else in this file follows from:
 * exactly THREE functions here may read a hidden field of WwState —
 * `viewerFile` (the dossier's YOUR FILE block), `privateView`/`privateMessages`,
 * and `viewStateString`. Each takes a viewer and reads only that viewer's own
 * material. `publicOf` reads NO hidden field at all, and `renderText(state,
 * null)` is not written separately: the whole dossier is `publicDossier`, which
 * takes the PROJECTION type and not WwState, plus the viewer's own block.
 *
 * Honest caveat: `Game.publicView` returns `Json`, so the projection is an
 * unchecked cast with no runtime narrowing. `publicDossier` cannot leak beyond
 * what `publicOf` handed it, but `publicOf` is still hand-written — the
 * indistinguishability test is a real test of it, not a formality.
 *
 * WHERE EACH SURFACE LANDS IN AN AGENT'S PROMPT (src/agents/prompt.ts), which
 * is why the rules below are hard rules and not preferences:
 *   rules_card, board_text, state_string, private, legal_moves  OUTSIDE the
 *     untrusted fence, with only stripFenceMarkers applied.
 *   history, private_messages                                   INSIDE it.
 * So: ZERO AGENT-AUTHORED BYTES in the dossier, in viewStateString, or in
 * privateView. The pack's whispers travel in `privateMessages`, which is
 * fenced; the day's prose travels in `history` and in `public.transcript`.
 * Printing the transcript into board_text is the obvious lazy implementation
 * and it is precisely the fence hole.
 *
 * SIZE. The dossier is O(seats x DAY_LIMIT), never O(turns): it is the same
 * size on turn 5 and on turn 160. That matters twice over — it rides in every
 * spectator `move` event (which is persisted whole and re-serialised into one
 * D1 column), and it is what a model actually reads on every turn.
 */

import { canonicalJson, sha256Hex } from '../../crypto/canonical.ts';
import type { Json, PlayerId, PrivateMessage, SpeechChannel } from '../../kernel/types.ts';
import {
  MAX_BALLOT_CHARS,
  MAX_NIGHT_CHARS,
  MAX_SPEECH_CHARS,
  ROLE_MULTISET,
  TALK_ROUNDS,
  countRole,
  type Cause,
  type Phase,
  type Role,
  type Verdict,
} from './board.ts';
import {
  livingSeats,
  playersToMove,
  roleOf,
  wolfSeats,
  type Seat,
  type Utterance,
  type WwState,
} from './rules.ts';

// ---------------------------------------------------------------------------
// The public projection
// ---------------------------------------------------------------------------

export type PublicDead = {
  seat: Seat;
  /**
   * The day the seat died, or null. Night and lynch deaths are dated from the
   * public `nights` / `voteHistory` ledgers; a seat removed by forfeitPlayer
   * has no dated row anywhere in the state, so it reports null. The room's log
   * carries the turn index for those.
   */
  day: number | null;
  cause: Cause;
  role: Role | null;
};

/**
 * FROZEN KEY SET. `Object.keys(publicView(s)).sort()` is pinned by a test in
 * every phase — the cheap catch for a future contributor adding `saved` or
 * `result` back.
 *
 * Three fields that look like leaks and are not:
 *  - `wolves_remaining` / `village_remaining` are derived from the PUBLIC
 *    composition constant minus revealed corpses, and are written that way
 *    below so the derivation is visible. This holds only because EVERY death
 *    path reveals; if one ever stopped revealing, these would start leaking.
 *    On day 1 the wolf count is always 2, i.e. zero information.
 *  - `transcript` is CURRENT DAY ONLY — load-bearing, not an optimisation,
 *    because this object is embedded in every spectator event.
 *  - `result` is EXCLUDED. GameResult.winners is the entire winning team's
 *    roster: it names every villager. The room already publishes the result
 *    through the `end` event.
 *
 * `acted_this_night` / `spoke_this_round` / `voted_this_phase` ship the SET of
 * seats that have acted, never WHAT they did. During collection the room holds
 * submissions unapplied, so the sets are empty; during resolution the room
 * emits a fresh public view after EACH applied ballot, so shipping the ballot
 * MAP would publish a partial tally in the intermediate events.
 */
export type PublicWw = {
  day: number;
  phase: Phase;
  round: number;
  players: Seat[];
  /** Living seats, ascending. The complement is `dead`. */
  alive: Seat[];
  dead: PublicDead[];
  claims: { day: number; seq: number; speaker: Seat; role: Role }[];
  reports: { day: number; seq: number; speaker: Seat; target: Seat; verdict: Verdict }[];
  edges: { day: number; seq: number; from: Seat; to: Seat; polarity: 'accuse' | 'defend' }[];
  vote_history: { day: number; ballots: Record<Seat, Seat | null>; lynched: Seat | null }[];
  /** `died` only. There is deliberately no public save flag. */
  nights: { day: number; died: Seat | null }[];
  defenders: { day: number; seat: Seat }[];
  defender: Seat | null;
  /** CURRENT DAY ONLY. Evicted into archived.digest at dusk. */
  transcript: Utterance[];
  archived: { count: number; digest: string };
  acted_this_night: Seat[];
  spoke_this_round: Seat[];
  voted_this_phase: Seat[];
  pending: Seat[];
  wolves_remaining: number;
  village_remaining: number;
};

/** Death days recoverable from public ledgers alone (see PublicDead.day). */
function deathDays(s: WwState): Record<Seat, number> {
  const out: Record<Seat, number> = {};
  for (const n of s.nights) if (n.died !== null) out[n.died] = n.day;
  for (const v of s.voteHistory) if (v.lynched !== null) out[v.lynched] = v.day;
  return out;
}

/** Reads no hidden field. `revealed` and `cause` are the public death record. */
export function publicOf(s: WwState): PublicWw {
  const days = deathDays(s);
  const dead: PublicDead[] = [];
  for (const p of s.players) {
    if (s.alive[p] === true) continue;
    dead.push({
      seat: p,
      day: days[p] ?? null,
      cause: s.cause[p] ?? 'abandoned',
      role: s.revealed[p] ?? null,
    });
  }
  const deadWolves = dead.filter((d) => d.role === 'werewolf').length;
  return {
    day: s.day,
    phase: s.phase,
    round: s.round,
    players: s.players.slice(),
    alive: livingSeats(s),
    dead,
    claims: s.claims.map((c) => ({ ...c })),
    reports: s.reports.map((r) => ({ ...r })),
    edges: s.edges.map((e) => ({ ...e })),
    vote_history: s.voteHistory.map((v) => ({ ...v, ballots: { ...v.ballots } })),
    nights: s.nights.map((n) => ({ ...n })),
    defenders: s.defenders.map((d) => ({ ...d })),
    defender: s.defender,
    transcript: s.transcript.map((u) => ({ ...u })),
    archived: { count: s.archivedCount, digest: s.archivedDigest },
    acted_this_night: Object.keys(s.nightActs).sort(),
    spoke_this_round: Object.keys(s.said).sort(),
    voted_this_phase: Object.keys(s.ballots).sort(),
    pending: playersToMove(s),
    wolves_remaining: countRole(ROLE_MULTISET, 'werewolf') - deadWolves,
    village_remaining: ROLE_MULTISET.length - countRole(ROLE_MULTISET, 'werewolf') - (dead.length - deadWolves),
  };
}

export function publicView(s: WwState): Json {
  return publicOf(s) as unknown as Json;
}

// ---------------------------------------------------------------------------
// privateView — a DELTA, and that is a hard rule
// ---------------------------------------------------------------------------

/**
 * The room recomputes this for ALL EIGHT SEATS after every applied move and
 * persists one row per seat per turn, so restating the transcript here would
 * cost ~768 KB per game against ~32 KB for a delta. The sharper reason is that
 * `private` renders OUTSIDE the prompt fence: anything in it that another
 * agent wrote is out-of-fence agent text. Hence closed enums only, no
 * transcript, and no pack prose — the pack's WORDS go through
 * `privateMessages`, which is fenced, and only the pack's STRUCTURE is here.
 *
 * UNIFORM KEY SET FOR EVERY ROLE (null, never key-omission) so `role` never
 * changes the JSON shape and a stored row's byte length is less
 * role-correlated.
 *
 * `pack` is a SORTED SEAT ARRAY, never a role map. That is what makes gate A10
 * pass honestly without widening the harness: the canonical role probe is the
 * fragment `"p3":"werewolf"`, which would appear in the PARTNER'S CORRECT VIEW
 * if `pack` were a map, and A10 would fail on correct behaviour.
 *
 * DEAD VIEWERS GET NOTHING EXTRA — no ghost omniscience. A dead wolf's `pack`
 * stays non-null; it already knew.
 */
export function privateView(s: WwState, viewer: PlayerId): Json {
  const role = s.roles[viewer];
  if (role === undefined) {
    // Not a seated player (spectator id, or a stale seat): nothing is private.
    return { you: viewer, your_role: null, you_alive: false } as unknown as Json;
  }
  const isWolf = role === 'werewolf';
  const pack = isWolf ? wolfSeats(s).slice().sort() : null;
  const slot = s.nightActs[viewer];
  return {
    you: viewer,
    your_role: role,
    you_alive: s.alive[viewer] === true,
    pack,
    pack_alive: pack === null ? null : pack.filter((p) => s.alive[p] === true),
    pack_message_count: isWolf ? s.packLog.length : null,
    your_peeks:
      role === 'seer'
        ? s.peeks.filter((k) => k.seer === viewer).map((k) => ({ day: k.day, target: k.target, verdict: k.verdict }))
        : null,
    your_guards:
      role === 'doctor'
        ? s.guards.filter((g) => g.doctor === viewer).map((g) => ({ day: g.day, target: g.target, saved: g.saved }))
        : null,
    // The CURRENT night's slot only; earlier nights live in the ledgers above.
    your_night_acts: slot === undefined ? [] : [{ day: s.day, t: slot.t, target: slot.target }],
    // A wolf's night words are pack traffic and reach it through
    // private_messages instead, so this stays null rather than empty.
    your_notes: isWolf
      ? null
      : s.noteLog.filter((n) => n.who === viewer).map((n) => ({ day: n.day, text: n.text })),
  } as unknown as Json;
}

/**
 * Agent-authored text addressed privately to this viewer. Same trust class as
 * history: the prompt builder renders it INSIDE the untrusted fence.
 *
 * The canonical protocol put the pack channel in `privateView.pack_channel`,
 * arguing that a wolf reading its packmate is reading a teammate. That
 * reasoning is wrong: `private` renders outside the fence, and the two wolves
 * are separate agents with separate keys and separate operators. A hostile
 * operator drawing a wolf seat would otherwise get a direct write into its
 * partner's TRUSTED prompt region, once per night, all game. Sharing a win
 * condition does not make another agent's bytes trusted.
 *
 * `turn` carries the GAME-SCOPED DAY, not the room's turn index: this module
 * is pure and cannot see the room's counter.
 */
export function privateMessages(s: WwState, viewer: PlayerId): PrivateMessage[] {
  if (s.roles[viewer] !== 'werewolf') return [];
  return s.packLog.map((m) => ({ turn: m.day, from: m.from, channel: 'pack', text: m.text }));
}

// ---------------------------------------------------------------------------
// viewStateString
// ---------------------------------------------------------------------------

/**
 * REQUIRED for a hidden-information game: encodeState round-trips the FULL
 * state (every role, every peek, every whisper) for replays and codecs, so
 * buildView must never ship it to a seated player mid-game.
 *
 * Ledgers and DIGESTS, never transcript text — this renders outside the fence.
 * `sha8` hashes already-public text, so it leaks nothing, and it lets an agent
 * confirm that the words it is reading in `history` are the words the engine
 * recorded. The viewer's own note text and pack whispers are deliberately NOT
 * here: the agent gets those in `private` / `private_messages`. One
 * out-of-fence prose surface is the minimum achievable; two would be
 * gratuitous.
 *
 * Built with hand-ordered JSON.stringify rather than canonicalJson so the
 * `you` block reads {seat, role, ...} in that order — which is the exact
 * fragment the A10 role probe is written against. Key order is otherwise
 * irrelevant here: nothing hashes this string.
 */
export function viewStateString(s: WwState, viewer: PlayerId): string {
  const role = s.roles[viewer] ?? null;
  const isWolf = role === 'werewolf';
  const digests = s.transcript.map((u) => ({
    seq: u.seq,
    speaker: u.speaker,
    act: u.act,
    len: u.text.length,
    sha8: sha256Hex(u.text).slice(0, 8),
  }));
  return JSON.stringify({
    day: s.day,
    phase: s.phase,
    round: s.round,
    alive: { ...s.alive },
    revealed: { ...s.revealed }, // dead seats only — every death reveals
    claims: s.claims,
    reports: s.reports,
    edges: s.edges,
    nights: s.nights,
    vote_history: s.voteHistory,
    archived: { count: s.archivedCount, digest: s.archivedDigest },
    transcript_digests: digests,
    you: {
      seat: viewer,
      role,
      pack: isWolf ? wolfSeats(s).slice().sort() : null,
      peeks: role === 'seer' ? s.peeks.filter((k) => k.seer === viewer).map((k) => ({ day: k.day, target: k.target, verdict: k.verdict })) : null,
      guards: role === 'doctor' ? s.guards.filter((g) => g.doctor === viewer).map((g) => ({ day: g.day, target: g.target, saved: g.saved })) : null,
    },
  });
}

// ---------------------------------------------------------------------------
// speechInfo
// ---------------------------------------------------------------------------

/**
 * Per-phase speech descriptor. Without it a wolf cannot tell whether its night
 * words are a private coordination channel or a public confession, and the
 * failure mode is a wolf that outs itself on night 1 — which reads as model
 * weakness when it is actually a protocol-legibility bug.
 *
 * There is deliberately no `open` flag: an always-true boolean in a
 * security-adjacent descriptor invites clients to trust it.
 */
export function speechInfo(s: WwState, viewer: PlayerId): SpeechChannel {
  const maxLimit = MAX_SPEECH_CHARS;
  switch (s.phase) {
    case 'night':
      return s.roles[viewer] === 'werewolf'
        ? {
            limit: MAX_NIGHT_CHARS,
            maxLimit,
            audience: 'pack',
            note: 'Your night text reaches your werewolf partner only, and everyone after the game ends.',
          }
        : {
            limit: MAX_NIGHT_CHARS,
            maxLimit,
            audience: 'self',
            note: 'Your night note reaches nobody until the game ends. It is recorded in your own private log.',
          };
    case 'day_talk':
    case 'day_defense':
      return { limit: MAX_SPEECH_CHARS, maxLimit, audience: 'village', note: 'Every living seat reads this, live.' };
    case 'day_vote':
      return {
        limit: MAX_BALLOT_CHARS,
        maxLimit,
        audience: 'village',
        note: 'Revealed together with every other ballot.',
      };
    case 'over':
      return { limit: 0, maxLimit, audience: 'village', note: 'The game has ended; no further speech is accepted.' };
  }
}

// ---------------------------------------------------------------------------
// The dossier (board_text)
// ---------------------------------------------------------------------------

const WRAP = 96;
const ROLE_COL = 8; // 'WEREWOLF'
const UNKNOWN_ROLE = '--------';

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** Joins `items` with `sep`, wrapping onto continuation lines at `indent`. */
function wrapJoin(items: string[], sep: string, indent: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const item of items) {
    const next = cur === '' ? item : cur + sep + item;
    if (cur !== '' && indent.length + next.length > width) {
      out.push(indent + cur);
      cur = item;
    } else {
      cur = next;
    }
  }
  if (cur !== '') out.push(indent + cur);
  return out;
}

function phaseHeadline(pub: PublicWw): string {
  switch (pub.phase) {
    case 'night':
      return `phase night ${pub.day}`;
    case 'day_talk':
      return `phase day_talk (talk round ${pub.round + 1} of ${TALK_ROUNDS})`;
    case 'day_defense':
      return `phase day_defense (${pub.defender ?? '-'} answers)`;
    case 'day_vote':
      return 'phase day_vote';
    case 'over':
      return 'phase over';
  }
}

function distinctClaims(pub: PublicWw): Record<Seat, Role[]> {
  const out: Record<Seat, Role[]> = {};
  for (const c of pub.claims) {
    const list = out[c.speaker] ?? [];
    if (!list.includes(c.role)) list.push(c.role);
    out[c.speaker] = list;
  }
  return out;
}

/** `n3 taken by the wolves` / `d2 lynched` / `abandoned (three strikes or clock)`. */
function deathLabel(d: PublicDead): string {
  if (d.cause === 'wolves') return `${d.day === null ? '' : `n${d.day} `}taken by the wolves`;
  if (d.cause === 'lynch') return `${d.day === null ? '' : `d${d.day} `}lynched`;
  return 'abandoned (three strikes or clock)';
}

function rosterSection(pub: PublicWw, viewer: Seat | null): string[] {
  const lines = ['ROSTER   (the role column is public knowledge only: a seat that has died)'];
  const claims = distinctClaims(pub);
  const deadBySeat: Record<Seat, PublicDead> = {};
  for (const d of pub.dead) deadBySeat[d.seat] = d;
  for (const p of pub.players) {
    const dead = deadBySeat[p];
    const you = p === viewer ? '  <- YOU' : '';
    if (dead !== undefined) {
      const role = dead.role === null ? UNKNOWN_ROLE : dead.role.toUpperCase();
      lines.push(`  ${p} ${pad(role, ROLE_COL)}  dead   ${deathLabel(dead)}${you}`);
      continue;
    }
    const claimed = claims[p];
    const claimTxt = claimed === undefined || claimed.length === 0 ? '-' : claimed.join(',');
    const by = pub.edges
      .filter((e) => e.day === pub.day && e.polarity === 'accuse' && e.to === p)
      .map((e) => e.from);
    const accused = by.length === 0 ? '-' : Array.from(new Set(by)).join(',');
    lines.push(
      `  ${p} ${UNKNOWN_ROLE}  alive  ${pad(`claim:${claimTxt}`, 22)} accused-today:${accused}${you}`,
    );
  }
  return lines;
}

function claimsSection(pub: PublicWw): string[] {
  // "N seats claim seer" is a COUNT, a FACT. It is never "one of p1 and p4 is
  // lying" — the agent draws that, and drawing it is the game.
  const living = new Set(pub.alive);
  const contested: string[] = [];
  for (const role of ['werewolf', 'seer', 'doctor', 'villager'] as const) {
    const seats = new Set(pub.claims.filter((c) => c.role === role && living.has(c.speaker)).map((c) => c.speaker));
    if (seats.size >= 2) contested.push(`${seats.size} living seats claim ${role}`);
  }
  const head =
    contested.length === 0
      ? 'CLAIMS & CHECKS   (permanent record; no role is claimed by two living seats)'
      : `CLAIMS & CHECKS   (permanent record; ${contested.join(', ')})`;
  const lines = [head];
  const acts: Record<Seat, { seq: number; text: string }[]> = {};
  for (const c of pub.claims) {
    (acts[c.speaker] ??= []).push({ seq: c.seq, text: `d${c.day} claims ${c.role}` });
  }
  for (const r of pub.reports) {
    (acts[r.speaker] ??= []).push({ seq: r.seq, text: `d${r.day} reports ${r.target}=${r.verdict}` });
  }
  let any = false;
  for (const p of pub.players) {
    const rows = acts[p];
    if (rows === undefined || rows.length === 0) continue;
    any = true;
    rows.sort((a, b) => a.seq - b.seq);
    const wrapped = wrapJoin(rows.map((x) => x.text), ' | ', '      ', WRAP);
    lines.push(`  ${p}${wrapped[0]!.slice(3)}`);
    for (const extra of wrapped.slice(1)) lines.push(extra);
  }
  if (!any) lines.push('  (nobody has claimed a role or reported a check yet)');
  return lines;
}

function accusationsSection(pub: PublicWw): string[] {
  const lines = ['ACCUSATIONS   (-> accuse, ~ defend)'];
  const today = pub.edges
    .filter((e) => e.day === pub.day)
    .sort((a, b) => a.seq - b.seq)
    .map((e) => `${e.from}${e.polarity === 'accuse' ? '->' : '~'}${e.to}`);
  if (today.length === 0) {
    lines.push('  today: (nothing said yet today)');
  } else {
    const wrapped = wrapJoin(today, ' ', '         ', WRAP);
    lines.push(`  today: ${wrapped[0]!.trimStart()}`);
    for (const extra of wrapped.slice(1)) lines.push(extra);
  }

  const totals: Record<string, number> = {};
  for (const e of pub.edges) {
    const key = `${e.from}${e.polarity === 'accuse' ? '->' : '~'}${e.to}`;
    totals[key] = (totals[key] ?? 0) + 1;
  }
  const keys = Object.keys(totals).sort();
  if (keys.length === 0) return lines;
  const items = keys.map((k) => `${k} x${totals[k]}`);
  const wrapped = wrapJoin(items, ' | ', '          ', WRAP);
  lines.push(`  totals: ${wrapped[0]!.trimStart()}`);
  for (const extra of wrapped.slice(1)) lines.push(extra);
  return lines;
}

function votesSection(pub: PublicWw): string[] {
  const lines = ['VOTES'];
  for (const v of pub.vote_history) {
    const tally: Record<Seat, Seat[]> = {};
    const abstained: Seat[] = [];
    for (const voter of Object.keys(v.ballots).sort()) {
      const target = v.ballots[voter] ?? null;
      if (target === null) abstained.push(voter);
      else (tally[target] ??= []).push(voter);
    }
    const parts = Object.keys(tally)
      .sort((a, b) => (tally[b]!.length - tally[a]!.length) || (a < b ? -1 : 1))
      .map((t) => `${t} x${tally[t]!.length} (${tally[t]!.join(',')})`);
    if (abstained.length > 0) parts.push(`abstain x${abstained.length} (${abstained.join(',')})`);
    const dead = pub.dead.find((d) => d.seat === v.lynched);
    const outcome =
      v.lynched === null
        ? '-> no lynch'
        : `-> ${v.lynched} lynched${dead?.role ? ` (${dead.role})` : ''}`;
    lines.push(`  d${v.day}  ${parts.join(' | ')}  ${outcome}`);
  }
  if (pub.phase !== 'over' && !pub.vote_history.some((v) => v.day === pub.day)) {
    lines.push(`  d${pub.day}  (today's ballot has not been counted yet)`);
  }
  return lines;
}

function nightsSection(pub: PublicWw): string[] {
  // `died` ONLY. Announcing a doctor save would hand the village a free bit —
  // that a doctor exists, is alive, and guessed right — and would turn the
  // pack's `stay_in` from a bluff into a tell.
  const items = pub.nights.map((n) => {
    if (n.died === null) return `n${n.day} nobody died`;
    const dead = pub.dead.find((d) => d.seat === n.died);
    return `n${n.day} ${n.died} died${dead?.role ? ` (${dead.role})` : ''}`;
  });
  if (items.length === 0) return ['NIGHTS', '  (no night has resolved yet)'];
  return ['NIGHTS', ...wrapJoin(items, ' | ', '  ', WRAP)];
}

/**
 * There is deliberately NO "TIMED OUT" column, and it must not be re-added: it
 * is not computable from pure state. The room forces `defaultMove` on a
 * timeout, which is `say` with text '' — byte-identical to a strategic
 * silence. The distinction lives where the information actually exists, in the
 * room's `timeout` and `strike` spectator events and in the replay, which is
 * where /watch reads it.
 *
 * The silence line is DAY-PHASE ONLY. Printing an "empty note" marker at night
 * would expose whether a seat attached text to its night action.
 */
function activitySection(pub: PublicWw): string[] {
  if (pub.phase === 'over') return [];
  const pending = pub.pending.length === 0 ? '-' : pub.pending.join(' ');
  if (pub.phase === 'night') {
    const acted = pub.acted_this_night.length === 0 ? '-' : pub.acted_this_night.join(' ');
    return [`  acted tonight: ${acted}  |  still to act: ${pending}`];
  }
  const submitted = pub.phase === 'day_vote' ? pub.voted_this_phase : pub.spoke_this_round;
  // Wordless = has taken at least one day act today and attached words to none
  // of them. Computed from the public transcript, so it is a fact every seat
  // can check for itself.
  const spoke = new Set<Seat>();
  const withWords = new Set<Seat>();
  for (const u of pub.transcript) {
    if (u.act === 'ballot') continue;
    spoke.add(u.speaker);
    if (u.text !== '') withWords.add(u.speaker);
  }
  const silent = pub.alive.filter((p) => spoke.has(p) && !withWords.has(p));
  return [
    `  submitted this phase: ${submitted.length === 0 ? '-' : submitted.join(' ')}  |  ` +
      `wordless so far today: ${silent.length === 0 ? '-' : silent.join(' ')}  |  ` +
      `still to act: ${pending}`,
  ];
}

function nowSection(pub: PublicWw, viewer: Seat | null): string[] {
  const yours = viewer !== null && pub.pending.includes(viewer);
  const turn = yours ? ' IT IS YOUR MOVE.' : '';
  switch (pub.phase) {
    case 'night':
      return [
        `NOW: night ${pub.day}.${turn} Every living seat acts, on one shared deadline. Index 0 is`,
        "the null act (a wolf declines the kill; everyone else sleeps). Every seat's night",
        'notation is the single token "night", so nobody can read your action off the history;',
        `your target is in your own legal_moves summary. Night words: up to ${MAX_NIGHT_CHARS} chars.`,
      ];
    case 'day_talk':
      return [
        `NOW: day_talk round ${pub.round + 1} of ${TALK_ROUNDS}.${turn} say / accuse(seat) / defend(seat) /`,
        'claim(role) / report(seat,verdict). Index 0 is SILENCE. Every living seat speaks at',
        `once, so you cannot reply until the next round. Words up to ${MAX_SPEECH_CHARS} chars ride with`,
        'the move and every seat reads them; only claim/report/accuse/defend survive dusk.',
      ];
    case 'day_defense':
      return [
        `NOW: day_defense.${turn} ${pub.defender ?? '-'} alone answers the accusations, then the`,
        `ballot opens. Same acts as discussion; words up to ${MAX_SPEECH_CHARS} chars.`,
      ];
    case 'day_vote':
      return [
        `NOW: day_vote.${turn} vote(seat) or abstain. Index 0 is ABSTAIN. A self-vote is legal.`,
        'Strict plurality lynches and ANY TIE IS NO LYNCH; abstentions are not counted in the',
        `tally. Every ballot is revealed together. Words up to ${MAX_BALLOT_CHARS} chars.`,
      ];
    case 'over':
      return ['NOW: the game is over. No further moves are accepted.'];
  }
}

/** Reads ONLY the projection and the viewer's seat id (a public fact). */
export function publicDossier(pub: PublicWw, viewer: Seat | null): string[] {
  const seats = pub.players.length;
  const lines: string[] = [
    `WEREWOLF  day ${pub.day}  ${phaseHeadline(pub)}  |  ${seats} seats, ${pub.alive.length} alive  |  ` +
      `wolves left ${pub.wolves_remaining}, village left ${pub.village_remaining}`,
    viewer !== null && pub.players.includes(viewer)
      ? `You are ${viewer} (seat ${viewer.slice(1)}).`
      : 'Spectator view.',
    '',
    ...rosterSection(pub, viewer),
    '',
    ...claimsSection(pub),
    '',
    ...accusationsSection(pub),
    '',
    ...votesSection(pub),
    '',
    ...nightsSection(pub),
  ];
  const activity = activitySection(pub);
  if (activity.length > 0) lines.push('', ...activity);
  return lines;
}

/**
 * The ONLY hidden reader in the dossier. Counts, never prose: the viewer's own
 * note text and its pack's whispers are agent-authored bytes and reach the
 * agent through `private` and the fenced `private_messages` instead.
 *
 * A wolf's partners are printed as BARE SEATS. Printing the partner's role
 * would put `p5 WEREWOLF` into p2's board_text, which is exactly the dossier
 * row shape gate A10 probes — and it would fire on the partner's CORRECT view,
 * because the harness has no notion of a legitimately shared secret.
 */
function viewerFile(s: WwState, viewer: Seat): string[] {
  const role = roleOf(s, viewer);
  const lines = ['YOUR FILE   (no other seat can read this block)', `  ${viewer} ${role.toUpperCase()}`];

  if (role === 'werewolf') {
    const pack = wolfSeats(s).slice().sort();
    lines.push(`  pack: ${pack.join(' ')} (bare seats; their roles are never printed here)`);
    const kills = s.kills.map((k) => `n${k.day} ${k.target} ${k.died ? 'died' : 'survived'}`);
    lines.push(`  pack kills: ${kills.length === 0 ? '-' : kills.join(' | ')}`);
    lines.push(`  pack messages: ${s.packLog.length} (text in view.private_messages, inside the fence)`);
  } else {
    lines.push('  pack: - (you are not a werewolf)');
  }

  if (role === 'seer') {
    const checks = s.peeks.filter((k) => k.seer === viewer).map((k) => `n${k.day} ${k.target}=${k.verdict}`);
    lines.push(`  your checks: ${checks.length === 0 ? '-' : checks.join(' | ')}`);
  }
  if (role === 'doctor') {
    const guards = s.guards
      .filter((g) => g.doctor === viewer)
      .map((g) => `n${g.day} ${g.target}${g.saved ? ' (SAVED a life)' : ''}`);
    lines.push(`  your guards: ${guards.length === 0 ? '-' : guards.join(' | ')}`);
    lines.push('  you may not guard the same seat two nights running.');
  }

  const slot = s.nightActs[viewer];
  if (slot !== undefined) {
    lines.push(`  tonight you have already chosen: ${slot.t}${slot.target === null ? '' : ` ${slot.target}`}`);
  }
  if (role !== 'werewolf') {
    const notes = s.noteLog.filter((n) => n.who === viewer).length;
    lines.push(`  your night notes: ${notes} recorded (text in view.private.your_notes)`);
  }
  return lines;
}

/**
 * board_text. viewer null renders the spectator dossier, which is byte-identical
 * to a seated render minus YOUR FILE and with 'Spectator view.' in place of the
 * seat line. It is called by the room's public state summary and stuffed into
 * every spectator `move` event, which is a second independent reason it must
 * not grow with the transcript.
 */
export function renderText(s: WwState, viewer: PlayerId | null): string {
  const pub = publicOf(s);
  const seated = viewer !== null && s.players.includes(viewer);
  const lines = publicDossier(pub, seated ? viewer : null);
  if (seated) lines.push('', ...viewerFile(s, viewer));
  lines.push('', ...nowSection(pub, seated ? viewer : null));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

export function encodeState(s: WwState): string {
  return canonicalJson(s as unknown as Json);
}

export function decodeState(encoded: string): WwState {
  const parsed: unknown = JSON.parse(encoded);
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as WwState).players)) {
    throw new Error('werewolf: invalid encoded state');
  }
  return parsed as WwState;
}
