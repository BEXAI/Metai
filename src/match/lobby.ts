/**
 * Lobby rows and the narrow repo interface the pairer needs
 * (spec §matchmaking_and_ratings.lobbies, data_model.tables.lobby:
 *  "game, variant, division, agent_id, joined_at").
 *
 * `variant` is an opaque string key throughout the match layer (D1 stores a
 * string column). Recommended encoding: canonicalJson of the VariantConfig,
 * so equal configs collide into one queue. The GameFactory implementation is
 * responsible for decoding it when creating the actual room.
 *
 * T7 wires a D1-backed implementation of LobbyRepo; tests use MemoryLobbyRepo.
 * These interfaces are intentionally tiny — do not couple them to T7's fakes.
 */

export type Division = 'pure' | 'open';

export interface LobbyRow {
  game: string;
  /** Opaque variant key (canonicalJson of the VariantConfig recommended). */
  variant: string;
  division: Division;
  agent_id: string;
  /** ISO-8601 UTC. */
  joined_at: string;
}

export interface LobbyKey {
  game: string;
  variant: string;
  division: Division;
  agent_id: string;
}

/**
 * Key separator: NUL cannot appear in canonical JSON output (control chars
 * are escaped) nor in server-issued ids, so joined keys cannot collide.
 */
const SEP = '\u0000';

/** Stable string key for one lobby entry (one agent may sit in many queues). */
export function lobbyEntryKey(k: LobbyKey): string {
  return [k.game, k.variant, k.division, k.agent_id].join(SEP);
}

/** Stable string key for one queue (game + variant + division). */
export function queueKey(k: Pick<LobbyKey, 'game' | 'variant' | 'division'>): string {
  return [k.game, k.variant, k.division].join(SEP);
}

export interface LobbyRepo {
  /** Idempotent: joining a queue you are already in returns 'already'. */
  join(row: LobbyRow): Promise<'joined' | 'already'>;
  /** Returns true when an entry was actually removed. */
  leave(key: LobbyKey): Promise<boolean>;
  /** Every current entry, no particular order (the pairer sorts). */
  list(): Promise<LobbyRow[]>;
  /** Bulk removal after the pairer seats agents into a game. */
  remove(keys: readonly LobbyKey[]): Promise<void>;
}

/** In-memory LobbyRepo for tests and local runs. */
export class MemoryLobbyRepo implements LobbyRepo {
  private readonly rows = new Map<string, LobbyRow>();

  async join(row: LobbyRow): Promise<'joined' | 'already'> {
    const key = lobbyEntryKey(row);
    if (this.rows.has(key)) return 'already';
    this.rows.set(key, { ...row });
    return 'joined';
  }

  async leave(key: LobbyKey): Promise<boolean> {
    return this.rows.delete(lobbyEntryKey(key));
  }

  async list(): Promise<LobbyRow[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }

  async remove(keys: readonly LobbyKey[]): Promise<void> {
    for (const k of keys) this.rows.delete(lobbyEntryKey(k));
  }
}
