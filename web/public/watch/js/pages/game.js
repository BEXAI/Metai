// #/game/:id — board render, move list with per-move commentary (text nodes
// only), clocks, and a sealed marker for hidden fields until the game ends.
//
// The board/turn state is NOT on GET /api/games/:id (src/api/handlers.ts
// #publicGame carries no live board field at all) — it lives only in the
// spectator event stream: every 'start'/'move'/'timeout' event's data carries
// { public: game.publicView(state), board_text, notation, player,
// turn_index, commentary? } (src/rooms/core.ts). So this page fetches the
// full event backlog once, folds it into a running board + move list, then
// subscribes for new events and folds those in incrementally. See
// notes/T9.md for the event vocabulary and the (documented) gap: no public
// endpoint exposes the live turn deadline, so "clocks" here shows time since
// the last event rather than a countdown.

import { el, text, clear, inertParagraph } from '../dom.js';
import { getGame, getGameEventsSince, getReplay, subscribeGameEvents } from '../api.js';
import { renderBoard } from '../boards/index.js';
import { pickGameType, pickVariant, pickDivision, displayHandle } from '../shapes.js';

const CLOCK_TICK_MS = 1000;

// Event types whose `data` carries a fresh board snapshot (src/rooms/core.ts).
const BOARD_EVENT_TYPES = new Set(['start', 'move', 'timeout']);
// Event types worth a line in the move/activity list.
const LOGGABLE_EVENT_TYPES = new Set(['move', 'timeout', 'strike', 'resign', 'draw_offer', 'draw_accept', 'forfeit', 'end']);

function describeEvent(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'move':
      return { turn: d.turn_index, player: d.player, notation: d.notation, commentary: d.commentary, note: d.forced ? '(forced: illegal move)' : null };
    case 'timeout':
      return { turn: d.turn_index, player: d.player, notation: d.notation, note: '(timeout — default/random move applied)' };
    case 'strike':
      return { turn: d.turn_index, player: d.player, notation: null, note: `strike #${d.strike_count} (${d.reason})` };
    case 'resign':
      return { turn: d.turn_index, player: d.player, notation: null, note: 'resigns' };
    case 'draw_offer':
      return { turn: d.turn_index, player: d.player, notation: null, note: 'offers a draw' };
    case 'draw_accept':
      return { turn: d.turn_index, player: d.player, notation: null, note: 'accepts the draw' };
    case 'forfeit':
      return { turn: null, player: d.player, notation: null, note: `forfeits (${d.reason})` };
    case 'end':
      return { turn: null, player: null, notation: null, note: 'game ends' };
    default:
      return { turn: null, player: null, notation: null, note: ev.type };
  }
}

function renderSeats(container, seats) {
  clear(container);
  if (!seats || seats.length === 0) {
    container.appendChild(el('p', { class: 'muted' }, 'seats unknown'));
    return;
  }
  const list = el('ul', { class: 'move-list' });
  seats.forEach((s, i) => {
    const handle = displayHandle(s.handle ?? s.agent_id);
    const player = s.player ?? `p${i}`;
    list.appendChild(
      el('li', {}, [
        el('span', { class: 'move-index' }, String(player)),
        el('a', { href: `#/agents/${encodeURIComponent(handle)}` }, handle),
      ]),
    );
  });
  container.appendChild(list);
}

function renderMoveList(container, entries) {
  clear(container);
  if (entries.length === 0) {
    container.appendChild(el('p', { class: 'empty-state' }, 'No moves yet.'));
    return;
  }
  const list = el('ul', { class: 'move-list' });
  for (const e of entries) {
    const d = describeEvent(e);
    const li = el('li', {});
    li.appendChild(el('span', { class: 'move-index' }, d.turn !== null && d.turn !== undefined ? `#${d.turn}` : '·'));
    if (d.notation) li.appendChild(el('span', { class: 'move-notation' }, String(d.notation)));
    if (d.player) li.appendChild(el('span', { class: 'move-player' }, String(d.player)));
    if (d.note) li.appendChild(text(` ${d.note}`));
    if (d.commentary) li.appendChild(inertParagraph(d.commentary));
    list.appendChild(li);
  }
  container.appendChild(list);
  container.scrollTop = container.scrollHeight;
}

function renderClock(container, lastEventAtIso) {
  clear(container);
  if (!lastEventAtIso) {
    container.appendChild(text('no activity yet'));
    return;
  }
  const ms = Date.now() - Date.parse(lastEventAtIso);
  const secs = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : null;
  container.appendChild(
    el('span', { class: 'clock' }, secs === null ? '' : `last update ${secs}s ago`),
  );
}

export function mount(container, params) {
  const gameId = params.id;
  clear(container);
  container.appendChild(el('h1', { class: 'page-title' }, `Game ${gameId}`));

  const errorArea = el('div');
  const headerArea = el('div', { class: 'status-line' }, 'Loading…');
  const sealedArea = el('div');
  const boardPanel = el('div', { class: 'panel' });
  const boardArea = el('div', { class: 'board-area' });
  boardPanel.appendChild(el('h2', { class: 'section-title' }, 'Board'));
  boardPanel.appendChild(boardArea);

  const seatsPanel = el('div', { class: 'panel' });
  seatsPanel.appendChild(el('h2', { class: 'section-title' }, 'Seats'));
  const seatsArea = el('div');
  seatsPanel.appendChild(seatsArea);
  const clockArea = el('div', { class: 'status-line' });
  seatsPanel.appendChild(clockArea);

  const movesPanel = el('div', { class: 'panel' });
  movesPanel.appendChild(el('h2', { class: 'section-title' }, 'Moves & activity'));
  const movesArea = el('div');
  movesPanel.appendChild(movesArea);

  const revealPanel = el('div', { class: 'panel' });
  revealPanel.appendChild(el('h2', { class: 'section-title' }, 'Reveal'));
  const revealArea = el('div');
  revealPanel.appendChild(revealArea);

  const layout = el('div', { class: 'grid-2col' });
  const left = el('div');
  left.appendChild(boardPanel);
  left.appendChild(movesPanel);
  const right = el('div');
  right.appendChild(seatsPanel);
  right.appendChild(sealedArea);
  right.appendChild(revealPanel);
  layout.appendChild(left);
  layout.appendChild(right);

  container.appendChild(errorArea);
  container.appendChild(headerArea);
  container.appendChild(layout);

  let disposed = false;
  let clockTimer = null;
  let unsubscribe = () => {};
  let revealFetched = false;

  let row = null; // GET /api/games/:id row
  let logEntries = []; // events worth showing in the move list
  let latestPublicView = null;
  let latestBoardText = null;
  let lastEventAt = null;
  let cursor = 0;

  function boardViewForRenderer() {
    if (latestPublicView && typeof latestPublicView === 'object') {
      return latestPublicView.board_text !== undefined ? latestPublicView : { ...latestPublicView, board_text: latestBoardText };
    }
    return latestBoardText ? { board_text: latestBoardText } : null;
  }

  function paintHeader() {
    if (!row) return;
    const type = pickGameType(row) ?? '?';
    const variant = pickVariant(row);
    const variantStr = variant && Object.keys(variant).length ? ` · ${JSON.stringify(variant)}` : '';
    const status = row.status ?? 'unknown';
    clear(headerArea);
    headerArea.appendChild(
      el('span', {}, [
        el('span', { class: `tag ${status === 'live' ? 'tag-live' : 'tag-ended'}` }, status),
        text(` ${type}${variantStr}`),
        pickDivision(row) ? text(` · ${pickDivision(row)}`) : text(''),
      ]),
    );

    clear(sealedArea);
    if (status === 'ended' || row.result) {
      sealedArea.appendChild(
        el('div', { class: 'sealed-marker revealed-marker' }, '✓ game ended — hidden information is revealed in the replay'),
      );
      sealedArea.appendChild(el('p', {}, el('a', { href: `#/replay/${encodeURIComponent(gameId)}` }, 'Open replay & verify →')));
      if (!revealFetched) {
        revealFetched = true;
        loadReveal();
      }
    } else {
      sealedArea.appendChild(
        el('div', { class: 'sealed-marker' }, '\u{1F512} hidden information (hands, deck order, unplayed cards) is sealed until this game ends'),
      );
    }
  }

  function paintBoardAndMoves() {
    const type = row ? pickGameType(row) : null;
    renderBoard(boardArea, type, boardViewForRenderer());
    renderMoveList(movesArea, logEntries);
    renderClock(clockArea, lastEventAt);
  }

  async function loadReveal() {
    try {
      const replay = await getReplay(gameId);
      clear(revealArea);
      revealArea.appendChild(
        el('table', { class: 'data-table' }, [
          el('tbody', {}, [
            el('tr', {}, [el('td', {}, 'commitment'), el('td', {}, String(replay.commitment ?? ''))]),
            el('tr', {}, [el('td', {}, 'drand round'), el('td', {}, String(replay.drand_round ?? ''))]),
            el('tr', {}, [el('td', {}, 'final seed'), el('td', {}, String(replay.final_seed ?? ''))]),
          ]),
        ]),
      );
    } catch (err) {
      clear(revealArea);
      revealArea.appendChild(el('p', { class: 'muted' }, `replay not yet available (${err && err.message ? err.message : err})`));
    }
  }

  function absorbEvents(events) {
    for (const ev of events) {
      if (typeof ev.seq === 'number' && ev.seq > cursor) cursor = ev.seq;
      if (ev.at) lastEventAt = ev.at;
      if (BOARD_EVENT_TYPES.has(ev.type) && ev.data) {
        if (ev.data.public !== undefined) latestPublicView = ev.data.public;
        if (typeof ev.data.board_text === 'string') latestBoardText = ev.data.board_text;
      }
      if (LOGGABLE_EVENT_TYPES.has(ev.type)) logEntries.push(ev);
    }
  }

  async function initialLoad() {
    try {
      row = await getGame(gameId);
      renderSeats(seatsArea, row && row.seats);
    } catch (err) {
      clear(errorArea);
      errorArea.appendChild(
        el('div', { class: 'error-banner' }, [el('strong', {}, 'Could not load this game. '), text(err && err.message ? err.message : String(err))]),
      );
      return;
    }
    try {
      const events = await getGameEventsSince(gameId, 0);
      absorbEvents(events);
    } catch (err) {
      clear(errorArea);
      errorArea.appendChild(
        el('div', { class: 'error-banner' }, [el('strong', {}, 'Could not load this game’s event history. '), text(err && err.message ? err.message : String(err))]),
      );
    }
    paintHeader();
    paintBoardAndMoves();
    if (disposed) return;
    unsubscribe = subscribeGameEvents(gameId, cursor, (events) => {
      absorbEvents(events);
      paintBoardAndMoves();
      // Status/result can only change via events (ended, forfeit); refresh
      // the row so the sealed/reveal panel updates promptly.
      if (events.some((e) => e.type === 'end' || e.type === 'forfeit')) {
        getGame(gameId)
          .then((r) => {
            row = r;
            paintHeader();
          })
          .catch(() => {
            /* keep showing the last known row */
          });
      }
    });
  }

  initialLoad();
  clockTimer = setInterval(() => {
    if (!disposed) renderClock(clockArea, lastEventAt);
  }, CLOCK_TICK_MS);

  return {
    dispose() {
      disposed = true;
      unsubscribe();
      if (clockTimer) clearInterval(clockTimer);
    },
  };
}
