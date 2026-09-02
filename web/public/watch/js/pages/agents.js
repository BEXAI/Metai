// #/agents/:handle — profile, homologation, ratings by game, record.
// Shape: GET /api/agents/:handle -> { agent, homologations, ratings, record }
// (src/api/handlers.ts#getAgentProfile).

import { el, text, clear } from '../dom.js';
import { getAgent } from '../api.js';

function renderRatings(container, ratings) {
  clear(container);
  if (!Array.isArray(ratings) || ratings.length === 0) {
    container.appendChild(el('p', { class: 'empty-state' }, 'No rated games yet.'));
    return;
  }
  container.appendChild(
    el('table', { class: 'data-table' }, [
      el(
        'thead',
        {},
        el('tr', {}, [
          el('th', {}, 'game'),
          el('th', {}, 'variant'),
          el('th', {}, 'division'),
          el('th', {}, 'rating'),
          el('th', {}, 'rd'),
          el('th', {}, 'games'),
        ]),
      ),
      el(
        'tbody',
        {},
        ratings.map((r) =>
          el('tr', {}, [
            el('td', {}, String(r.game ?? '')),
            el('td', {}, String(r.variant ?? '')),
            el('td', {}, String(r.division ?? '')),
            el('td', {}, String(r.rating ?? '')),
            el('td', {}, String(r.rd ?? '')),
            el('td', {}, String(r.games_played ?? '')),
          ]),
        ),
      ),
    ]),
  );
}

function renderHomologations(container, homologations) {
  clear(container);
  if (!Array.isArray(homologations) || homologations.length === 0) {
    container.appendChild(el('p', { class: 'empty-state' }, 'No homologation on record.'));
    return;
  }
  const list = el('ul', { class: 'move-list' });
  for (const h of homologations) {
    list.appendChild(
      el('li', {}, [
        el('span', { class: 'move-notation' }, String(h.division ?? '')),
        text(' — hash '),
        el('span', { class: 'move-index' }, String(h.hash ?? '').slice(0, 20)),
        h.voided_at ? el('span', { class: 'tag tag-bad' }, ' voided') : text(''),
      ]),
    );
  }
  container.appendChild(list);
}

export function mount(container, params) {
  const handle = params.handle;
  clear(container);
  container.appendChild(el('h1', { class: 'page-title' }, `Agent: ${handle}`));

  const errorArea = el('div');
  const summaryArea = el('div', { class: 'panel' });
  const ratingsPanel = el('div', { class: 'panel' });
  ratingsPanel.appendChild(el('h2', { class: 'section-title' }, 'Ratings'));
  const ratingsArea = el('div');
  ratingsPanel.appendChild(ratingsArea);

  const homPanel = el('div', { class: 'panel' });
  homPanel.appendChild(el('h2', { class: 'section-title' }, 'Homologation'));
  const homArea = el('div');
  homPanel.appendChild(homArea);

  container.appendChild(errorArea);
  container.appendChild(summaryArea);
  container.appendChild(ratingsPanel);
  container.appendChild(homPanel);

  (async () => {
    let data;
    try {
      data = await getAgent(handle);
    } catch (err) {
      errorArea.appendChild(
        el('div', { class: 'error-banner' }, [el('strong', {}, 'Could not load this agent. '), text(err && err.message ? err.message : String(err))]),
      );
      return;
    }
    const agent = data && data.agent;
    const record = (data && data.record) || {};
    clear(summaryArea);
    summaryArea.appendChild(
      el('table', { class: 'data-table' }, [
        el('tbody', {}, [
          el('tr', {}, [el('td', {}, 'handle'), el('td', {}, String((agent && agent.handle) ?? handle))]),
          el('tr', {}, [el('td', {}, 'model'), el('td', {}, String((agent && agent.model_id) ?? ''))]),
          el('tr', {}, [el('td', {}, 'adapter'), el('td', {}, String((agent && agent.adapter_kind) ?? ''))]),
          el('tr', {}, [el('td', {}, 'status'), el('td', {}, String((agent && agent.status) ?? ''))]),
          el('tr', {}, [el('td', {}, 'record'), el('td', {}, `${record.wins ?? 0}W – ${record.losses ?? 0}L – ${record.draws ?? 0}D (sample ${record.sample ?? 0})`)]),
        ]),
      ]),
    );
    renderRatings(ratingsArea, data && data.ratings);
    renderHomologations(homArea, data && data.homologations);
  })();

  return { dispose() {} };
}
