// #/replay/:id — step through a game's signed, hash-chained log and verify it
// in the browser. ReplayFile shape is frozen in src/kernel/replay.ts, so this
// page (unlike the live game page) can rely on exact field names.

import { el, text, clear, preJson } from '../dom.js';
import { getReplay } from '../api.js';
import { renderBoard } from '../boards/index.js';

function short(hexOrStr, n = 16) {
  const s = String(hexOrStr ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function ensureVerifier() {
  if (typeof window.naibulVerify === 'function') return true;
  try {
    await import('/watch/verify-entry.js');
  } catch {
    return false;
  }
  return typeof window.naibulVerify === 'function';
}

function renderResult(result) {
  if (!result) return el('span', { class: 'muted' }, 'in progress');
  const parts = [];
  if (result.draw) parts.push('draw');
  if (Array.isArray(result.winners) && result.winners.length) parts.push(`winners: ${result.winners.join(', ')}`);
  if (result.reason) parts.push(`(${result.reason})`);
  return el('span', {}, parts.join(' ') || 'unknown');
}

function renderSeatsTable(seats) {
  const rows = (seats || []).map((s) =>
    el('tr', {}, [
      el('td', {}, String(s.player ?? '')),
      el('td', {}, el('a', { href: `#/agents/${encodeURIComponent(s.handle ?? s.agent_id ?? '')}` }, String(s.handle ?? s.agent_id ?? ''))),
      el('td', {}, short(s.pubkey_ed25519, 20)),
    ]),
  );
  return el('table', { class: 'data-table' }, [
    el('thead', {}, el('tr', {}, [el('th', {}, 'player'), el('th', {}, 'agent'), el('th', {}, 'pubkey')])),
    el('tbody', {}, rows),
  ]);
}

function logEntrySummary(entry) {
  const payload = entry.payload || {};
  const bits = [`seq ${entry.seq}`, entry.kind];
  if (typeof payload.turn_index === 'number') bits.push(`turn ${payload.turn_index}`);
  if (payload.player) bits.push(String(payload.player));
  if (payload.notation) bits.push(String(payload.notation));
  return bits.join(' · ');
}

function renderStepDetail(container, entry, prevOk) {
  clear(container);
  if (!entry) {
    container.appendChild(el('p', { class: 'empty-state' }, 'No log entries.'));
    return;
  }
  const payload = entry.payload || {};
  container.appendChild(
    el('table', { class: 'data-table' }, [
      el('tbody', {}, [
        el('tr', {}, [el('td', {}, 'seq'), el('td', {}, String(entry.seq))]),
        el('tr', {}, [el('td', {}, 'kind'), el('td', {}, String(entry.kind))]),
        el('tr', {}, [el('td', {}, 'hash'), el('td', {}, short(entry.hash, 24))]),
        el('tr', {}, [
          el('td', {}, 'prev_hash chains'),
          el('td', {}, [el('span', { class: `tag ${prevOk ? 'tag-ok' : 'tag-bad'}` }, prevOk ? 'ok' : 'mismatch')]),
        ]),
        el('tr', {}, [el('td', {}, 'signed'), el('td', {}, entry.signature ? 'yes' : 'no')]),
        el('tr', {}, [el('td', {}, 'created_at'), el('td', {}, String(entry.created_at ?? ''))]),
      ]),
    ]),
  );
  if (payload.commentary || payload.note) {
    const commentary = payload.commentary || payload.note;
    container.appendChild(el('p', { class: 'section-title' }, 'commentary (untrusted, rendered as data)'));
    const p = el('p', { class: 'inert-text' });
    p.appendChild(text(commentary));
    container.appendChild(p);
  }
  container.appendChild(el('p', { class: 'section-title' }, 'payload'));
  container.appendChild(preJson(payload));
}

export function mount(container, params) {
  const gameId = params.id;
  clear(container);
  container.appendChild(el('h1', { class: 'page-title' }, `Replay ${gameId}`));

  const errorArea = el('div');
  const summaryArea = el('div', { class: 'panel' });
  const boardPanel = el('div', { class: 'panel' });
  const boardArea = el('div', { class: 'board-area' });
  boardPanel.appendChild(el('h2', { class: 'section-title' }, 'Initial position'));
  boardPanel.appendChild(boardArea);
  boardPanel.appendChild(el('p', { class: 'muted' }, 'Rendered from the raw initial state, best-effort — the authoritative record is the log below and the verify report.'));

  const stepPanel = el('div', { class: 'panel' });
  stepPanel.appendChild(el('h2', { class: 'section-title' }, 'Step through the log'));
  const stepControls = el('div', { class: 'step-controls' });
  const prevBtn = el('button', {}, '← prev');
  const nextBtn = el('button', {}, 'next →');
  const posLabel = el('span', { class: 'status-line' }, '');
  const slider = el('input', { type: 'range', min: '0', max: '0', value: '0' });
  stepControls.appendChild(prevBtn);
  stepControls.appendChild(slider);
  stepControls.appendChild(nextBtn);
  stepPanel.appendChild(stepControls);
  stepPanel.appendChild(posLabel);
  const stepSummary = el('div', { class: 'status-line' });
  stepPanel.appendChild(stepSummary);
  const stepDetail = el('div');
  stepPanel.appendChild(stepDetail);

  const verifyPanel = el('div', { class: 'panel' });
  verifyPanel.appendChild(el('h2', { class: 'section-title' }, 'Verify'));
  const verifyBtn = el('button', {}, 'Run offline verifier in this browser');
  const verifyStatus = el('div', { class: 'status-line' });
  const verifyReport = el('div', { class: 'verify-report' });
  verifyPanel.appendChild(verifyBtn);
  verifyPanel.appendChild(verifyStatus);
  verifyPanel.appendChild(verifyReport);

  const seatsPanel = el('div', { class: 'panel' });
  seatsPanel.appendChild(el('h2', { class: 'section-title' }, 'Seats'));
  const seatsArea = el('div');
  seatsPanel.appendChild(seatsArea);

  const revealPanel = el('div', { class: 'panel' });
  revealPanel.appendChild(el('h2', { class: 'section-title' }, 'Commit / reveal'));
  const revealArea = el('div');
  revealPanel.appendChild(revealArea);

  const layout = el('div', { class: 'grid-2col' });
  const left = el('div');
  left.appendChild(summaryArea);
  left.appendChild(boardPanel);
  left.appendChild(stepPanel);
  const right = el('div');
  right.appendChild(seatsPanel);
  right.appendChild(revealPanel);
  right.appendChild(verifyPanel);
  layout.appendChild(left);
  layout.appendChild(right);

  container.appendChild(errorArea);
  container.appendChild(layout);

  let replay = null;

  function paintSummary() {
    clear(summaryArea);
    summaryArea.appendChild(
      el('table', { class: 'data-table' }, [
        el('tbody', {}, [
          el('tr', {}, [el('td', {}, 'game'), el('td', {}, String(replay.game ?? replay.game_id))]),
          el('tr', {}, [el('td', {}, 'variant'), el('td', {}, JSON.stringify(replay.variant ?? {}))]),
          el('tr', {}, [el('td', {}, 'division'), el('td', {}, String(replay.division ?? ''))]),
          el('tr', {}, [el('td', {}, 'ruleset_version'), el('td', {}, String(replay.ruleset_version ?? ''))]),
          el('tr', {}, [el('td', {}, 'result'), el('td', {}, renderResult(replay.result))]),
          el('tr', {}, [el('td', {}, 'log entries'), el('td', {}, String((replay.log || []).length))]),
        ]),
      ]),
    );
  }

  function paintReveal() {
    clear(revealArea);
    revealArea.appendChild(
      el('table', { class: 'data-table' }, [
        el('tbody', {}, [
          el('tr', {}, [el('td', {}, 'commitment'), el('td', {}, short(replay.commitment, 24))]),
          el('tr', {}, [el('td', {}, 'drand round'), el('td', {}, String(replay.drand_round ?? ''))]),
          el('tr', {}, [el('td', {}, 'drand randomness'), el('td', {}, short(replay.drand_randomness, 24))]),
          el('tr', {}, [el('td', {}, 'reveal secret'), el('td', {}, short(replay.reveal_secret, 24))]),
          el('tr', {}, [el('td', {}, 'final seed'), el('td', {}, short(replay.final_seed, 24))]),
        ]),
      ]),
    );
  }

  function step(index) {
    const log = replay.log || [];
    const clamped = Math.max(0, Math.min(log.length - 1, index));
    slider.value = String(clamped);
    const entry = log[clamped];
    posLabel.textContent = log.length ? `step ${clamped + 1} / ${log.length}` : 'no log entries';
    stepSummary.textContent = entry ? logEntrySummary(entry) : '';
    const prev = log[clamped - 1];
    const expectedPrevHash = prev ? prev.hash : '0'.repeat(64);
    const prevOk = !entry || entry.prev_hash === expectedPrevHash;
    renderStepDetail(stepDetail, entry, prevOk);
  }

  function wireStepControls() {
    const log = replay.log || [];
    slider.max = String(Math.max(0, log.length - 1));
    slider.addEventListener('input', () => step(Number(slider.value)));
    prevBtn.addEventListener('click', () => step(Number(slider.value) - 1));
    nextBtn.addEventListener('click', () => step(Number(slider.value) + 1));
    step(0);
  }

  function renderVerifyReport(report) {
    clear(verifyReport);
    if (!report) return;
    const overall = el('p', {}, [
      el('span', { class: `tag ${report.ok ? 'tag-ok' : 'tag-bad'}` }, report.ok ? 'VERIFIED' : 'FAILED'),
    ]);
    verifyReport.appendChild(overall);
    if (window.naibulVerifyPartial) {
      verifyReport.appendChild(
        el('div', { class: 'partial-banner' }, [
          el('span', { class: 'tag tag-partial' }, 'partial verify'),
          text(' — the full kernel verifier was not available at build time; only the hash chain was checked, not game-state recomputation. Integration should re-run web/build.sh once src/kernel/verify.ts lands.'),
        ]),
      );
    }
    for (const check of report.checks || []) {
      verifyReport.appendChild(
        el('div', { class: 'verify-check' }, [
          el('span', { class: `tag ${check.ok ? 'tag-ok' : 'tag-bad'}` }, check.ok ? 'ok' : 'fail'),
          el('strong', {}, String(check.name)),
          check.detail ? text(` — ${check.detail}`) : text(''),
        ]),
      );
    }
  }

  verifyBtn.addEventListener('click', async () => {
    verifyStatus.textContent = 'Loading verifier…';
    clear(verifyReport);
    const available = await ensureVerifier();
    if (!available) {
      verifyStatus.textContent = 'Verifier bundle unavailable (see /verify-entry.js) — cannot verify in this browser right now.';
      return;
    }
    verifyStatus.textContent = 'Verifying…';
    try {
      const report = await window.naibulVerify(replay);
      verifyStatus.textContent = '';
      renderVerifyReport(report);
    } catch (err) {
      verifyStatus.textContent = `Verifier threw: ${err && err.message ? err.message : err}`;
    }
  });

  function paintSeats() {
    clear(seatsArea);
    seatsArea.appendChild(renderSeatsTable(replay.seats));
  }

  (async () => {
    try {
      replay = await getReplay(gameId);
    } catch (err) {
      clear(errorArea);
      errorArea.appendChild(
        el('div', { class: 'error-banner' }, [el('strong', {}, 'Could not load this replay. '), text(err && err.message ? err.message : String(err))]),
      );
      return;
    }
    paintSummary();
    paintReveal();
    paintSeats();
    renderBoard(boardArea, replay.game ?? replay.game_id, replay.initial_state);
    wireStepControls();
  })();

  return { dispose() {} };
}
