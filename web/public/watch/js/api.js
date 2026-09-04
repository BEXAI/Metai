// Tiny typed fetch helpers against the same-origin /api (spec §api.read).
// No key entry, no bearer secrets, no credentials — this window is spectator
// (read) only.
//
// Envelope (src/api/http.ts, T7): every enveloped response is
//   { ok: true,  data, metadata: { boundary, untrusted_fields? } }
//   { ok: false, error: { code, message }, metadata, data? }
// The /events JSON is enveloped like every other endpoint; only its SSE
// stream is raw (see src/api/handlers.ts#getGameEvents). getJson() below
// unwraps the envelope when present and returns the raw body otherwise, so
// callers never see the difference.

const JSON_HEADERS = { accept: 'application/json' };

class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message || code || `request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function getJson(path) {
  let res;
  try {
    res = await fetch(path, { headers: JSON_HEADERS, credentials: 'omit' });
  } catch (err) {
    const wrapped = new Error(`network error reaching ${path}: ${err && err.message ? err.message : err}`);
    wrapped.name = 'NetworkError';
    throw wrapped;
  }
  let body;
  try {
    body = await res.json();
  } catch {
    if (!res.ok) throw new ApiError(res.status, null, `${res.status} ${res.statusText}`.trim());
    const wrapped = new Error(`invalid JSON from ${path}`);
    wrapped.name = 'ParseError';
    throw wrapped;
  }
  if (body && typeof body === 'object' && body.ok === false) {
    const code = body.error && body.error.code;
    const message = (body.error && body.error.message) || `${res.status} ${res.statusText}`.trim();
    throw new ApiError(res.status, code, message, body.data);
  }
  if (!res.ok) {
    throw new ApiError(res.status, null, `${res.status} ${res.statusText}`.trim());
  }
  if (body && typeof body === 'object' && body.ok === true && 'data' in body) {
    return body.data;
  }
  // Unenveloped response (room-proxied /events).
  return body;
}

function qs(params) {
  const entries = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries).toString()}`;
}

/** GET /api/games?status=&game= -> array of game rows (src/api/handlers.ts#publicGame). */
export async function listGames(params = {}) {
  const data = await getJson(`/api/games${qs(params)}`);
  return Array.isArray(data && data.games) ? data.games : [];
}

/** GET /api/games/:id -> a single game row (same shape as listGames() entries). */
export async function getGame(id) {
  const data = await getJson(`/api/games/${encodeURIComponent(id)}`);
  return data && data.game;
}

/**
 * GET /api/games/:id/events?since=N -> { events, latest_seq? } either way
 * (enveloped D1 fallback or raw room proxy); returns the raw events array,
 * each normalized to { seq, type, data, at }.
 */
export async function getGameEventsSince(id, sinceSeq) {
  const data = await getJson(`/api/games/${encodeURIComponent(id)}/events?since=${encodeURIComponent(sinceSeq ?? 0)}`);
  const rawEvents = Array.isArray(data && data.events) ? data.events : [];
  return rawEvents.map(normalizeEvent);
}

/**
 * Normalizes the two shapes a spectator event can arrive in:
 *  - D1 fallback (enveloped, historical): { seq, event: { type, data, at? }, created_at }
 *  - live room proxy (raw passthrough):   { seq, type, data, at }
 * Both come from src/rooms/core.ts#emit's SpectatorEvent { seq, type, data, at }
 * (spec: notes/T6.md lists the types: start, move, timeout, strike,
 * draw_offer, draw_accept, resign, forfeit, end, reveal).
 */
export function normalizeEvent(raw) {
  if (raw && typeof raw === 'object') {
    if (raw.event && typeof raw.event === 'object') {
      return { seq: raw.seq, type: raw.event.type, data: raw.event.data ?? null, at: raw.event.at ?? raw.created_at ?? null };
    }
    if ('type' in raw) {
      return { seq: raw.seq, type: raw.type, data: raw.data ?? null, at: raw.at ?? null };
    }
  }
  return { seq: raw && raw.seq, type: undefined, data: null, at: null };
}

/** GET /api/games/:id/replay -> ReplayFile (src/kernel/replay.ts, frozen shape). */
export async function getReplay(id) {
  const data = await getJson(`/api/games/${encodeURIComponent(id)}/replay`);
  return data && data.replay;
}

/** GET /api/agents/:handle -> { agent, homologations, ratings, record }. */
export function getAgent(handle) {
  return getJson(`/api/agents/${encodeURIComponent(handle)}`);
}

/** GET /api/leaderboards?... -> { filters, leaderboard }. */
export function getLeaderboards(params = {}) {
  return getJson(`/api/leaderboards${qs(params)}`);
}

/** GET /api/rules/:game -> flat { game, name, players, ..., rules_card }. */
export function getRules(game) {
  return getJson(`/api/rules/${encodeURIComponent(game)}`);
}

/** GET /api/docket -> { docket: [...] }. */
export async function getDocket() {
  const data = await getJson('/api/docket');
  return Array.isArray(data && data.docket) ? data.docket : [];
}

/** GET /api/checkpoint -> { checkpoint: {...} } (most recent one, singular). */
export async function getCheckpoint() {
  const data = await getJson('/api/checkpoint');
  return data && data.checkpoint;
}

/** GET /api/official -> flat official-addresses document (src/doc.ts#officialDoc). */
export function getOfficial() {
  return getJson('/api/official');
}

/** Frame names an older, pre-unnamed-frame room might still send. */
const KNOWN_SSE_TYPES = [
  'start', 'move', 'timeout', 'strike', 'resign', 'draw_offer', 'draw_accept', 'forfeit', 'submitted', 'end', 'reveal',
];

/**
 * Subscribe to a game's public spectator event stream. Prefers SSE
 * (EventSource against /api/games/:id/events) and falls back to polling the
 * same endpoint with ?since=<seq> when SSE is unavailable or fails.
 *
 * onEvents(events) is called with each new batch of NORMALIZED
 * { seq, type, data, at } events, in order.
 * onStatus(state: 'sse'|'polling'|'error'|'sse-unavailable', detail?) is
 * optional, for a small connection indicator in the UI.
 *
 * Returns a dispose() function that stops the stream/poll loop.
 */
export function subscribeGameEvents(gameId, sinceSeq, onEvents, onStatus) {
  let closed = false;
  let pollTimer = null;
  let es = null;
  let cursor = Number.isFinite(sinceSeq) ? sinceSeq : 0;
  const notifyStatus = (s, d) => {
    if (typeof onStatus === 'function') onStatus(s, d);
  };

  function bumpCursor(events) {
    for (const e of events) {
      if (e && typeof e.seq === 'number' && e.seq > cursor) cursor = e.seq;
    }
  }

  /**
   * The ONE delivery path, idempotent by seq. Both the SSE listeners and the
   * polling fallback go through here, so an event that arrives twice — a
   * belt-and-braces listener firing alongside 'message', or a poll racing a
   * frame — is delivered to the page exactly once.
   */
  function emit(events) {
    const fresh = events.filter((e) => e && typeof e.seq === 'number' && e.seq > cursor);
    if (fresh.length === 0) return;
    bumpCursor(fresh);
    onEvents(fresh);
  }

  function schedulePoll(delayMs) {
    if (closed) return;
    pollTimer = setTimeout(poll, delayMs);
  }

  async function poll() {
    if (closed) return;
    try {
      emit(await getGameEventsSince(gameId, cursor));
      notifyStatus('polling');
    } catch (err) {
      notifyStatus('error', err);
    }
    schedulePoll(3000);
  }

  function startPolling() {
    if (pollTimer !== null || closed) return;
    notifyStatus('polling');
    poll();
  }

  function startSse() {
    if (typeof EventSource !== 'function') {
      startPolling();
      return;
    }
    try {
      es = new EventSource(`/api/games/${encodeURIComponent(gameId)}/events?since=${encodeURIComponent(cursor)}`);
    } catch {
      startPolling();
      return;
    }
    let announcedOpen = false;
    es.addEventListener('open', () => {
      announcedOpen = true;
      notifyStatus('sse');
    });
    const onFrame = (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        const events = (Array.isArray(payload) ? payload : Array.isArray(payload && payload.events) ? payload.events : [payload]).map(normalizeEvent);
        emit(events);
      } catch {
        // malformed SSE payload — ignore this message, keep the connection
      }
    };
    es.addEventListener('message', onFrame);
    // Belt and braces. The room sends UNNAMED frames (src/rooms/room.ts
    // #sseFrame), which arrive as 'message' — but a room deployed before that
    // change still names them, and EventSource silently drops a named frame
    // with no matching listener. Registering the known names as well means an
    // older room streams instead of falling back to 3-second polling. Frames
    // are de-duplicated by seq, so a frame that somehow reaches both paths is
    // delivered once. `game:*` is deliberately absent: it is open-ended and
    // cannot be enumerated, which is why the frames are unnamed now.
    for (const type of KNOWN_SSE_TYPES) es.addEventListener(type, onFrame);
    es.addEventListener('error', () => {
      if (es) {
        es.close();
        es = null;
      }
      notifyStatus(announcedOpen ? 'error' : 'sse-unavailable');
      startPolling();
    });
  }

  startSse();

  return function dispose() {
    closed = true;
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (es) {
      es.close();
      es = null;
    }
  };
}

export { ApiError };
