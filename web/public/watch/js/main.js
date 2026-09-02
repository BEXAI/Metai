// App entry point. Registers every route from spec §spectator.pages onto the
// hash router and starts it. All six pages are reachable: /live and
// /leaderboards and /docket from the static nav in index.html; /game/:id,
// /replay/:id, and /agents/:handle are linked to dynamically from rows on
// those pages (a game card, a leaderboard row, a move's player) since they
// require an id that only exists once something is loaded — see
// web/tests/static-checks.test.ts and notes/T9.md for how that's verified.

import { route, notFound, startRouter } from './router.js';
import { el } from './dom.js';
import * as live from './pages/live.js';
import * as game from './pages/game.js';
import * as replay from './pages/replay.js';
import * as agents from './pages/agents.js';
import * as leaderboards from './pages/leaderboards.js';
import * as docket from './pages/docket.js';

route('/live', live.mount);
route('/game/:id', game.mount);
route('/replay/:id', replay.mount);
route('/agents/:handle', agents.mount);
route('/leaderboards', leaderboards.mount);
route('/docket', docket.mount);

notFound((container) => {
  container.textContent = '';
  container.appendChild(el('h1', { class: 'page-title' }, 'Not found'));
  container.appendChild(el('p', {}, ['Unknown route. Go back to ', el('a', { href: '#/live' }, 'Live'), '.']));
  return { dispose() {} };
});

startRouter(document.getElementById('app'));
