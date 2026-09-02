// #/docket — public record of rule fixes, engine bugs, and adjudications
// (append-only), plus checkpoint and official-address panels (spec groups
// these together under api.read).
//
// Shapes (src/api/handlers.ts, src/doc.ts):
//  GET /api/docket -> { docket: [{id,kind,subject,reason,disposition,created_at}] }
//  GET /api/checkpoint -> { checkpoint: {id,tree_size,root,signature,created_at} } (latest one)
//  GET /api/official -> flat { api, front_door, openapi, mcp, mcp_read_only, spectator_window, statement }

import { el, text, clear, preJson } from '../dom.js';
import { getDocket, getCheckpoint, getOfficial } from '../api.js';

export function mount(container) {
  clear(container);
  container.appendChild(el('h1', { class: 'page-title' }, 'Docket'));
  container.appendChild(el('p', { class: 'muted' }, 'Every rule fix, engine bug, and integrity disposition, with reasons — append-only.'));

  const errorArea = el('div');
  const docketPanel = el('div', { class: 'panel' });
  docketPanel.appendChild(el('h2', { class: 'section-title' }, 'Entries'));
  const docketArea = el('div');
  docketPanel.appendChild(docketArea);

  const officialPanel = el('div', { class: 'panel' });
  officialPanel.appendChild(el('h2', { class: 'section-title' }, 'Official'));
  const officialArea = el('div');
  officialPanel.appendChild(officialArea);

  const checkpointPanel = el('div', { class: 'panel' });
  checkpointPanel.appendChild(el('h2', { class: 'section-title' }, 'Checkpoints'));
  const checkpointArea = el('div');
  checkpointPanel.appendChild(checkpointArea);

  container.appendChild(errorArea);
  container.appendChild(docketPanel);
  container.appendChild(officialPanel);
  container.appendChild(checkpointPanel);

  (async () => {
    try {
      const rows = await getDocket();
      clear(docketArea);
      if (rows.length === 0) {
        docketArea.appendChild(el('p', { class: 'empty-state' }, 'No docket entries yet.'));
      } else {
        const list = el('ul', { class: 'move-list' });
        for (const entry of rows) {
          const li = el('li', {});
          li.appendChild(el('span', { class: 'move-notation' }, String(entry.kind ?? '')));
          li.appendChild(text(` — ${entry.disposition ?? ''}`));
          li.appendChild(el('br'));
          li.appendChild(el('span', { class: 'inert-text' }, String(entry.reason ?? '')));
          li.appendChild(preJson(entry.subject ?? {}));
          list.appendChild(li);
        }
        docketArea.appendChild(list);
      }
    } catch (err) {
      errorArea.appendChild(
        el('div', { class: 'error-banner' }, [el('strong', {}, 'Could not load the docket. '), text(err && err.message ? err.message : String(err))]),
      );
    }
  })();

  (async () => {
    try {
      const official = await getOfficial();
      clear(officialArea);
      officialArea.appendChild(preJson(official));
    } catch (err) {
      clear(officialArea);
      officialArea.appendChild(el('p', { class: 'muted' }, `official record unavailable (${err && err.message ? err.message : err})`));
    }
  })();

  (async () => {
    try {
      const checkpoint = await getCheckpoint();
      clear(checkpointArea);
      if (!checkpoint) {
        checkpointArea.appendChild(el('p', { class: 'empty-state' }, 'No checkpoint signed yet.'));
        return;
      }
      checkpointArea.appendChild(
        el('table', { class: 'data-table' }, [
          el('tbody', {}, [
            el('tr', {}, [el('td', {}, 'tree_size'), el('td', {}, String(checkpoint.tree_size ?? ''))]),
            el('tr', {}, [el('td', {}, 'root'), el('td', {}, String(checkpoint.root ?? '').slice(0, 32))]),
            el('tr', {}, [el('td', {}, 'created_at'), el('td', {}, String(checkpoint.created_at ?? ''))]),
          ]),
        ]),
      );
    } catch (err) {
      clear(checkpointArea);
      checkpointArea.appendChild(el('p', { class: 'muted' }, `checkpoints unavailable (${err && err.message ? err.message : err})`));
    }
  })();

  return { dispose() {} };
}
