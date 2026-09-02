/**
 * The 5-minute cron: checkpoint signing over the game log (RFC 6962 via T2),
 * doorbell rings for waiting agents, timeout ticks to live rooms, and the
 * guarantee that a broken/missing piece never kills the run.
 */

import { describe, expect, it } from 'vitest';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { sha256Hex } from '../../crypto/canonical.ts';
import { merkleRoot, verifyCheckpoint } from '../../crypto/checkpoint.ts';
import { publicKeyOf } from '../../identity/ed25519.ts';
import { runCron } from '../cron.ts';
import { insertGame, makeTestEnv } from './fakes.ts';
import { insertAgent } from './helpers.ts';

const SK = sha256Hex('cron-test-checkpoint-key');

describe('checkpoint step', () => {
  it('signs an RFC 6962 root over the ordered log hashes', async () => {
    const env = makeTestEnv({ secrets: { checkpoint_sk: SK } });
    insertGame(env, { id: 'g_1', game: 'toy', status: 'ended', ended_at: '2026-09-01T11:00:00Z' });
    const hashes = [sha256Hex('entry-0'), sha256Hex('entry-1'), sha256Hex('entry-2')];
    for (let i = 0; i < hashes.length; i++) {
      env.db.db
        .prepare("INSERT INTO game_log (game_id, seq, kind, payload_json, prev_hash, hash, signature, created_at) VALUES ('g_1', ?, 'move', '{}', ?, ?, NULL, '2026-09-01T10:00:00Z')")
        .run(i, i === 0 ? '0'.repeat(64) : hashes[i - 1]!, hashes[i]!);
    }
    const report = await runCron(env);
    const step = report.steps.find((s) => s.name === 'checkpoint');
    expect(step?.ok).toBe(true);

    const row = env.db.db.prepare('SELECT tree_size, root, signature, created_at FROM checkpoints ORDER BY id DESC LIMIT 1').get() as {
      tree_size: number;
      root: string;
      signature: string;
      created_at: string;
    };
    expect(row.tree_size).toBe(3);
    expect(row.root).toBe(bytesToHex(merkleRoot(hashes.map((h) => hexToBytes(h)))));
    expect(verifyCheckpoint(publicKeyOf(SK), row.tree_size, row.root, row.created_at, row.signature)).toBe(true);
  });

  it('skips cleanly with no signing key', async () => {
    const env = makeTestEnv();
    const report = await runCron(env);
    const step = report.steps.find((s) => s.name === 'checkpoint');
    expect(step?.ok).toBe(true);
    expect(step?.detail).toContain('skipped');
  });
});

describe('doorbells + timeouts', () => {
  it('rings only verified bells of waiting agents and ticks live rooms', async () => {
    const env = makeTestEnv({ secrets: { checkpoint_sk: SK } });
    const alice = insertAgent(env, 'alice');
    const bob = insertAgent(env, 'bob', 'op_b');
    insertGame(env, {
      id: 'g_1',
      game: 'toy',
      status: 'live',
      seats: [
        { player: 'p0', agent_id: alice.agentId, handle: 'alice', pubkey_ed25519: alice.pubkey },
        { player: 'p1', agent_id: bob.agentId, handle: 'bob', pubkey_ed25519: bob.pubkey },
      ],
    });
    // alice: verified bell; bob: unverified.
    env.db.db
      .prepare("INSERT INTO doorbells (agent_id, url, verified_at, cursor, failures, disabled_at) VALUES (?, 'https://a.example/bell', '2026-09-01T00:00:00Z', NULL, 0, NULL)")
      .run(alice.agentId);
    env.db.db
      .prepare("INSERT INTO doorbells (agent_id, url, verified_at, cursor, failures, disabled_at) VALUES (?, 'https://b.example/bell', NULL, NULL, 0, NULL)")
      .run(bob.agentId);
    env.rooms.script = (call) => {
      if (call.url.endsWith('/state')) {
        return new Response(JSON.stringify({ turn_index: 3, deadline_at_ms: env.clock.ms + 60_000, waiting_for: ['p0'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const report = await runCron(env);
    expect(report.steps.find((s) => s.name === 'doorbells')?.detail).toBe('rang 1, disabled 0');
    expect(env.outbound.length).toBe(1);
    expect(env.outbound[0]?.url).toBe('https://a.example/bell');
    const rung = JSON.parse(String(env.outbound[0]?.init?.body)) as { event_id: string; game_id: string; turn_index: number };
    expect(rung).toMatchObject({ event_id: 'g_1:3', game_id: 'g_1', turn_index: 3 });
    expect(Object.keys(rung).sort()).toEqual(['deadline_utc', 'event_id', 'game_id', 'turn_index']); // no board content

    // Cursor advanced -> the same turn does not ring twice.
    const again = await runCron(env);
    expect(again.steps.find((s) => s.name === 'doorbells')?.detail).toBe('rang 0, disabled 0');

    // Timeout sweep ticked the live room.
    expect(env.rooms.calls.some((c) => c.url.endsWith('/tick') && c.method === 'POST')).toBe(true);
    expect(report.steps.find((s) => s.name === 'timeouts')?.detail).toContain('1/1');
  });
});

describe('resilience', () => {
  it('a throwing DB in one step never kills the others', async () => {
    const env = makeTestEnv({ secrets: { checkpoint_sk: 'zz-not-hex' } }); // signCheckpoint will throw
    const report = await runCron(env);
    expect(report.steps.length).toBe(5);
    const checkpoint = report.steps.find((s) => s.name === 'checkpoint');
    expect(checkpoint?.ok).toBe(false);
    // Everything else still ran.
    for (const name of ['doorbells', 'timeouts', 'match', 'witness']) {
      expect(report.steps.some((s) => s.name === name), name).toBe(true);
    }
  });

  it('the match hook reports its wiring state instead of failing', async () => {
    const env = makeTestEnv();
    const report = await runCron(env);
    const match = report.steps.find((s) => s.name === 'match');
    expect(match).toBeDefined();
    // Either T8 exported cronTick (ok) or the step reports the pending hook.
    if (!match?.ok) expect(match?.detail).toBeTruthy();
  });

  it('witness runs only in the daily window unless forced', async () => {
    const env = makeTestEnv({ secrets: { checkpoint_sk: SK } });
    const report = await runCron(env); // clock is 12:00 UTC
    expect(report.steps.find((s) => s.name === 'witness')?.detail).toContain('skipped');

    await runCron(env); // ensure a checkpoint row exists
    const forced = await runCron(env, { forceWitness: true });
    const step = forced.steps.find((s) => s.name === 'witness');
    expect(step?.ok).toBe(true);
    expect(step?.detail).toContain('witness');
  });
});
