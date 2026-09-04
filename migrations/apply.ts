/**
 * Ordered schema migrations, and the applier both test bootstraps use.
 *
 * schema.sql IS migration 0001 — its own header says so. Everything after it
 * is a numbered file in this directory (0002_*.sql, 0003_*.sql, ...) holding
 * ALTER/CREATE statements only, applied in ascending numeric order.
 *
 * A DATABASE IS schema.sql PLUS EVERY MIGRATION. schema.sql on its own stopped
 * being a complete database at 0002, so both bootstraps go through this module:
 *
 *   src/api/tests/fakes.ts   node:sqlite, in-memory, once per FakeDb
 *   test/e2e/harness.ts      wrangler d1 execute --local, one spawn per file
 *
 * Production applies the identical list by hand, in the identical order:
 *
 *   wrangler d1 execute ludus --remote --file schema.sql            # 0001, once
 *   wrangler d1 execute ludus --remote --file migrations/0002_*.sql
 *
 * This module exists because DDL that only production sees is DDL no test can
 * exercise: without it, `game_teams`, `rated_games.outcome` and
 * `games.house_seats` would be absent from every unit and e2e database and
 * src/match/tests/team-ratings.test.ts could not run at all (plan §8.7,
 * gate 3).
 *
 * Re-running: every CREATE here is IF NOT EXISTS, but SQLite's
 * ALTER TABLE ... ADD COLUMN is not conditional and fails with "duplicate
 * column name" on a second application. Deliberate — a migration is applied
 * once per database and a loud failure beats a swallowed one. The test
 * bootstraps always build from an empty database, so they always apply the
 * whole list.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This directory (migrations/). */
export const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

/** Repository root — the parent of migrations/. */
export const REPO_ROOT = join(MIGRATIONS_DIR, '..');

/** Migration 0001: the initial DDL, which lives at the repo root by history. */
export const SCHEMA_PATH = join(REPO_ROOT, 'schema.sql');

/** The numeric prefix schema.sql occupies; migrations start above it. */
const SCHEMA_SERIAL = 1;

const FILENAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface Migration {
  /** Four-digit serial, e.g. '0002'. */
  serial: string;
  /** File name, e.g. '0002_werewolf_platform.sql'. */
  name: string;
  /** Absolute path. */
  path: string;
}

/**
 * Every migration after 0001, ascending. Throws on a mis-named file, a
 * duplicate serial, or a serial that collides with schema.sql — an ordering
 * that is ambiguous must not apply in whatever order the filesystem returns.
 */
export function migrations(): Migration[] {
  const rows: Migration[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!name.endsWith('.sql')) continue;
    const m = FILENAME.exec(name);
    if (!m) throw new Error(`migrations: bad file name '${name}' (want NNNN_lower_snake.sql)`);
    const serial = m[1]!;
    if (Number(serial) <= SCHEMA_SERIAL) {
      throw new Error(`migrations: '${name}' claims serial ${serial}, which schema.sql already owns`);
    }
    if (seen.has(serial)) throw new Error(`migrations: duplicate serial ${serial} ('${name}')`);
    seen.add(serial);
    rows.push({ serial, name, path: join(MIGRATIONS_DIR, name) });
  }
  rows.sort((a, b) => a.serial.localeCompare(b.serial));
  return rows;
}

/** schema.sql then every migration, in application order. */
export function schemaFiles(): string[] {
  return [SCHEMA_PATH, ...migrations().map((m) => m.path)];
}

const sqlCache = new Map<string, string>();

function sqlOf(path: string): string {
  let sql = sqlCache.get(path);
  if (sql === undefined) {
    sql = readFileSync(path, 'utf8');
    sqlCache.set(path, sql);
  }
  return sql;
}

/**
 * Applies the whole list through `exec` (one call per file, plain DDL — no
 * PRAGMAs, no transactions, so it is the same statement stream D1 receives).
 * Returns the file names applied, in order. Files are read once per process.
 */
export function applySchema(exec: (sql: string, file: string) => void): string[] {
  const applied: string[] = [];
  for (const path of schemaFiles()) {
    const file = path.slice(REPO_ROOT.length + 1);
    exec(sqlOf(path), file);
    applied.push(file);
  }
  return applied;
}
