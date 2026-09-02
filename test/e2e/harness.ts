/**
 * E2E harness: boots the REAL local Worker (wrangler dev) against a FRESH
 * per-run state directory, applies schema.sql to local D1, ticks the cron,
 * and tears down cleanly.
 *
 * Fresh state: every run gets test/e2e/out/state-<runid>/ passed as
 * --persist-to, so runs never share D1/DO/KV/R2 state. Artifacts (wrangler
 * log, replays the tests choose to save) also land under test/e2e/out/.
 *
 * Cron: wrangler dev is started with --test-scheduled, which exposes
 *   GET /__scheduled?cron=<urlencoded cron expression>
 * (verified against wrangler 4.128 — see notes/e2e-driver.md; the cron query
 * parameter is optional and only selects which trigger fires when a Worker
 * has several).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeypair } from '../../src/crypto/ed25519.ts';
import { sleep } from './client.ts';

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(E2E_DIR, '..', '..');
export const OUT_DIR = join(E2E_DIR, 'out');
const CONFIG_PATH = join(E2E_DIR, 'wrangler.e2e.jsonc');
const WRANGLER_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'wrangler');

export interface HarnessOptions {
  port?: number;
  /** Extra --var entries. */
  vars?: Record<string, string>;
  bootTimeoutMs?: number;
}

export interface Harness {
  base: string;
  runId: string;
  stateDir: string;
  logFile: string;
  proc: ChildProcess;
  /** Fire the 5-minute cron once via wrangler's --test-scheduled door. */
  tickCron(): Promise<void>;
  /** Direct lobby INSERT (spec-unlisted games only — tictactoe). */
  seedLobby(row: { game: string; variant?: string; division?: string; agent_id: string }): Promise<void>;
  stop(): Promise<void>;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const port = opts.port ?? 8788;
  const base = `http://127.0.0.1:${port}`;
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const stateDir = join(OUT_DIR, `state-${runId}`);
  mkdirSync(stateDir, { recursive: true });
  const logFile = join(OUT_DIR, `wrangler-${runId}.log`);

  // 1. Fresh local D1 schema (same persist dir the dev server will use).
  const schema = spawnSync(
    WRANGLER_BIN,
    ['d1', 'execute', 'DB', '--local', `--file=${join(REPO_ROOT, 'schema.sql')}`, '--persist-to', stateDir, '--config', CONFIG_PATH],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 },
  );
  if (schema.status !== 0) {
    throw new Error(`schema apply failed (${schema.status}):\n${schema.stdout}\n${schema.stderr}`);
  }

  // 2. Spawn wrangler dev with the shim config.
  const vars: Record<string, string> = { CHECKPOINT_SK: generateKeypair().secretKeyHex, ...(opts.vars ?? {}) };
  const args = [
    'dev',
    '--config', CONFIG_PATH,
    '--port', String(port),
    '--persist-to', stateDir,
    '--test-scheduled',
    '--show-interactive-dev-session', 'false',
  ];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);

  const log = createWriteStream(logFile);
  const proc = spawn(WRANGLER_BIN, args, {
    cwd: REPO_ROOT,
    detached: true, // own process group => we can kill wrangler + workerd together
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
  proc.stdout?.pipe(log);
  proc.stderr?.pipe(log);

  let exited = false;
  proc.on('exit', () => {
    exited = true;
  });

  const stop = async (): Promise<void> => {
    if (exited || proc.pid === undefined) return;
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    const deadline = Date.now() + 8000;
    while (!exited && Date.now() < deadline) await sleep(200);
    if (!exited) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  process.once('exit', () => {
    if (!exited && proc.pid !== undefined) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });

  // 3. Wait for readiness (first boot bundles the Worker).
  const bootDeadline = Date.now() + (opts.bootTimeoutMs ?? 120_000);
  let ready = false;
  let lastErr = '';
  while (Date.now() < bootDeadline) {
    if (exited) break;
    try {
      const res = await fetch(`${base}/e2e/ping`);
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean };
        if (body.ok === true) {
          ready = true;
          break;
        }
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await sleep(400);
  }
  if (!ready) {
    await stop();
    throw new Error(`wrangler dev did not become ready on ${base} (${lastErr}); see ${logFile}`);
  }

  const tickCron = async (): Promise<void> => {
    // wrangler --test-scheduled convention (wrangler 4.x): GET /__scheduled
    // with an optional ?cron= selecting the trigger. Returns "Ran scheduled
    // event" with status 200.
    const url = `${base}/__scheduled?cron=${encodeURIComponent('*/5 * * * *')}`;
    const res = await fetch(url);
    await res.body?.cancel();
    if (!res.ok) throw new Error(`cron tick failed: HTTP ${res.status} for ${url}`);
    // scheduled() work runs under ctx.waitUntil; give it a beat to land.
    await sleep(250);
  };

  const seedLobby = async (row: { game: string; variant?: string; division?: string; agent_id: string }): Promise<void> => {
    const res = await fetch(`${base}/e2e/lobby`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`e2e lobby seed failed: HTTP ${res.status}`);
    await res.body?.cancel();
  };

  return { base, runId, stateDir, logFile, proc, tickCron, seedLobby, stop };
}
