// #/werewolf/:id — the Werewolf transcript theater.
//
// Werewolf is the one game in the hall where the WORDS ARE THE MOVES, so the
// spectator artifact is not a board: it is the transcript. This page is a
// beat-indexed replay machine that happens to run live — every derived row
// carries the beat at which it arrived, so "the table now", "the table at
// beat 41" and "the table with roles revealed" are three filters over one
// structure rather than three code paths.
//
// Where the data comes from (verified against the tree, not guessed):
//  - GET /api/games/:id                       -> the row + seats
//  - GET /api/games/:id/events?since=N        -> the spectator backlog
//  - 'move'/'timeout' event data               -> { turn_index, player, public,
//      board_text, notation, forced? }  (src/rooms/core.ts)
//  - 'game:<type>' event data                  -> { turn_index, player, data },
//      i.e. the game module's own payload is nested ONE LEVEL DEEPER
//      (src/rooms/core.ts#emitGameEvents). Vocabulary for werewolf:
//      speech / phase / dawn / defense / ballots / lynch / seat_lost
//      (src/games/werewolf/rules.ts).
//  - post-'end' 'reveal' event                 -> { roles, ... } via
//      Game.revealOnEnd (src/games/werewolf/rules.ts#revealOnEnd)
//  - GET /api/games/:id/replay                 -> initial_state.roles and the
//      PRIVATE night GameEvents in log[].payload.events. 409s until the game
//      has ended, which is what makes the seal a real seal.
//
// HONESTY RULES THIS FILE ENFORCES
//  1. The truth overlay is not merely hidden while a game is live — it is not
//     BUILT. No role, no whisper, no sealed row, no veracity class exists in
//     the DOM until a reveal is in hand. The button stays visible but
//     DISABLED so a human can see the seal is a real thing being held.
//  2. Scrubbing back must not reveal the ending. Every appended node carries a
//     data-beat; the scrub pass fails CLOSED on a node whose beat is not a
//     finite number (NaN < lo and NaN > hi are both false, which is exactly
//     how a naive pass leaks "p5 lynched — WEREWOLF" while scrubbed to beat 5).
//  3. A TIMEOUT IS NOT A SILENCE. defaultMove produces { t:'say', text:'' } on
//     a clock expiry, which renders identically to a deliberate silence unless
//     we join the 'forced' flag onto the utterance. "Who stayed quiet on day
//     2" is primary evidence in a deduction game.
//  4. Agent-authored text is DATA. It reaches the DOM only through
//     dom.js#text / #inertParagraph — never as markup, never linkified.

import { el, text, clear, inertParagraph } from '../dom.js';
import { getGame, getGameEventsSince, getReplay, subscribeGameEvents } from '../api.js';
import { displayHandle } from '../shapes.js';

const MAX_DRAIN_PAGES = 40; // ~20k events; a full game is ~700-1200
const PAGE_SIZE = 500; // src/api/handlers.ts#EVENTS_PAGE_LIMIT
const REVEAL_RETRIES = 3; // bounded: the replay is written moments after 'end'
const REVEAL_RETRY_MS = 4000;

const SEALED_COPY =
  '\u{1F512} roles, night actions and the wolves’ private channel are sealed until this game ends — then the replay reveals every word';

/** 'p3' -> 3. Seat ids are seat ids; CSS families are numeric. Never mix them. */
export function seatIdx(seat) {
  const n = Number(String(seat === null || seat === undefined ? '' : seat).slice(1));
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// The pure model — no DOM, no fetch, no timers.
// ---------------------------------------------------------------------------

export function createModel() {
  return {
    beat: 0,
    ord: 0,
    backfilled: false,
    /** Ordered display rows: dividers, utterances, ballot cards, sealed rows. */
    rows: [],
    seenSeq: new Set(),
    /** `${turn_index}|${player}` -> beat of the public move event (truth join). */
    moveBeats: new Map(),
    /** `${seat}|${day}|${slot}|${round}` -> { kind, strikeCount } pending join. */
    forced: new Map(),
    /** seat -> the forced record still waiting for its strike count. */
    forcedBySeat: new Map(),
    phase: null,
    day: 0,
    round: 0,
    /** The last phase divider actually emitted, so snapshots and game:phase
     *  events (which carry the SAME transition) cannot double- or zero-print. */
    lastDividerKey: null,
    alive: [],
    dead: [],
    pending: [],
    wolvesRemaining: null,
    villageRemaining: null,
    ended: false,
    result: null,
    /** Stays null until a post-'end' reveal (or a 200 replay) hands it over. */
    roles: null,
  };
}

/** The transcript slot a phase drains into; -1 rounds are defence and ballot. */
function slotOfPhase(phase) {
  if (phase === 'day_defense') return 'day_defense';
  if (phase === 'day_vote') return 'day_vote';
  if (phase === 'day_talk') return 'day_talk';
  return null; // night: nothing is drained into the public transcript
}

function slotOfAct(act) {
  if (act === 'defense') return 'day_defense';
  if (act === 'ballot') return 'day_vote';
  return 'day_talk';
}

function forcedKey(seat, day, slot, round) {
  return `${seat}|${day}|${slot}|${round}`;
}

/**
 * Inserts a row in (beat, seq, ord) order. Backfilled snapshot rows carry
 * beat 0 and an early seq, so they land ahead of everything folded live
 * instead of pretending the whole history just happened at the arrival beat.
 */
function rowSeqRank(r) {
  // Dividers and ballot cards have no seq; they belong at the END of their
  // beat, after the utterances that beat delivered.
  return typeof r.seq === 'number' ? r.seq : Number.MAX_SAFE_INTEGER;
}

function cmpRows(a, b) {
  return a.beat - b.beat || rowSeqRank(a) - rowSeqRank(b) || a.ord - b.ord;
}

function insertRow(m, row) {
  row.ord = m.ord++;
  if (!row.id) row.id = `x${row.ord}`;
  let i = m.rows.length;
  while (i > 0 && cmpRows(m.rows[i - 1], row) > 0) i--;
  m.rows.splice(i, 0, row);
  return row;
}

function pushUtterance(m, r) {
  if (typeof r.seq === 'number') {
    if (m.seenSeq.has(r.seq)) return null;
    m.seenSeq.add(r.seq);
  }
  const slot = slotOfAct(r.act);
  const key = forcedKey(r.speaker, r.day, slot, r.round);
  const hit = m.forced.get(key);
  if (hit) {
    m.forced.delete(key);
    r.forced = hit.kind;
    r.strikeCount = hit.strikeCount ?? null;
  } else {
    r.forced = r.forced ?? null;
    r.strikeCount = r.strikeCount ?? null;
  }
  r.kind = 'utt';
  if (typeof r.seq === 'number') r.id = `u${r.seq}`;
  return insertRow(m, r);
}

function pushDivider(m, beat, tone, label, day) {
  return insertRow(m, { kind: 'divider', beat, tone, label, day });
}

/**
 * Emits a phase divider at most once per transition. Both channels carry the
 * same transition — the publicView snapshot riding on every move event and the
 * explicit `game:phase` event — so this keys on the transition itself rather
 * than on "did m.phase change", which the snapshot has usually already moved.
 */
function notePhase(m, beat) {
  if (!m.phase || m.phase === 'over') return;
  const key = `${m.day}|${m.phase}|${m.phase === 'day_talk' ? m.round : 0}`;
  if (m.lastDividerKey === key) return;
  m.lastDividerKey = key;
  pushDivider(m, beat, toneOfPhase(m.phase), phaseLabel(m.phase, m.day, m.round), m.day);
}

/**
 * A row whose seq precedes everything folded live is BACKFILL: pin it to beat
 * 0 and flag the model rather than stamping the whole history with the
 * arrival beat, which would make the timeline report "nothing happened" for
 * every earlier beat and "everything at once" at one.
 */
function beatForSeq(m, seq, arrivalBeat) {
  if (typeof seq !== 'number') return arrivalBeat;
  const firstLive = m.rows.find((r) => r.kind === 'utt' && typeof r.seq === 'number');
  if (firstLive && seq < firstLive.seq) {
    m.backfilled = true;
    return 0;
  }
  return arrivalBeat;
}

/** Folds the publicView snapshot that rides on every move/timeout event. */
function absorbPublic(m, pub, arrivalBeat) {
  if (typeof pub.phase === 'string') m.phase = pub.phase;
  if (typeof pub.day === 'number') m.day = pub.day;
  if (typeof pub.round === 'number') m.round = pub.round;
  if (Array.isArray(pub.alive)) m.alive = pub.alive.slice();
  if (Array.isArray(pub.dead)) m.dead = pub.dead.map((d) => ({ ...d }));
  if (Array.isArray(pub.pending)) m.pending = pub.pending.slice();
  if (typeof pub.wolves_remaining === 'number') m.wolvesRemaining = pub.wolves_remaining;
  if (typeof pub.village_remaining === 'number') m.villageRemaining = pub.village_remaining;
  notePhase(m, arrivalBeat);
  // publicView.transcript is CURRENT DAY ONLY. It is both the degradation path
  // (game:speech absent or evicted before we joined) and, in a normal room,
  // the FIRST channel to carry a round: the last seat of a round settles it
  // inside its own apply(), so its move snapshot already holds all N drained
  // utterances, and the per-speaker game:speech events follow immediately
  // after and dedupe away on `seq`.
  //
  // That means a discussion round lands on ONE beat rather than N, and that is
  // the honest rendering, not a lost feature: the room holds every simultaneous
  // submission unapplied and publishes the whole round atomically, so a
  // spectator genuinely could not have known utterance 3 before utterance 4.
  // Spreading them over N beats would be a fiction of gradual reveal.
  for (const u of Array.isArray(pub.transcript) ? pub.transcript : []) {
    pushUtterance(m, {
      beat: beatForSeq(m, u.seq, arrivalBeat),
      seq: u.seq,
      day: u.day,
      round: u.round,
      speaker: u.speaker,
      act: u.act,
      target: u.target ?? null,
      role: u.role ?? null,
      verdict: u.verdict ?? null,
      value: typeof u.text === 'string' ? u.text : '',
    });
  }
}

/**
 * Folds one normalized spectator event into the model and returns its beat.
 * Every branch is total: an unknown type still consumes a beat so beats stay
 * a dense index over the event stream.
 */
export function foldEvent(m, ev) {
  const beat = ++m.beat;
  const d = (ev && ev.data) || {};
  switch (ev.type) {
    case 'start':
    case 'move':
    case 'timeout': {
      // Stamp the forced flag with the phase that was current BEFORE this move
      // resolved: the last seat of a round settles the phase inside its own
      // apply(), so the post-move round is already the next one.
      const prevDay = m.day;
      const prevRound = m.round;
      const prevSlot = slotOfPhase(m.phase);
      if (typeof d.turn_index === 'number' && typeof d.player === 'string') {
        m.moveBeats.set(`${d.turn_index}|${d.player}`, beat);
      }
      const kind = ev.type === 'timeout' || d.forced === 'timeout' ? 'timeout' : d.forced === 'illegal' ? 'illegal' : null;
      if (kind !== null && prevSlot !== null && typeof d.player === 'string') {
        const round = prevSlot === 'day_talk' ? prevRound : -1;
        const rec = { kind, strikeCount: null };
        m.forced.set(forcedKey(d.player, prevDay, prevSlot, round), rec);
        m.forcedBySeat.set(d.player, rec);
      }
      if (d.public && typeof d.public === 'object') absorbPublic(m, d.public, beat);
      break;
    }
    case 'strike': {
      // The room emits the strike right AFTER that seat's move events. For
      // every seat but the last of a round that is before the drain, so the
      // count reaches the row. The LAST seat drains inside its own apply(),
      // so its row is built one event too early and reads a bare
      // "no answer" — less information, never wrong information.
      const rec = m.forcedBySeat.get(d.player);
      if (rec && typeof d.strike_count === 'number') rec.strikeCount = d.strike_count;
      break;
    }
    case 'game:speech': {
      const p = d.data || {};
      pushUtterance(m, {
        beat,
        seq: p.seq,
        day: p.day,
        round: p.round,
        speaker: p.speaker ?? d.player,
        act: p.act,
        target: p.target ?? null,
        role: p.role ?? null,
        verdict: p.verdict ?? null,
        value: typeof p.text === 'string' ? p.text : '',
      });
      break;
    }
    case 'game:phase': {
      const p = d.data || {};
      m.phase = p.phase ?? m.phase;
      m.day = typeof p.day === 'number' ? p.day : m.day;
      m.round = typeof p.round === 'number' ? p.round : m.round;
      m.pending = Array.isArray(p.pending) ? p.pending.slice() : m.pending;
      notePhase(m, beat);
      break;
    }
    case 'game:dawn': {
      const p = d.data || {};
      pushDivider(
        m,
        beat,
        'dawn',
        p.died
          ? `☀ DAWN — ${p.died} found dead. They were a ${String(p.role ?? 'unknown').toUpperCase()}.`
          : '☀ DAWN — nobody died in the night.',
        p.day,
      );
      break;
    }
    case 'game:defense': {
      const p = d.data || {};
      pushDivider(m, beat, 'defense', `⚑ ${p.seat} goes to a defence — ${p.accusations} accusation(s) today`, p.day);
      break;
    }
    case 'game:ballots': {
      const p = d.data || {};
      insertRow(m, { kind: 'ballot', beat, day: p.day, ballots: p.ballots || {} });
      break;
    }
    case 'game:lynch': {
      const p = d.data || {};
      pushDivider(m, beat, 'lynch', lynchLabel(p), p.day);
      break;
    }
    case 'game:seat_lost': {
      const p = d.data || {};
      pushDivider(m, beat, 'lost', `✕ ${p.seat} abandoned the table — ${String(p.role ?? 'unknown').toUpperCase()}`, p.day);
      break;
    }
    case 'forfeit':
      pushDivider(m, beat, 'lost', `✕ ${d.player} forfeits (${d.reason ?? 'unknown'})`, m.day);
      break;
    case 'end':
      m.ended = true;
      m.result = d.result ?? null;
      m.phase = 'over';
      pushDivider(m, beat, 'over', '■ THE GAME IS OVER', m.day);
      break;
    case 'reveal':
      // revealOnEnd merges the role map into the post-'end' reveal event. This
      // is the ONLY live source of roles, and it exists only after 'end'.
      if (d.roles && typeof d.roles === 'object') m.roles = { ...d.roles };
      break;
    default:
      break;
  }
  return beat;
}

/** The set of rows visible at beat k. Used by the scrub tests and the ribbon. */
export function atBeat(m, k) {
  return m.rows.filter((r) => Number.isFinite(r.beat) && r.beat <= k);
}

function toneOfPhase(phase) {
  if (phase === 'night') return 'night';
  if (phase === 'day_vote') return 'vote';
  if (phase === 'day_defense') return 'defense';
  if (phase === 'over') return 'over';
  return 'day';
}

function phaseLabel(phase, day, round) {
  switch (phase) {
    case 'night':
      return `☾ NIGHT ${day}`;
    case 'day_talk':
      return `☀ DAY ${day} — DISCUSSION (round ${Number(round ?? 0) + 1})`;
    case 'day_defense':
      return `⚑ DAY ${day} — DEFENCE`;
    case 'day_vote':
      return `⚖ DAY ${day} — VOTE`;
    default:
      return `DAY ${day} — ${String(phase ?? '').toUpperCase()}`;
  }
}

/** STRICT PLURALITY. Any tie is NO LYNCH — say so, never imply a runoff. */
function lynchLabel(p) {
  if (p.seat) return `⛓ ${p.seat} lynched by strict plurality — ${String(p.role ?? 'unknown').toUpperCase()}`;
  if (p.reason === 'tie') return '⛓ TIE — no lynch (a tie is always no lynch)';
  if (p.reason === 'no_votes') return '⛓ no votes cast — no lynch';
  return '⛓ no lynch';
}

/** Public, arithmetic-only tally of one ballot map. */
export function tallyOf(ballots) {
  const tally = new Map();
  let abstains = 0;
  for (const key of Object.keys(ballots || {})) {
    const target = ballots[key];
    if (target === null || target === undefined) abstains++;
    else tally.set(target, (tally.get(target) || 0) + 1);
  }
  const rows = [...tally.entries()].sort((a, b) => b[1] - a[1] || seatIdx(a[0]) - seatIdx(b[0]));
  const top = rows.length > 0 ? rows[0][1] : 0;
  const leaders = rows.filter((r) => r[1] === top).map((r) => r[0]);
  const outcome = top === 0 ? 'no_votes' : leaders.length > 1 ? 'tie' : 'plurality';
  return { rows, abstains, outcome, lynched: outcome === 'plurality' ? leaders[0] : null };
}

// ---------------------------------------------------------------------------
// The truth join — pure, and reachable only with a reveal in hand.
// ---------------------------------------------------------------------------

const SEALED_KINDS = new Set(['pack_whisper', 'night_note', 'kill_intent', 'peek_result', 'guard_choice', 'guard_outcome']);

/**
 * Sealed night rows from replay.log[].payload.events — the private GameEvents
 * the room withholds live and writes into the log payload.
 *
 * THE BEAT JOIN, stated because it is not obvious: (payload.turn_index,
 * payload.player) -> the beat of the matching public 'move' event. Within a
 * night all eight seats share one turn_index, so intra-night ordering is SEAT
 * ORDER — which is exactly the order the room resolves held submissions in,
 * and therefore the order the move beats already carry.
 */
export function sealedRowsFromReplay(replay, m) {
  const out = [];
  const log = Array.isArray(replay && replay.log) ? replay.log : [];
  for (const entry of log) {
    const p = entry && entry.payload;
    if (!p || typeof p !== 'object') continue;
    const evs = Array.isArray(p.events) ? p.events : [];
    if (evs.length === 0) continue;
    const beat = m.moveBeats.get(`${p.turn_index}|${p.player}`);
    for (let i = 0; i < evs.length; i++) {
      const gev = evs[i];
      if (!gev || typeof gev !== 'object') continue;
      if (gev.visibility === 'public') continue;
      if (!SEALED_KINDS.has(gev.type)) continue;
      const data = gev.data || {};
      // The owner is whatever key the event carries; `p.player` is only the
      // seat whose apply() produced it, which for guard_outcome (emitted from
      // resolveNight inside the LAST night mover's apply) is the wrong seat.
      const speaker = data.from ?? data.who ?? data.by ?? data.doctor ?? p.player ?? null;
      out.push({
        kind: 'sealed',
        id: `s${entry.seq}:${i}`,
        beat: Number.isFinite(beat) ? beat : 0,
        seq: null,
        night: gev.type,
        day: data.day ?? null,
        speaker,
        target: data.target ?? null,
        verdict: data.verdict ?? null,
        saved: data.saved ?? null,
        value: typeof data.text === 'string' ? data.text : '',
      });
    }
  }
  out.sort((a, b) => a.beat - b.beat || seatIdx(a.speaker) - seatIdx(b.speaker));
  return out;
}

function sealedLabel(r) {
  switch (r.night) {
    case 'pack_whisper':
      return 'whispers to the pack';
    case 'night_note':
      return 'private note';
    case 'kill_intent':
      return `marks ${r.target} for the kill`;
    case 'peek_result':
      return `peeks ${r.target} = ${String(r.verdict ?? '').toUpperCase()}`;
    case 'guard_choice':
      return `guards ${r.target}`;
    case 'guard_outcome':
      return r.saved === true ? `guard on ${r.target} — SAVED A LIFE` : `guard on ${r.target} — not needed`;
    default:
      return String(r.night);
  }
}

/**
 * The veracity verdict for one public utterance, given the revealed role map.
 * Pure arithmetic over the structured act/target/role/verdict fields — never
 * a heuristic over free text.
 */
export function veracityOf(row, roles) {
  const role = roles[row.speaker];
  if (!role) return null;
  if (row.act === 'claim' && row.role && row.role !== role) return { cls: 'ww-lie', chip: 'FALSE CLAIM' };
  if (row.act === 'claim' && row.role === role) return { cls: 'ww-true-claim', chip: 'TRUE CLAIM' };
  if (row.act === 'report' && role !== 'seer') return { cls: 'ww-fake-report', chip: 'FABRICATED CHECK' };
  if (row.act === 'report' && role === 'seer') {
    const truth = roles[row.target] === 'werewolf' ? 'wolf' : 'clear';
    // ANOMALY is unreachable under the rules — it is a self-check on our own
    // arithmetic, not an accusation against the engine.
    return truth === row.verdict ? { cls: 'ww-true-report', chip: 'TRUE CHECK' } : { cls: 'ww-anomaly', chip: 'ANOMALY' };
  }
  if (row.act === 'accuse' && role === 'werewolf' && row.target && roles[row.target] !== 'werewolf') {
    return { cls: 'ww-misdirect', chip: 'MISDIRECT' };
  }
  if (row.act === 'defend' && role === 'werewolf' && row.target && roles[row.target] === 'werewolf') {
    return { cls: 'ww-pack-cover', chip: 'PACK COVER' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering — text nodes only, no inline styling, every node carries a beat.
// ---------------------------------------------------------------------------

function chipFor(row) {
  if (row.forced === 'timeout') {
    return { cls: 'ww-chip-timeout', label: row.strikeCount ? `⏱ no answer (strike ${row.strikeCount}/3)` : '⏱ no answer' };
  }
  if (row.forced === 'illegal') return { cls: 'ww-chip-timeout', label: '⚠ illegal move — default applied' };
  switch (row.act) {
    case 'accuse':
      return { cls: 'ww-chip-accuse', label: `accuses ${row.target}` };
    case 'defend':
      return { cls: 'ww-chip-defend', label: `defends ${row.target}` };
    case 'claim':
      return { cls: 'ww-chip-claim', label: `claims ${String(row.role ?? '').toUpperCase()}` };
    case 'report':
      return { cls: 'ww-chip-report', label: `reports ${row.target} = ${String(row.verdict ?? '').toUpperCase()}` };
    case 'defense':
      return { cls: 'ww-chip-defense', label: 'DEFENCE' };
    case 'ballot':
      return { cls: 'ww-chip-ballot', label: row.target ? `votes ${row.target}` : 'abstains' };
    default:
      return row.value === '' ? { cls: 'ww-chip-silent', label: '⟨silent⟩' } : null;
  }
}

function utteranceNode(row, ctx) {
  const idx = seatIdx(row.speaker);
  const cls = ['ww-utt', `ww-seat-${idx}`, `ww-act-${row.act}`];
  if (row.forced !== null && row.forced !== undefined) cls.push('ww-timeout');
  else if (row.value === '') cls.push('ww-silent');
  const li = el('li', {
    class: cls.join(' '),
    dataset: {
      beat: row.beat,
      seq: row.seq === null || row.seq === undefined ? '' : row.seq,
      speaker: row.speaker,
      act: row.act,
      target: row.target ?? '',
      role: row.role ?? '',
      verdict: row.verdict ?? '',
      day: row.day ?? '',
    },
  });

  const head = el('span', { class: 'ww-utt-head' });
  head.appendChild(el('span', { class: `ww-speaker ww-fg-seat-${idx}` }, String(row.speaker)));
  const handle = ctx.handleOf(row.speaker);
  if (handle) head.appendChild(el('span', { class: 'ww-handle' }, handle));
  const chip = chipFor(row);
  if (chip) head.appendChild(el('span', { class: `ww-chip ${chip.cls}` }, chip.label));
  const stampParts = [`d${row.day}`];
  if (row.round !== null && row.round !== undefined && row.round >= 0) stampParts.push(`r${row.round + 1}`);
  if (typeof row.seq === 'number') stampParts.push(`#${row.seq}`);
  head.appendChild(el('span', { class: 'ww-stamp' }, stampParts.join(' · ')));
  li.appendChild(head);

  if (row.value !== '') {
    const p = inertParagraph(row.value);
    p.setAttribute('class', 'inert-text ww-speech');
    li.appendChild(p);
  }
  // The truth chip slot is always present and always EMPTY until a reveal
  // lands, so applying the overlay is a classList + appendChild pass and
  // never a re-render.
  li.appendChild(el('span', { class: 'ww-truth-chip' }));
  return li;
}

function dividerNode(row) {
  return el(
    'li',
    { class: `ww-divider ww-divider-${row.tone}`, dataset: { beat: row.beat, day: row.day ?? '' } },
    el('span', { class: 'ww-divider-label' }, row.label),
  );
}

function ballotNode(row) {
  const t = tallyOf(row.ballots);
  const li = el('li', { class: 'ww-ballot-card', dataset: { beat: row.beat, day: row.day ?? '' } });
  li.appendChild(el('span', { class: 'ww-divider-label' }, `⚖ BALLOT — DAY ${row.day}`));
  const list = el('ul', { class: 'ww-ballot-rows' });
  for (const voter of Object.keys(row.ballots || {}).sort((a, b) => seatIdx(a) - seatIdx(b))) {
    const target = row.ballots[voter];
    list.appendChild(
      el('li', { class: `ww-ballot-row ww-seat-${seatIdx(voter)}`, dataset: { beat: row.beat } }, [
        el('span', { class: `ww-speaker ww-fg-seat-${seatIdx(voter)}` }, voter),
        el('span', { class: 'ww-ballot-arrow' }, '→'),
        target
          ? el('span', { class: `ww-speaker ww-fg-seat-${seatIdx(target)}` }, String(target))
          : el('span', { class: 'muted' }, 'abstain'),
      ]),
    );
  }
  li.appendChild(list);

  const tallyLine = el('p', { class: 'ww-tally' });
  if (t.rows.length === 0) tallyLine.appendChild(text('no votes cast'));
  else tallyLine.appendChild(text(t.rows.map(([seat, n]) => `${seat} ×${n}`).join('  ·  ')));
  if (t.abstains > 0) tallyLine.appendChild(text(`  ·  abstains ${t.abstains}`));
  li.appendChild(tallyLine);

  // Strict plurality, restated on the card itself so nobody has to remember it.
  const outcome = el('p', { class: `ww-outcome ww-outcome-${t.outcome}` });
  if (t.outcome === 'plurality') outcome.appendChild(text(`strict plurality — ${t.lynched} is lynched`));
  else if (t.outcome === 'tie') outcome.appendChild(text('tie at the top — NO LYNCH (any tie is no lynch)'));
  else outcome.appendChild(text('nobody voted — no lynch'));
  li.appendChild(outcome);
  return li;
}

function sealedNode(row, ctx) {
  const idx = seatIdx(row.speaker);
  const li = el('li', {
    class: `ww-utt ww-sealed ww-sealed-${row.night} ww-seat-${idx}`,
    dataset: { beat: row.beat, speaker: row.speaker ?? '', sealed: row.night, day: row.day ?? '' },
  });
  const head = el('span', { class: 'ww-utt-head' });
  head.appendChild(el('span', { class: 'ww-chip ww-chip-seal' }, 'SEALED · revealed post-game'));
  head.appendChild(el('span', { class: `ww-speaker ww-fg-seat-${idx}` }, String(row.speaker ?? '?')));
  const handle = ctx.handleOf(row.speaker);
  if (handle) head.appendChild(el('span', { class: 'ww-handle' }, handle));
  head.appendChild(el('span', { class: 'ww-chip ww-chip-night' }, sealedLabel(row)));
  head.appendChild(el('span', { class: 'ww-stamp' }, `night ${row.day}`));
  li.appendChild(head);
  if (row.value !== '') {
    const p = inertParagraph(row.value);
    p.setAttribute('class', 'inert-text ww-speech');
    li.appendChild(p);
  }
  li.appendChild(el('span', { class: 'ww-truth-chip' }));
  return li;
}

function rowNode(row, ctx) {
  if (row.kind === 'divider') return dividerNode(row);
  if (row.kind === 'ballot') return ballotNode(row);
  if (row.kind === 'sealed') return sealedNode(row, ctx);
  return utteranceNode(row, ctx);
}

// --- scrolling ------------------------------------------------------------

function scrollHostFor(node) {
  const sh = Number(node.scrollHeight) || 0;
  const ch = Number(node.clientHeight) || 0;
  if (sh > ch + 4) return node;
  return (typeof document !== 'undefined' && (document.scrollingElement || document.documentElement)) || node;
}

function isPinned(node, slack = 64) {
  const h = scrollHostFor(node);
  const sh = Number(h.scrollHeight) || 0;
  const st = Number(h.scrollTop) || 0;
  const ch = Number(h.clientHeight) || 0;
  return sh - st - ch < slack;
}

/**
 * Hide everything after `to`. FAILS CLOSED: a node with no finite data-beat
 * is treated as future, never as past. NaN < lo and NaN > hi are both false,
 * so a `continue` on the non-finite case would leave the node permanently
 * visible — which for the lynch divider means printing the ending while the
 * spectator is scrubbed to beat 5.
 */
export function applyBeat(listEl, to) {
  const kids = listEl.children || [];
  for (let i = 0; i < kids.length; i++) {
    const node = kids[i];
    const b = Number(node.dataset ? node.dataset.beat : NaN);
    if (!Number.isFinite(b)) {
      node.classList.add('is-future');
      continue;
    }
    node.classList.toggle('is-future', b > to);
  }
}

// ---------------------------------------------------------------------------
// The theater. DOM only — every input is handed in, nothing is fetched here,
// which is what makes the live/ended split testable without a network.
// ---------------------------------------------------------------------------

/**
 * opts = { row, events?, model? }
 * Returns a controller: { absorb, applyReveal, setLive, dispose, root, listEl,
 * model }. `applyReveal` is the ONLY path that can put role data on screen and
 * it refuses to run while the model has not seen an 'end'.
 */
export function createTheater(host, opts) {
  const options = opts || {};
  const row = options.row || null;
  const m = options.model || createModel();
  const seats = Array.isArray(row && row.seats) ? row.seats : [];
  const handleById = new Map();
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    handleById.set(s.player ?? `p${i}`, displayHandle(s.handle ?? s.agent_id));
  }
  const ctx = { handleOf: (seat) => handleById.get(seat) || null };

  const root = el('div', { class: 'ww-theater', 'aria-live': 'off', 'data-game': 'werewolf' });

  // --- banner + a SMALL dedicated live region ------------------------------
  const banner = el('div', { class: 'ww-banner' });
  const bannerTags = el('div', { class: 'ww-banner-tags' });
  const bannerLine = el('div', { class: 'ww-banner-line' });
  banner.appendChild(bannerTags);
  banner.appendChild(bannerLine);
  // index.html wraps the whole SPA in <main aria-live="polite">; the theater
  // root turns that off for its subtree and this strip is the only thing that
  // announces, so an appending transcript never becomes a screen-reader
  // firehose.
  const statusStrip = el('p', { class: 'ww-status-strip', role: 'status', 'aria-live': 'polite' });
  banner.appendChild(statusStrip);
  root.appendChild(banner);

  const layout = el('div', { class: 'ww-layout' });
  const rail = el('div', { class: 'ww-rail' });
  const stage = el('div', { class: 'ww-stage' });
  layout.appendChild(rail);
  layout.appendChild(stage);

  // --- roster ---------------------------------------------------------------
  const rosterPanel = el('div', { class: 'panel ww-panel' });
  rosterPanel.appendChild(el('h2', { class: 'section-title' }, 'The table'));
  const rosterList = el('ul', { class: 'ww-roster' });
  rosterPanel.appendChild(rosterList);
  rail.appendChild(rosterPanel);

  // --- seal / reveal control ------------------------------------------------
  const sealPanel = el('div', { class: 'panel ww-panel ww-seal-panel' });
  sealPanel.appendChild(el('h2', { class: 'section-title' }, 'The seal'));
  const sealNote = el('p', { class: 'sealed-marker ww-seal-note' }, SEALED_COPY);
  sealPanel.appendChild(sealNote);
  // Visible but DISABLED while the game runs: a human should be able to see
  // that the seal is a real thing being held, not an absent feature.
  const truthBtn = el('button', { type: 'button', class: 'ww-truth-btn', disabled: true }, 'Truth overlay — sealed');
  sealPanel.appendChild(truthBtn);
  const truthHost = el('div', { class: 'ww-truth-host' });
  sealPanel.appendChild(truthHost);
  rail.appendChild(sealPanel);

  // --- transcript -----------------------------------------------------------
  const transcriptPanel = el('div', { class: 'panel ww-panel ww-transcript-panel' });
  const tHead = el('div', { class: 'ww-transcript-head' });
  tHead.appendChild(el('h2', { class: 'section-title' }, 'Transcript'));
  const filterSelect = el('select', { class: 'ww-filter', 'aria-label': 'filter the transcript' });
  filterSelect.appendChild(el('option', { value: 'all' }, 'everything'));
  filterSelect.appendChild(el('option', { value: 'timeouts' }, 'timeouts only'));
  filterSelect.appendChild(el('option', { value: 'silent' }, 'silences only'));
  tHead.appendChild(filterSelect);
  transcriptPanel.appendChild(tHead);
  const listEl = el('ol', { class: 'ww-transcript' });
  transcriptPanel.appendChild(listEl);
  stage.appendChild(transcriptPanel);
  root.appendChild(layout);

  // --- timeline -------------------------------------------------------------
  const timeline = el('div', { class: 'ww-timeline' });
  const scrub = el('input', { type: 'range', class: 'ww-scrub', min: '0', max: '0', value: '0', 'aria-label': 'scrub to a beat' });
  const beatLabel = el('span', { class: 'ww-beat-label' }, 'beat 0 / 0');
  const liveBtn = el('button', { type: 'button', class: 'ww-live-btn' }, 'return to live ↦');
  liveBtn.setAttribute('hidden', '');
  timeline.appendChild(liveBtn);
  timeline.appendChild(scrub);
  timeline.appendChild(beatLabel);
  root.appendChild(timeline);

  host.appendChild(root);

  const nodes = new Map();
  let latched = true; // follow the head of the stream until the human scrubs
  let viewBeat = 0;
  let seatOptionsAdded = false;
  let filterValue = 'all';
  let disposed = false;
  let phaseClass = '';
  let revealApplied = false;
  let sealedApplied = false;

  function setFilterClasses() {
    const base = ['ww-transcript'];
    if (filterValue !== 'all') base.push(`filter-${filterValue}`);
    listEl.setAttribute('class', base.join(' '));
  }

  filterSelect.addEventListener('change', () => {
    filterValue = filterSelect.value || 'all';
    setFilterClasses();
  });

  scrub.addEventListener('input', () => {
    const v = Number(scrub.value);
    viewBeat = Number.isFinite(v) ? v : m.beat;
    latched = viewBeat >= m.beat;
    if (latched) liveBtn.setAttribute('hidden', '');
    else liveBtn.removeAttribute('hidden');
    applyBeat(listEl, viewBeat);
    paintBeatLabel();
  });

  liveBtn.addEventListener('click', () => {
    latched = true;
    viewBeat = m.beat;
    scrub.value = String(m.beat);
    liveBtn.setAttribute('hidden', '');
    applyBeat(listEl, viewBeat);
    paintBeatLabel();
  });

  function paintBeatLabel() {
    clear(beatLabel);
    beatLabel.appendChild(text(`beat ${viewBeat} / ${m.beat}${latched ? ' · LIVE' : ''}`));
  }

  function paintRoster() {
    clear(rosterList);
    const deadBy = new Map();
    for (const d of m.dead) deadBy.set(d.seat, d);
    const order = seats.length > 0 ? seats.map((s, i) => s.player ?? `p${i}`) : m.alive.concat(m.dead.map((d) => d.seat));
    for (const seat of order) {
      const idx = seatIdx(seat);
      const dead = deadBy.get(seat) || null;
      const li = el('li', { class: `ww-roster-row ww-seat-${idx}${dead ? ' is-dead' : ''}`, dataset: { seat } });
      li.appendChild(el('span', { class: `ww-swatch ww-bg-seat-${idx}`, 'aria-hidden': 'true' }));
      li.appendChild(el('span', { class: `ww-speaker ww-fg-seat-${idx}` }, seat));
      const handle = ctx.handleOf(seat);
      if (handle) li.appendChild(el('a', { class: 'ww-handle', href: `#/agents/${encodeURIComponent(handle)}` }, handle));
      li.appendChild(
        el('span', { class: 'ww-roster-state' }, dead ? `✕ dead d${dead.day ?? '?'} (${dead.cause}) — ${String(dead.role ?? 'unknown').toUpperCase()}` : '● alive'),
      );
      // A living seat's role exists here ONLY once m.roles has been handed
      // over by the post-'end' reveal. Dead seats were already public.
      const revealed = m.roles ? m.roles[seat] : null;
      if (revealed) li.appendChild(el('span', { class: `ww-role-badge ww-role-${revealed}` }, String(revealed).toUpperCase()));
      rosterList.appendChild(li);
    }
    if (!seatOptionsAdded && order.length > 0) {
      seatOptionsAdded = true;
      for (const seat of order) filterSelect.appendChild(el('option', { value: `seat-${seatIdx(seat)}` }, `seat ${seat} only`));
    }
  }

  function paintBanner() {
    clear(bannerTags);
    const status = m.ended ? 'ended' : (row && row.status) || 'live';
    bannerTags.appendChild(el('span', { class: `tag ${status === 'ended' ? 'tag-ended' : 'tag-live'}` }, status));
    bannerTags.appendChild(el('span', { class: 'tag' }, 'werewolf'));
    clear(bannerLine);
    const bits = [];
    if (m.phase) bits.push(phaseLabel(m.phase, m.day, m.round));
    bits.push(`${m.alive.length || 0} alive`);
    if (m.wolvesRemaining !== null) bits.push(`${m.wolvesRemaining} wolves remain`);
    bannerLine.appendChild(text(bits.join('  ·  ')));
    const nextPhaseClass = `is-${m.phase ?? 'unknown'}`;
    if (phaseClass !== nextPhaseClass) {
      if (phaseClass) root.classList.remove(phaseClass);
      phaseClass = nextPhaseClass;
      root.classList.add(phaseClass);
    }
    clear(statusStrip);
    if (m.ended) statusStrip.appendChild(text('the game has ended'));
    else if (m.pending.length > 0) statusStrip.appendChild(text(`waiting on ${m.pending.join(', ')}`));
    else if (m.phase) statusStrip.appendChild(text(phaseLabel(m.phase, m.day, m.round)));
  }

  /** Append-only DOM sync. Never clear() + rebuild; never force scrollTop. */
  function syncRows() {
    const pinned = isPinned(listEl);
    let added = 0;
    for (let i = 0; i < m.rows.length; i++) {
      const r = m.rows[i];
      if (nodes.has(r.id)) continue;
      const node = rowNode(r, ctx);
      nodes.set(r.id, node);
      let before = null;
      for (let j = i + 1; j < m.rows.length; j++) {
        const n = nodes.get(m.rows[j].id);
        if (n) {
          before = n;
          break;
        }
      }
      listEl.insertBefore(node, before);
      added++;
    }
    if (added > 0 && pinned) {
      const h = scrollHostFor(listEl);
      h.scrollTop = h.scrollHeight;
    }
    return added;
  }

  function refresh() {
    syncRows();
    scrub.setAttribute('max', String(m.beat));
    if (latched) {
      viewBeat = m.beat;
      scrub.value = String(m.beat);
    }
    applyBeat(listEl, viewBeat);
    paintRoster();
    paintBanner();
    paintBeatLabel();
  }

  function absorb(events) {
    for (const ev of events || []) foldEvent(m, ev);
    refresh();
  }

  /**
   * Builds the truth overlay. GUARDED: nothing here can run — and therefore
   * nothing role-shaped can enter the DOM — unless the model has folded an
   * 'end' AND a role map actually arrived. There is no "hidden" overlay to
   * un-hide; while the game is live the nodes do not exist.
   *
   * Two-part on purpose. At the buzzer the post-'end' `reveal` event hands
   * over the ROLES while the replay endpoint may still be a moment away from
   * writing, so the roles half and the sealed-night half land independently
   * and each is applied at most once. Returns whether anything changed.
   */
  function applyReveal(reveal) {
    if (disposed || !m.ended) return false;
    const roles = reveal && reveal.roles && typeof reveal.roles === 'object' ? reveal.roles : m.roles;
    if (!roles || Object.keys(roles).length === 0) return false;
    let changed = false;

    // --- the sealed night, from the replay's log payloads --------------------
    const sealedRows = sealedApplied ? [] : sealedRowsFromReplay(reveal && reveal.replay, m);
    if (sealedRows.length > 0) {
      sealedApplied = true;
      changed = true;
      for (const r of sealedRows) insertRow(m, r);
      syncRows(); // the sealed rows must exist before anything is marked
      clear(truthHost);
      truthHost.appendChild(
        el('p', { class: 'ww-truth-legend' }, [
          text('The sealed night rows are '),
          el('strong', {}, 'from the signed log'),
          text(' — logged and hash-chained, not yet independently re-derived. They are interleaved into the transcript at the beat they were spoken.'),
        ]),
      );
      if (reveal && reveal.reconstructedFrom) {
        truthHost.appendChild(el('p', { class: 'partial-banner' }, `reveal reconstructed from the ${String(reveal.reconstructedFrom)} log — sealed night rows may be incomplete`));
      }
      filterSelect.appendChild(el('option', { value: 'sealed' }, 'sealed night rows only'));
    }

    // --- the roles, and the veracity of every public row ---------------------
    if (!revealApplied) {
      revealApplied = true;
      changed = true;
      m.roles = { ...roles };
      root.classList.add('ww-truth-on');
      // Pure classList + one text node per chip: the dataset every chip needs
      // was written at append time, so this is not a re-render.
      for (const r of m.rows) {
        if (r.kind !== 'utt') continue;
        const node = nodes.get(r.id);
        if (!node) continue;
        if (roles[r.speaker] === 'werewolf') node.classList.add('ww-by-wolf');
        const v = veracityOf(r, roles);
        if (!v) continue;
        node.classList.add(v.cls);
        const slot = node.lastChild;
        if (slot && slot.classList && slot.classList.contains('ww-truth-chip')) slot.appendChild(text(v.chip));
      }
      filterSelect.appendChild(el('option', { value: 'wolves' }, 'wolves only'));
      filterSelect.appendChild(el('option', { value: 'lies' }, 'lies only'));
      clear(sealNote);
      sealNote.setAttribute('class', 'sealed-marker revealed-marker ww-seal-note');
      sealNote.appendChild(text('✓ the game ended — roles, night actions and the pack channel are open'));
      clear(truthBtn);
      truthBtn.appendChild(text('Truth overlay — on'));
      truthBtn.removeAttribute('disabled');
    }

    if (changed) refresh();
    return changed;
  }

  truthBtn.addEventListener('click', () => {
    if (!m.roles) return;
    const on = root.classList.contains('ww-truth-on');
    root.classList.toggle('ww-truth-on', !on);
    clear(truthBtn);
    truthBtn.appendChild(text(on ? 'Truth overlay — off' : 'Truth overlay — on'));
  });

  if (Array.isArray(options.events)) absorb(options.events);
  else refresh();

  return {
    root,
    listEl,
    model: m,
    truthButton: truthBtn,
    absorb,
    applyReveal,
    refresh,
    dispose() {
      disposed = true;
      nodes.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Route entry.
// ---------------------------------------------------------------------------

/** Drains the whole event backlog page by page rather than the first 500. */
async function drainEvents(gameId, onPage) {
  let cursor = 0;
  for (let i = 0; i < MAX_DRAIN_PAGES; i++) {
    const events = await getGameEventsSince(gameId, cursor);
    if (events.length === 0) break;
    let next = cursor;
    for (const e of events) if (typeof e.seq === 'number' && e.seq > next) next = e.seq;
    if (next <= cursor) break; // no forward progress: stop rather than spin
    cursor = next;
    onPage(events);
    if (events.length < PAGE_SIZE) break;
  }
  return cursor;
}

export function mount(container, params, query, preloadedRow) {
  const gameId = params.id;
  clear(container);
  const host = el('div');
  container.appendChild(host);
  host.appendChild(el('p', { class: 'muted' }, 'Loading the table…'));

  let disposed = false;
  let theater = null;
  let revealTimer = null;
  let unsubscribe = () => {};
  const previousTitle = typeof document !== 'undefined' ? document.title : '';
  if (typeof document !== 'undefined' && document.body && document.body.classList) {
    document.body.classList.add('ww-theater-page');
  }

  /**
   * The replay endpoint 409s until the game has ended. That refusal IS the
   * seal and we never route around it — but at the buzzer the `reveal` event
   * can beat the replay being written, in which case the roles land now and
   * the sealed night rows arrive on a bounded retry rather than on a reload.
   */
  async function loadReveal(attempt = 0) {
    revealTimer = null;
    let replay = null;
    try {
      replay = await getReplay(gameId);
    } catch {
      replay = null;
    }
    if (disposed || !theater) return;
    const fromReplay = replay && replay.initial_state && replay.initial_state.roles;
    const roles = theater.model.roles || (fromReplay && typeof fromReplay === 'object' ? fromReplay : null);
    if (roles) {
      theater.applyReveal({ roles, replay, reconstructedFrom: replay && replay.reconstructed_from ? replay.reconstructed_from : null });
    }
    if (replay === null && attempt < REVEAL_RETRIES) {
      revealTimer = setTimeout(() => void loadReveal(attempt + 1), REVEAL_RETRY_MS);
    }
  }

  /** The hall's headline shareable artifact deserves better than "Game <id>". */
  function setTitle() {
    if (typeof document === 'undefined' || !theater) return;
    const m = theater.model;
    const state = m.ended ? 'ended' : `day ${m.day} · ${m.alive.length} alive`;
    document.title = `werewolf · ${state} — Naibul`;
  }

  async function boot() {
    let row = preloadedRow || null;
    try {
      if (!row) row = await getGame(gameId);
    } catch (err) {
      if (disposed) return;
      clear(host);
      host.appendChild(el('div', { class: 'error-banner' }, [el('strong', {}, 'Could not load this game. '), text(err && err.message ? err.message : String(err))]));
      return;
    }
    if (disposed) return;
    clear(host);
    host.appendChild(el('h1', { class: 'page-title' }, 'Werewolf — the transcript'));
    host.appendChild(el('p', { class: 'muted' }, [text('Every word below is a move. '), el('a', { href: `#/replay/${encodeURIComponent(gameId)}` }, 'Open the replay & verify →')]));
    theater = createTheater(host, { row });

    let cursor = 0;
    try {
      cursor = await drainEvents(gameId, (events) => {
        if (!disposed && theater) theater.absorb(events);
      });
    } catch (err) {
      if (!disposed) {
        host.appendChild(el('div', { class: 'error-banner' }, [el('strong', {}, 'Could not load the full transcript. '), text(err && err.message ? err.message : String(err))]));
      }
    }
    if (disposed) return;
    setTitle();
    if (theater.model.ended || (row && row.status === 'ended')) void loadReveal();

    unsubscribe = subscribeGameEvents(gameId, cursor, (events) => {
      if (disposed || !theater) return;
      theater.absorb(events);
      setTitle();
      if (events.some((e) => e.type === 'end' || e.type === 'forfeit')) void loadReveal();
    });
  }

  void boot();

  return {
    dispose() {
      disposed = true;
      unsubscribe();
      if (revealTimer !== null) clearTimeout(revealTimer);
      if (theater) theater.dispose();
      if (typeof document !== 'undefined') {
        document.title = previousTitle;
        if (document.body && document.body.classList) document.body.classList.remove('ww-theater-page');
      }
    },
  };
}
