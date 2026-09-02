/**
 * Shared in-memory fakes for the GameRoom Durable Object tests: DO storage
 * (with the multi-entry atomic put, range list, delete, alarms, and write
 * failure injection), an R2 bucket, and a recording D1 fake for the
 * end-of-game finalize path.
 */

import type { RoomDb, RoomDbStatement, RoomStorage } from '../room.ts';

// ---------------------------------------------------------------------------
// DO storage
// ---------------------------------------------------------------------------

export class MockStorage implements RoomStorage {
  data = new Map<string, unknown>();
  alarmAt: number | null = null;
  /** >0 = that many upcoming put() calls throw BEFORE writing anything. */
  failPuts = 0;
  puts = 0;

  // eslint-disable-next-line @typescript-eslint/require-await
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as T);
  }

  // Overloaded like the real DurableObjectStorage: (key, value) or (entries).
  // The multi-entry form is atomic — the injected failure throws before any
  // key is written, like a rolled-back transaction.
  // eslint-disable-next-line @typescript-eslint/require-await
  async put(a: string | Record<string, unknown>, b?: unknown): Promise<void> {
    if (this.failPuts > 0) {
      this.failPuts -= 1;
      throw new Error('storage put failed (injected)');
    }
    this.puts += 1;
    if (typeof a === 'string') {
      this.data.set(a, JSON.parse(JSON.stringify(b)));
      return;
    }
    const cloned = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
    for (const [k, v] of Object.entries(cloned)) this.data.set(k, v);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.data.delete(k)) n += 1;
    return n;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const prefix = options?.prefix ?? '';
    const out = new Map<string, T>();
    for (const k of [...this.data.keys()].sort()) {
      if (k.startsWith(prefix)) out.set(k, JSON.parse(JSON.stringify(this.data.get(k))) as T);
    }
    return out;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }

  keysWithPrefix(prefix: string): string[] {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  valueSize(key: string): number {
    return JSON.stringify(this.data.get(key)).length;
  }
}

// ---------------------------------------------------------------------------
// R2 bucket
// ---------------------------------------------------------------------------

export class MockBucket {
  puts: { key: string; value: string }[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async put(key: string, value: string): Promise<unknown> {
    this.puts.push({ key, value });
    return null;
  }
}

// ---------------------------------------------------------------------------
// D1 fake: records every executed statement (run or batch) with its binds.
// ---------------------------------------------------------------------------

interface ExecutedStatement {
  sql: string;
  binds: unknown[];
}

interface FakeStmt extends RoomDbStatement {
  rec: ExecutedStatement;
}

export class FakeDb implements RoomDb {
  executed: ExecutedStatement[] = [];
  batchCalls = 0;
  /** >0 = that many upcoming batch() calls throw before recording anything. */
  failBatches = 0;

  prepare(query: string): RoomDbStatement {
    const rec: ExecutedStatement = { sql: query, binds: [] };
    const executed = this.executed;
    const stmt: FakeStmt = {
      rec,
      bind(...values: unknown[]): RoomDbStatement {
        rec.binds = values;
        return stmt;
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async run(): Promise<unknown> {
        executed.push(rec);
        return null;
      },
    };
    return stmt;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async batch(statements: RoomDbStatement[]): Promise<unknown> {
    if (this.failBatches > 0) {
      this.failBatches -= 1;
      throw new Error('d1 batch failed (injected)');
    }
    this.batchCalls += 1;
    for (const s of statements) this.executed.push((s as FakeStmt).rec);
    return [];
  }

  rowsInto(table: string): ExecutedStatement[] {
    return this.executed.filter((r) => r.sql.includes(`INTO ${table}`));
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function req(path: string, body?: unknown, method?: string): Request {
  return new Request(`http://room${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
}
