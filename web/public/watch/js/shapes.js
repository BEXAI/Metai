// Small shared accessors used across pages/board renderers. Field names below
// are the REAL shapes as landed (src/api/handlers.ts for API rows,
// src/rooms/core.ts for event data, individual src/games/<id>/index.ts for
// publicView) — verified by reading those files, not guessed. A couple of
// spots stay defensive (marked below) because the game tracks were still
// landing when this was written; see notes/T9.md.

function firstDefined(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

// --- GET /api/games and GET /api/games/:id rows (src/api/handlers.ts#publicGame) --

export function pickGameId(row) {
  return row && row.id;
}
export function pickGameType(row) {
  return row && row.game;
}
export function pickVariant(row) {
  return (row && row.variant) || {};
}
export function pickDivision(row) {
  return row && row.division;
}
/** Seats: [{ player, agent_id, handle, pubkey_ed25519 }] — same shape as ReplaySeat. */
export function pickSeats(row) {
  return Array.isArray(row && row.seats) ? row.seats : [];
}

// --- board_text fallback (present on spectator-event `data`, not on the row) --

export function pickBoardText(view) {
  const v = firstDefined(view, ['board_text', 'boardText']);
  return typeof v === 'string' ? v : undefined;
}

// --- defensive helpers still used by board renderers whose exact per-game
// shape can vary slightly (chinese_checkers/backgammon point-list keys,
// generic owner-field extraction) --------------------------------------

/** A flat list of point-like entries (chinese-checkers pegs, backgammon points). */
export function pickPointList(view, keys) {
  for (const key of keys) {
    const v = view && view[key];
    if (Array.isArray(v) && v.length > 0) return v;
    if (v && typeof v === 'object' && Object.keys(v).length > 0) {
      return Object.entries(v).map(([label, value]) => ({ label, ...(typeof value === 'object' && value ? value : { owner: value }) }));
    }
  }
  return undefined;
}

export function ownerOf(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string' || typeof entry === 'number') return entry;
  return firstDefined(entry, ['owner', 'player', 'player_id', 'playerId', 'color', 'piece']);
}

/** Best-effort agent display name: prefer a handle, fall back to an id. */
export function displayHandle(agentLike) {
  if (!agentLike) return '(unknown)';
  if (typeof agentLike === 'string') return agentLike;
  return firstDefined(agentLike, ['handle', 'agent_handle', 'agent_id', 'id']) ?? '(unknown)';
}
