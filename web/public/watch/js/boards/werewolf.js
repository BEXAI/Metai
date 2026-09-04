// Werewolf: the spectator DOSSIER. Werewolf has no board — the artifact is
// language — so the "board" is the TABLE: eight seats on a ring, who is alive,
// who is dead and what the dead turned out to be, the accusation pressure of
// the current day, the ballot, and the night results.
//
// THE LAW FOR THIS FILE. The only role strings this renderer may emit come
// from `dead[].role` (src/games/werewolf/render.ts#PublicDead) — the public
// death record, which exists because every death reveals. A LIVING seat's role
// is never rendered: not as text, not in a class, not in a <title>, from any
// input shape. Claims and reports are deliberately NOT rendered here either.
// They are public, but they are assertions ABOUT a living seat's role; they
// belong to the transcript surface, and leaving them out makes "no role word
// can appear beside a living seat" a literal, testable property of this file.
//
// view fields read — src/games/werewolf/render.ts#publicOf, whose key set is
// frozen by a test there, so nothing below is invented: day, phase, round,
// players, alive, dead[{seat,day,cause,role}], edges, vote_history, nights,
// defender, acted_this_night, voted_this_phase, pending, wolves_remaining,
// village_remaining.
//
// SEAT CLASSES ARE NUMERIC. `edges` carries seat IDS ('p3') while the repo's
// CSS families are numeric (`.piece-seat-3`, boards/landlord.js:122), so every
// class here is built from seatIndex(), never from the seat string — a
// `piece-seat-p3` would silently resolve to nothing.
//
// SVG PAINT RULE. Every painted node carries a safe presentation attribute
// (fill="none" / fill="currentColor" / stroke="currentColor") *and* a class.
// A CSS rule always beats a presentation attribute, so the stylesheet takes
// over wherever it defines one — and until it does, nothing paints default
// black on a dark panel. The seat palette currently stops at --seat-5
// (styles.css:15-20, :414-419), so p6/p7 are the seats that need it.

// `circle()` from common.js is deliberately not used: it takes a class only,
// and every painted node here also needs its safe fill/stroke default.
import { makeSvg, svgEl, svgTitle } from './common.js';
import { clear, el } from '../dom.js';

const CX = 160;
const CY = 160;
const R_TABLE = 104;
const R_SEAT = 22;

/** 'p3' -> 3. Anything else -> null, and the class is then simply omitted. */
function seatIndex(seat) {
  if (typeof seat !== 'string') return null;
  const m = /^p(\d+)$/.exec(seat);
  return m ? Number(m[1]) : null;
}

function isSeat(value) {
  return seatIndex(value) !== null;
}

/** `piece-seat-3`, or '' when the seat id is not one we recognise. */
function seatClass(prefix, seat) {
  const idx = seatIndex(seat);
  return idx === null ? '' : `${prefix}${idx}`;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function obj(value) {
  return value && typeof value === 'object' ? value : {};
}

function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Cause is a closed engine enum (src/games/werewolf/board.ts#Cause) and it
 * becomes an `is-dead-*` class, so it is narrowed to the three known values
 * rather than passed through — a class family with an open member set is how
 * a stylesheet quietly stops matching.
 */
function causeOf(value) {
  return value === 'wolves' || value === 'lynch' ? value : 'abandoned';
}

// ---------------------------------------------------------------------------
// Normalisation — the only two shapes that reach a board renderer
// ---------------------------------------------------------------------------

/**
 * Returns the public projection this file renders, or null when the value is
 * not a werewolf view (so boards/index.js falls back to board_text — which for
 * werewolf is the engine's own ASCII dossier, the best fallback in the hall).
 */
function project(view) {
  if (!view || typeof view !== 'object') return null;
  if (!Array.isArray(view.players) || view.players.length === 0) return null;
  if (Array.isArray(view.alive)) return fromPublicView(view);
  if (view.alive && typeof view.alive === 'object') return fromFullState(view);
  return null;
}

/** The spectator payload: publicOf(state) plus the room's board_text key. */
function fromPublicView(v) {
  return {
    day: num(v.day, 0),
    phase: typeof v.phase === 'string' ? v.phase : '',
    round: num(v.round, 0),
    players: v.players.filter(isSeat),
    alive: v.alive.filter(isSeat),
    dead: arr(v.dead)
      .filter((d) => d && typeof d === 'object' && isSeat(d.seat))
      .map((d) => ({
        seat: d.seat,
        day: num(d.day, null),
        cause: causeOf(d.cause),
        role: typeof d.role === 'string' ? d.role : null,
      })),
    edges: arr(v.edges).filter((e) => e && isSeat(e.from) && isSeat(e.to)),
    voteHistory: arr(v.vote_history).filter((h) => h && typeof h === 'object'),
    nights: arr(v.nights).filter((n) => n && typeof n === 'object'),
    defender: isSeat(v.defender) ? v.defender : null,
    actedTonight: arr(v.acted_this_night).filter(isSeat),
    voted: arr(v.voted_this_phase).filter(isSeat),
    pending: arr(v.pending).filter(isSeat),
    wolvesLeft: num(v.wolves_remaining, null),
    villageLeft: num(v.village_remaining, null),
  };
}

/**
 * pages/replay.js:270 hands renderBoard the replay's `initial_state`, which for
 * werewolf is the RAW WwState — every role, every peek, every whisper. We
 * branch on that shape EXPLICITLY (never inferring "no roles key" as "roles are
 * hidden") and then project it exactly the way render.ts#publicOf does, so
 * `roles`, `peeks`, `guards`, `kills`, `packLog` and `noteLog` are never read.
 *
 * This is narrower than the truth overlay the plan gives the theater surface:
 * that surface knows the game has ended and can say so. A board renderer is
 * called from three pages and cannot, so it never reveals a living seat.
 */
function fromFullState(v) {
  const aliveMap = obj(v.alive);
  const causeMap = obj(v.cause);
  const revealedMap = obj(v.revealed);
  const players = v.players.filter(isSeat);
  const nights = arr(v.nights).filter((n) => n && typeof n === 'object');
  const voteHistory = arr(v.voteHistory).filter((h) => h && typeof h === 'object');

  // Death days are recoverable from the public ledgers alone — the same
  // derivation as render.ts#deathDays.
  const days = {};
  for (const n of nights) if (isSeat(n.died)) days[n.died] = num(n.day, null);
  for (const h of voteHistory) if (isSeat(h.lynched)) days[h.lynched] = num(h.day, null);

  return {
    day: num(v.day, 0),
    phase: typeof v.phase === 'string' ? v.phase : '',
    round: num(v.round, 0),
    players,
    alive: players.filter((p) => aliveMap[p] === true),
    // `revealed` holds dead seats only by construction, and it is read HERE
    // ONLY, inside the dead branch, so a stray living entry cannot escape.
    dead: players
      .filter((p) => aliveMap[p] !== true)
      .map((p) => ({
        seat: p,
        day: num(days[p], null),
        cause: causeOf(causeMap[p]),
        role: typeof revealedMap[p] === 'string' ? revealedMap[p] : null,
      })),
    edges: arr(v.edges).filter((e) => e && isSeat(e.from) && isSeat(e.to)),
    voteHistory,
    nights,
    defender: isSeat(v.defender) ? v.defender : null,
    // The per-phase slot MAPS are hidden state; publicOf ships only their key
    // sets, and an initial_state has none. Not worth touching here.
    actedTonight: [],
    voted: [],
    pending: [],
    // Derived in publicOf from the public role multiset, which this file does
    // not have. Absent rather than guessed.
    wolvesLeft: null,
    villageLeft: null,
  };
}

// ---------------------------------------------------------------------------
// Derived, all of it arithmetic over public ledgers
// ---------------------------------------------------------------------------

/** `n3 taken by the wolves` / `d2 lynched` — mirrors render.ts#deathLabel. */
function deathNote(d) {
  if (d.cause === 'wolves') return `${d.day === null ? '' : `n${d.day} `}taken by the wolves`;
  if (d.cause === 'lynch') return `${d.day === null ? '' : `d${d.day} `}lynched`;
  return 'abandoned (three strikes or clock)';
}

function phaseLine(pub) {
  switch (pub.phase) {
    case 'night':
      return `night ${pub.day}`;
    case 'day_talk':
      return `day ${pub.day} · discussion, round ${pub.round + 1}`;
    case 'day_defense':
      return pub.defender === null
        ? `day ${pub.day} · the defence`
        : `day ${pub.day} · the defence — ${pub.defender} answers`;
    case 'day_vote':
      return `day ${pub.day} · the ballot`;
    case 'over':
      return 'the game is over';
    default:
      return `day ${pub.day}`;
  }
}

/** Today's edges collapsed to one row per (from, to, polarity), with a count. */
function edgesToday(pub) {
  const rows = new Map();
  for (const e of pub.edges) {
    if (num(e.day, null) !== pub.day) continue;
    if (e.from === e.to) continue; // a self-loop has no chord to draw
    const polarity = e.polarity === 'defend' ? 'defend' : 'accuse';
    const key = `${e.from}|${e.to}|${polarity}`;
    const row = rows.get(key);
    if (row === undefined) rows.set(key, { from: e.from, to: e.to, polarity, weight: 1 });
    else row.weight += 1;
  }
  return [...rows.values()];
}

/** Accusations RECEIVED today: [{ seat, from: [seat], count }], heaviest first. */
function pressureToday(pub) {
  const by = new Map();
  for (const e of pub.edges) {
    if (num(e.day, null) !== pub.day || e.polarity !== 'accuse') continue;
    const list = by.get(e.to);
    if (list === undefined) by.set(e.to, [e.from]);
    else list.push(e.from);
  }
  return [...by.entries()]
    .map(([seat, from]) => ({ seat, from, count: from.length }))
    .sort((a, b) => b.count - a.count || (a.seat < b.seat ? -1 : 1));
}

// ---------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------

function seatPos(i, n) {
  const a = ((-90 + (360 / n) * i) * Math.PI) / 180;
  return [CX + R_TABLE * Math.cos(a), CY + R_TABLE * Math.sin(a)];
}

function svgText(x, y, str, cls) {
  return svgEl('text', { x, y, class: cls, 'text-anchor': 'middle', fill: 'currentColor' }, str);
}

function drawRing(pub, deadBySeat) {
  const n = pub.players.length;
  const svg = makeSvg(320, 320, 'ww-ring');
  // makeSvg sets role="img" (boards/common.js:23-29), which makes the whole
  // subtree presentational and hides every <title> from assistive tech. The
  // roster <ul> below carries the same facts as real text, so the ring is a
  // labelled group instead.
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'the village table');
  svg.appendChild(
    svgEl('circle', { cx: CX, cy: CY, r: R_TABLE, class: 'ww-felt', fill: 'none', stroke: 'currentColor' }),
  );

  const pos = new Map();
  pub.players.forEach((seat, i) => pos.set(seat, seatPos(i, n)));

  // Chords first, under the seats.
  for (const e of edgesToday(pub)) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (a === undefined || b === undefined) continue;
    const mx = CX + ((a[0] + b[0]) / 2 - CX) * 0.35; // bow toward the centre
    const my = CY + ((a[1] + b[1]) / 2 - CY) * 0.35;
    const path = svgEl('path', {
      d: `M${a[0].toFixed(1)},${a[1].toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)}`,
      class: `ww-edge ww-edge-${e.polarity} ${seatClass('ww-stroke-seat-', e.from)}`.trim(),
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': Math.min(6, 1.5 + e.weight * 1.2),
      'stroke-dasharray': e.polarity === 'defend' ? '5 4' : null,
    });
    path.appendChild(
      svgTitle(`${e.from} ${e.polarity === 'defend' ? 'defends' : 'accuses'} ${e.to}${e.weight > 1 ? ` ×${e.weight}` : ''}`),
    );
    svg.appendChild(path);
  }

  pub.players.forEach((seat, i) => {
    const [x, y] = seatPos(i, n);
    const dead = deadBySeat.get(seat) ?? null;
    const cls = ['ww-seat', seatClass('ww-seat-', seat)];
    if (dead !== null) cls.push('is-dead', `is-dead-${dead.cause}`);
    const g = svgEl('g', { class: cls.filter(Boolean).join(' '), transform: `translate(${x.toFixed(1)},${y.toFixed(1)})` });
    g.appendChild(
      svgEl('circle', {
        cx: 0,
        cy: 0,
        r: R_SEAT,
        class: `ww-seat-disc ${seatClass('piece-seat-', seat)}`.trim(),
        fill: 'none',
        stroke: 'currentColor',
      }),
    );
    g.appendChild(svgText(0, R_SEAT + 14, seat, 'ww-seat-id'));
    if (dead !== null) {
      g.appendChild(
        svgEl('line', { x1: -14, y1: -14, x2: 14, y2: 14, class: 'ww-seat-slash', stroke: 'currentColor' }),
      );
      // The ONLY role this renderer paints: a dead seat's revealed role.
      if (dead.role !== null) g.appendChild(svgText(0, R_SEAT + 26, String(dead.role).toUpperCase(), 'ww-seat-role'));
    }
    g.appendChild(svgTitle(dead === null ? `${seat} — alive` : `${seat} — dead, ${deathNote(dead)}`));
    svg.appendChild(g);
  });

  return svg;
}

// ---------------------------------------------------------------------------
// The written dossier
// ---------------------------------------------------------------------------

function section(title, children) {
  return el('section', { class: 'ww-section' }, [el('h4', { class: 'section-title' }, title), ...children]);
}

function rosterList(pub, deadBySeat) {
  const pressure = new Map(pressureToday(pub).map((p) => [p.seat, p]));
  const list = el('ul', { class: 'ww-roster' });
  for (const seat of pub.players) {
    const dead = deadBySeat.get(seat) ?? null;
    const cls = ['ww-roster-row', seatClass('ww-seat-', seat)];
    if (dead !== null) cls.push('is-dead');
    const row = el('li', { class: cls.filter(Boolean).join(' ') }, [
      el('span', { class: 'ww-roster-seat' }, seat),
      el('span', { class: 'ww-roster-state' }, dead === null ? 'alive' : 'dead'),
    ]);
    if (dead === null) {
      // A living seat's role is not ours to know, so the column says so
      // rather than guessing, and the row shows public pressure instead.
      row.appendChild(el('span', { class: 'ww-roster-role muted' }, 'role sealed'));
      const heat = pressure.get(seat);
      if (heat !== undefined) {
        row.appendChild(
          el('span', { class: 'ww-roster-note' }, `accused today ×${heat.count} by ${heat.from.join(', ')}`),
        );
      }
    } else {
      row.appendChild(el('span', { class: 'ww-roster-role' }, dead.role === null ? 'role unrecorded' : String(dead.role).toUpperCase()));
      row.appendChild(el('span', { class: 'ww-roster-note' }, deathNote(dead)));
    }
    list.appendChild(row);
  }
  return list;
}

function accusationSection(pub) {
  const rows = pressureToday(pub);
  const today = edgesToday(pub);
  const body = [];
  if (today.length === 0) {
    body.push(el('p', { class: 'muted' }, 'nothing has been said today'));
    return section('Accusations today', body);
  }
  const tally = el('ul', { class: 'ww-tally' });
  for (const r of rows) {
    tally.appendChild(
      el('li', { class: `ww-tally-row ${seatClass('ww-seat-', r.seat)}`.trim() }, [
        el('span', { class: 'ww-tally-seat' }, r.seat),
        el('span', { class: 'ww-tally-count' }, `×${r.count}`),
        el('span', { class: 'ww-tally-from' }, r.from.join(', ')),
      ]),
    );
  }
  if (rows.length === 0) tally.appendChild(el('li', { class: 'muted' }, 'no accusations — only defences'));
  body.push(tally);
  const defences = today.filter((e) => e.polarity === 'defend');
  if (defences.length > 0) {
    body.push(el('p', { class: 'ww-defends muted' }, defences.map((e) => `${e.from} defends ${e.to}`).join(' · ')));
  }
  return section('Accusations today', body);
}

function ballotSection(pub, deadBySeat) {
  const body = [];
  if (pub.phase === 'day_vote') {
    body.push(
      el('p', { class: 'ww-ballot-state' }, `${pub.voted.length} of ${pub.alive.length} ballots sealed`),
      // Stating the seal is the point: we do not have the targets and must
      // never imply that we do (publicOf ships the voter SET, never the map).
      el('p', { class: 'muted' }, 'no ballot is public until every seat has voted'),
    );
  }
  const list = el('ul', { class: 'ww-votes' });
  for (const h of pub.voteHistory) {
    const ballots = obj(h.ballots);
    const tally = new Map();
    const abstained = [];
    for (const voter of Object.keys(ballots).filter(isSeat).sort()) {
      const target = ballots[voter];
      if (!isSeat(target)) {
        abstained.push(voter);
        continue;
      }
      const bucket = tally.get(target);
      if (bucket === undefined) tally.set(target, [voter]);
      else bucket.push(voter);
    }
    const parts = [...tally.entries()]
      .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
      .map(([target, voters]) => `${target} ×${voters.length} (${voters.join(',')})`);
    if (abstained.length > 0) parts.push(`abstain ×${abstained.length} (${abstained.join(',')})`);
    const lynched = isSeat(h.lynched) ? h.lynched : null;
    const revealed = lynched === null ? null : deadBySeat.get(lynched) ?? null;
    const outcome =
      lynched === null
        ? 'no lynch'
        : `${lynched} lynched${revealed && revealed.role !== null ? ` (${String(revealed.role).toUpperCase()})` : ''}`;
    list.appendChild(
      el('li', { class: 'ww-vote-row' }, [
        el('span', { class: 'ww-vote-day' }, `d${num(h.day, 0)}`),
        el('span', { class: 'ww-vote-tally' }, parts.length === 0 ? 'no ballots cast' : parts.join(' · ')),
        el('span', { class: 'ww-vote-outcome' }, `→ ${outcome}`),
      ]),
    );
  }
  if (pub.voteHistory.length === 0) list.appendChild(el('li', { class: 'muted' }, 'no ballot has been counted yet'));
  body.push(list);
  return section('The ballot', body);
}

function nightSection(pub, deadBySeat) {
  const list = el('ul', { class: 'ww-nights' });
  for (const n of pub.nights) {
    const died = isSeat(n.died) ? n.died : null;
    const revealed = died === null ? null : deadBySeat.get(died) ?? null;
    list.appendChild(
      el('li', { class: 'ww-night-row' }, [
        el('span', { class: 'ww-night-day' }, `n${num(n.day, 0)}`),
        el(
          'span',
          { class: 'ww-night-outcome' },
          died === null
            ? 'nobody died'
            : `${died} died${revealed && revealed.role !== null ? ` (${String(revealed.role).toUpperCase()})` : ''}`,
        ),
      ]),
    );
  }
  if (pub.nights.length === 0) list.appendChild(el('li', { class: 'muted' }, 'no night has resolved yet'));
  return section('Nights', [list]);
}

/**
 * Who still owes a move. `acted_this_night` / `voted_this_phase` ship the SET
 * of seats that have acted and never what they did, so this line is safe in
 * every phase — but there is nothing to say once the game is over.
 */
function activityLine(pub) {
  if (pub.phase === 'over') return null;
  const parts = [];
  if (pub.phase === 'night' && pub.actedTonight.length > 0) parts.push(`acted tonight: ${pub.actedTonight.join(' ')}`);
  if (pub.phase === 'day_vote' && pub.voted.length > 0) parts.push(`voted: ${pub.voted.join(' ')}`);
  if (pub.pending.length > 0) parts.push(`still to act: ${pub.pending.join(' ')}`);
  if (parts.length === 0) return null;
  return el('p', { class: 'ww-activity muted' }, parts.join('  |  '));
}

// ---------------------------------------------------------------------------

/** Render the werewolf dossier from a PUBLIC view. false => renderFallback. */
export function render(container, view) {
  const pub = project(view);
  if (pub === null || pub.players.length === 0) return false;

  const deadBySeat = new Map(pub.dead.map((d) => [d.seat, d]));
  const root = el('div', { class: `ww-dossier is-${pub.phase || 'unknown'}` });

  const head = el('p', { class: 'ww-head' }, [
    el('span', { class: 'ww-phase' }, phaseLine(pub)),
    el('span', { class: 'tag' }, `${pub.alive.length} of ${pub.players.length} alive`),
  ]);
  // Same wording as the engine's own dossier (render.ts#publicDossier), which
  // also sidesteps having to pluralise a role name.
  if (pub.wolvesLeft !== null) head.appendChild(el('span', { class: 'tag tag-bad' }, `wolves left ${pub.wolvesLeft}`));
  if (pub.villageLeft !== null) head.appendChild(el('span', { class: 'tag tag-ok' }, `village left ${pub.villageLeft}`));
  root.appendChild(head);

  root.appendChild(drawRing(pub, deadBySeat));
  root.appendChild(section('The table', [rosterList(pub, deadBySeat)]));
  root.appendChild(accusationSection(pub));
  root.appendChild(ballotSection(pub, deadBySeat));
  root.appendChild(nightSection(pub, deadBySeat));
  const activity = activityLine(pub);
  if (activity !== null) root.appendChild(activity);

  clear(container);
  container.appendChild(root);
  return true;
}
