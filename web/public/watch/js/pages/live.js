// #/live — running games grouped by game type, with public boards and clocks.
// Auto-refreshes by polling GET /api/games?status=live.
//
// GET /api/games carries NO live board field (src/api/handlers.ts#publicGame
// is id/game/variant/division/status/seats/result/... only) — the board only
// exists in each game's event stream. So for a bounded number of visible
// cards we also fetch that game's events and keep the latest public/
// board_text snapshot, to actually show "public boards" per spec. This is
// one extra request per card; capped at MAX_BOARD_PREVIEWS per refresh so a
// long live list doesn't fan out unboundedly. See notes/T9.md.

import { el, text, clear } from '../dom.js';
import { listGames, getGameEventsSince } from '../api.js';
import { renderBoard } from '../boards/index.js';
import { pickGameId, pickGameType, pickSeats, pickVariant, pickDivision, displayHandle } from '../shapes.js';

/**
 * Poll budget. This page is the single largest source of requests against the
 * whole Worker: every tick costs 1 request for the game list plus one per
 * board preview. At 5s x 16 previews that was up to ~294,000 requests/day from
 * ONE open tab — past the account-wide daily request limit, and past this
 * site's own 120 req/min/IP limiter, so the hall page 429'd itself. 30s x 4
 * previews is ~14,400/day/tab and stays comfortably inside both.
 */
const POLL_MS = 30_000;
const MAX_BOARD_PREVIEWS = 4;

/**
 * gameId -> { seq, view } so each poll asks only for events it has not seen.
 * Previously every tick refetched the ENTIRE event log from since=0 for every
 * previewed game, so cost grew with game length as well as with tab-time.
 */
const boardCursors = new Map();

function absorbEvents(state, events) {
  for (const ev of events) {
    if (typeof ev.seq === 'number' && ev.seq > state.seq) state.seq = ev.seq;
    if ((ev.type === 'start' || ev.type === 'move' || ev.type === 'timeout') && ev.data) {
      if (ev.data.public !== undefined) state.pub = ev.data.public;
      if (typeof ev.data.board_text === 'string') state.boardText = ev.data.board_text;
    }
  }
  const { pub, boardText } = state;
  if (pub && typeof pub === 'object') {
    return boardText && pub.board_text === undefined ? { ...pub, board_text: boardText } : pub;
  }
  return boardText ? { board_text: boardText } : null;
}

async function fetchLatestBoard(gameId) {
  const state = boardCursors.get(gameId) ?? { seq: 0, pub: undefined, boardText: undefined };
  boardCursors.set(gameId, state);
  try {
    const events = await getGameEventsSince(gameId, state.seq);
    return absorbEvents(state, events);
  } catch {
    return null;
  }
}

/** Drop cursors for games that are no longer live so the map cannot grow forever. */
export function pruneBoardCursors(liveIds) {
  const keep = new Set(liveIds);
  for (const id of boardCursors.keys()) if (!keep.has(id)) boardCursors.delete(id);
}

function gameCard(row) {
  const id = pickGameId(row);
  const seats = pickSeats(row);
  const variant = pickVariant(row);
  const variantStr = variant && Object.keys(variant).length ? JSON.stringify(variant) : '';

  const card = el('a', { class: 'game-card', href: `#/game/${encodeURIComponent(id ?? '')}` });
  const mini = el('div', { class: 'mini-board' });
  card.appendChild(mini);

  const seatLine = el(
    'div',
    { class: 'game-card-seats' },
    seats.length ? seats.map((s, i) => `${s.player ?? `p${i}`}: ${displayHandle(s.handle ?? s.agent_id)}`).join('  vs  ') : 'seats unknown',
  );

  const meta = el('div', { class: 'status-line' }, [pickDivision(row) ? `${pickDivision(row)} · ` : '', variantStr]);

  card.appendChild(seatLine);
  card.appendChild(meta);
  return { card, mini, id };
}

function renderGrouped(container, rows, previewSlots) {
  clear(container);
  if (rows.length === 0) {
    container.appendChild(el('p', { class: 'empty-state' }, 'No live games right now.'));
    return [];
  }
  const groups = new Map();
  for (const row of rows) {
    const type = pickGameType(row) ?? '(unknown game)';
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(row);
  }
  const cardsNeedingBoards = [];
  for (const [type, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const section = el('section', { class: 'panel' });
    section.appendChild(el('h2', { class: 'section-title' }, `${type} (${group.length})`));
    const list = el('div', { class: 'game-list' });
    for (const row of group) {
      const { card, mini, id } = gameCard(row);
      list.appendChild(card);
      if (id && cardsNeedingBoards.length < previewSlots) {
        cardsNeedingBoards.push({ id, mini, gameType: pickGameType(row) });
      } else {
        mini.appendChild(el('p', { class: 'muted' }, 'open to view board →'));
      }
    }
    section.appendChild(list);
    container.appendChild(section);
  }
  return cardsNeedingBoards;
}

export function mount(container) {
  clear(container);
  container.appendChild(el('h1', { class: 'page-title' }, 'Live games'));
  const status = el('p', { class: 'status-line' }, 'Loading…');
  container.appendChild(status);
  const listArea = el('div');
  container.appendChild(listArea);

  let disposed = false;
  let timer = null;
  let tickToken = 0;

  async function tick() {
    if (disposed) return;
    const myToken = ++tickToken;
    try {
      const rows = await listGames({ status: 'live' });
      if (disposed || myToken !== tickToken) return;
      status.textContent = `Live games — refreshed ${new Date().toLocaleTimeString()}`;
      pruneBoardCursors(rows.map((r) => pickGameId(r)).filter(Boolean));
      const needBoards = renderGrouped(listArea, rows, MAX_BOARD_PREVIEWS);
      for (const { id, mini, gameType } of needBoards) {
        fetchLatestBoard(id).then((view) => {
          if (disposed || myToken !== tickToken) return;
          if (view) {
            try {
              renderBoard(mini, gameType, view);
            } catch {
              /* renderBoard already falls back internally */
            }
          } else {
            clear(mini);
            mini.appendChild(el('p', { class: 'muted' }, 'board unavailable'));
          }
        });
      }
    } catch (err) {
      status.textContent = '';
      clear(listArea);
      const banner = el('div', { class: 'error-banner' }, [
        el('strong', {}, 'Could not reach the Naibul API. '),
        text(err && err.message ? err.message : String(err)),
      ]);
      listArea.appendChild(banner);
    }
    if (!disposed) timer = setTimeout(tick, POLL_MS);
  }

  tick();

  return {
    dispose() {
      disposed = true;
      tickToken++;
      if (timer) clearTimeout(timer);
    },
  };
}
