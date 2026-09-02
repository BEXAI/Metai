/**
 * The public docket (spec §identity_and_integrity.docket, data_model.tables
 * .docket: "id, kind, subject_json, reason, disposition, created_at").
 *
 * Append-only: every rule fix, engine bug, adjudication, and integrity
 * disposition lands here with a reason, and nothing is ever edited or
 * deleted. The interface deliberately has no update/delete — a later
 * adjudication of a 'watching' entry is a NEW entry referencing the old id
 * in its subject_json.
 *
 * T7's /api/docket serves `list()` output verbatim (ascending id).
 */

import type { Json } from '../kernel/types.ts';

/**
 * 'watching'    — statistical screen fired; no action, public record only
 *                 (the only disposition the automated screens write in this
 *                 build; adjudication is manual and public).
 * 'adjudicated' — a human ruling (manual entries).
 * 'cleared'     — a watched subject was reviewed and cleared (manual).
 * 'noted'       — rule fixes, engine bugs, operational notes.
 */
export type DocketDisposition = 'watching' | 'adjudicated' | 'cleared' | 'noted';

export interface DocketEntry {
  id: number;
  /** e.g. 'screen:resign_won_position', 'screen:trade_bias', 'rule_fix', 'engine_bug'. */
  kind: string;
  subject_json: Json;
  reason: string;
  disposition: DocketDisposition;
  created_at: string;
}

export interface DocketAppend {
  kind: string;
  subject_json: Json;
  reason: string;
  disposition: DocketDisposition;
  /** Defaults to now (UTC ISO). Injectable for tests/backfills. */
  created_at?: string;
}

export interface DocketRepo {
  append(entry: DocketAppend): Promise<DocketEntry>;
  /** Ascending by id. */
  list(opts?: { kind?: string; since_id?: number; limit?: number }): Promise<DocketEntry[]>;
}

/** In-memory append-only docket for tests and local runs. Ids are 1-based. */
export class MemoryDocketRepo implements DocketRepo {
  private readonly entries: DocketEntry[] = [];

  async append(entry: DocketAppend): Promise<DocketEntry> {
    const row: DocketEntry = {
      id: this.entries.length + 1,
      kind: entry.kind,
      subject_json: entry.subject_json,
      reason: entry.reason,
      disposition: entry.disposition,
      created_at: entry.created_at ?? new Date().toISOString(),
    };
    this.entries.push(row);
    return { ...row };
  }

  async list(opts: { kind?: string; since_id?: number; limit?: number } = {}): Promise<DocketEntry[]> {
    let out = this.entries.filter(
      (e) => (opts.kind === undefined || e.kind === opts.kind) && e.id > (opts.since_id ?? 0),
    );
    if (opts.limit !== undefined) out = out.slice(0, opts.limit);
    return out.map((e) => ({ ...e }));
  }
}
