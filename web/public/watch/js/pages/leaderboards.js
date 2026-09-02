// #/leaderboards — by game, variant, division, season. Filters are <select>
// controls (no key entry anywhere); the current filter set lives in the hash
// query string so a leaderboard view is linkable.
//
// Shape: GET /api/leaderboards -> { filters, leaderboard: [{ rank, agent_id,
// handle, game, variant, division, season_id, rating, rd, volatility,
// games_played, provisional, updated_at }] } (src/api/handlers.ts).

import { el, text, clear } from '../dom.js';
import { getLeaderboards } from '../api.js';

const GAME_IDS = [
  'tictactoe', 'connect_drop', 'chess', 'checkers', 'reversi', 'hex', 'nine_mens_morris',
  'go', 'chinese_checkers', 'backgammon', 'landlord', 'islanders',
];
const DIVISIONS = ['pure', 'open'];

function select(id, options, current, labelText) {
  const wrapper = el('label', {}, labelText ? `${labelText} ` : '');
  const sel = el('select', { id, name: id });
  sel.appendChild(el('option', { value: '' }, 'any'));
  for (const opt of options) {
    const optEl = el('option', { value: opt }, opt);
    if (opt === current) optEl.setAttribute('selected', '');
    sel.appendChild(optEl);
  }
  wrapper.appendChild(sel);
  return { wrapper, sel };
}

function updateHash(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const query = qs.toString();
  location.hash = `#/leaderboards${query ? `?${query}` : ''}`;
}

export function mount(container, params, query) {
  clear(container);
  container.appendChild(el('h1', { class: 'page-title' }, 'Leaderboards'));

  const current = {
    game: query.get('game') || '',
    variant: query.get('variant') || '',
    division: query.get('division') || '',
    season: query.get('season') || '',
  };

  const filterRow = el('div', { class: 'filter-row' });
  const game = select('lb-game', GAME_IDS, current.game, 'game');
  const division = select('lb-division', DIVISIONS, current.division, 'division');
  filterRow.appendChild(game.wrapper);
  filterRow.appendChild(division.wrapper);
  const applyBtn = el('button', {}, 'Apply');
  filterRow.appendChild(applyBtn);
  container.appendChild(filterRow);

  applyBtn.addEventListener('click', () => {
    updateHash({ game: game.sel.value, division: division.sel.value, variant: current.variant, season: current.season });
  });

  const errorArea = el('div');
  const tableArea = el('div', { class: 'panel' });
  container.appendChild(errorArea);
  container.appendChild(tableArea);

  (async () => {
    try {
      const params2 = {};
      if (current.game) params2.game = current.game;
      if (current.variant) params2.variant = current.variant;
      if (current.division) params2.division = current.division;
      if (current.season) params2.season = current.season;
      const data = await getLeaderboards(params2);
      const rows = Array.isArray(data && data.leaderboard) ? data.leaderboard : [];
      clear(tableArea);
      if (rows.length === 0) {
        tableArea.appendChild(el('p', { class: 'empty-state' }, 'No ratings yet for this filter.'));
        return;
      }
      tableArea.appendChild(
        el('table', { class: 'data-table' }, [
          el(
            'thead',
            {},
            el('tr', {}, [
              el('th', {}, 'rank'),
              el('th', {}, 'handle'),
              el('th', {}, 'game'),
              el('th', {}, 'division'),
              el('th', {}, 'rating'),
              el('th', {}, 'rd'),
              el('th', {}, 'games'),
            ]),
          ),
          el(
            'tbody',
            {},
            rows.map((r) => {
              const handle = r.handle ?? r.agent_id ?? '?';
              return el('tr', {}, [
                el('td', {}, String(r.rank ?? '')),
                el('td', {}, el('a', { href: `#/agents/${encodeURIComponent(handle)}` }, String(handle))),
                el('td', {}, String(r.game ?? '')),
                el('td', {}, String(r.division ?? '')),
                el('td', {}, `${r.rating ?? ''}${r.provisional ? ' (provisional)' : ''}`),
                el('td', {}, String(r.rd ?? '')),
                el('td', {}, String(r.games_played ?? '')),
              ]);
            }),
          ),
        ]),
      );
    } catch (err) {
      clear(tableArea);
      errorArea.appendChild(
        el('div', { class: 'error-banner' }, [el('strong', {}, 'Could not load leaderboards. '), text(err && err.message ? err.message : String(err))]),
      );
    }
  })();

  return { dispose() {} };
}
