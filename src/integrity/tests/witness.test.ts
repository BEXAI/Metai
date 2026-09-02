import { describe, expect, it } from 'vitest';
import { canonicalJson, hashJson, sha256Hex } from '../../crypto/canonical.ts';
import type { Json } from '../../kernel/types.ts';
import {
  GitHubDispatchPublisher,
  LocalFilePublisher,
  buildWitnessSnapshot,
  witnessDate,
  witnessJson,
  type CheckpointInfo,
} from '../witness.ts';

const checkpoint: CheckpointInfo = {
  root: 'a'.repeat(64),
  tree_size: 123,
  signature: 'b'.repeat(128),
};

const leaderboards = [
  {
    game: 'chess',
    variant: '{}',
    division: 'pure',
    season_id: '2026-09',
    rows: [{ agent_id: 'a1', rating: 1512.3 }] as Json,
  },
  {
    game: 'islanders',
    variant: '{}',
    division: 'open',
    season_id: '2026-09',
    rows: [{ agent_id: 'a2', rating: 1490 }] as Json,
  },
];

describe('witness snapshot', () => {
  it('assembles date, checkpoint, and leaderboard hashes deterministically', () => {
    const snap = buildWitnessSnapshot('2026-09-02T13:00:00Z', checkpoint, leaderboards);
    expect(snap.version).toBe('ludus.witness.v1');
    expect(snap.date).toBe('2026-09-02');
    expect(snap.checkpoint).toEqual(checkpoint);
    expect(snap.leaderboard_hashes).toHaveLength(2);
    expect(snap.leaderboard_hashes[0]!.hash).toBe(hashJson(leaderboards[0]!.rows));

    // Input order must not matter (sorted output).
    const reversed = buildWitnessSnapshot('2026-09-02T13:00:00Z', checkpoint, [...leaderboards].reverse());
    expect(witnessJson(reversed)).toBe(witnessJson(snap));

    // Self-check hash covers everything above it.
    const body = { ...snap } as unknown as Record<string, Json>;
    delete body['content_sha256'];
    expect(snap.content_sha256).toBe(sha256Hex(canonicalJson(body as Json)));
  });

  it('rejects a malformed checkpoint root', () => {
    expect(() => buildWitnessSnapshot('2026-09-02', { ...checkpoint, root: 'xyz' }, [])).toThrow(/root/);
    expect(witnessDate('2026-09-02T23:59:59Z')).toBe('2026-09-02');
  });
});

describe('LocalFilePublisher', () => {
  it('writes witness/<date>.json with canonical content', async () => {
    const written = new Map<string, string>();
    const mkdirs: string[] = [];
    const pub = new LocalFilePublisher('/tmp/witness-dir', {
      mkdir: async (p) => {
        mkdirs.push(p);
      },
      writeFile: async (p, c) => {
        written.set(p, c);
      },
    });
    const snap = buildWitnessSnapshot('2026-09-02', checkpoint, leaderboards);
    const res = await pub.publish(snap);
    expect(res.ok).toBe(true);
    expect(mkdirs).toEqual(['/tmp/witness-dir']);
    expect(written.get('/tmp/witness-dir/2026-09-02.json')).toBe(witnessJson(snap) + '\n');
  });

  it('writes a real file through node:fs (default io)', async () => {
    const dir = `${process.env['TMPDIR'] ?? '/tmp'}/ludus-witness-test-${Date.now()}`;
    const pub = new LocalFilePublisher(dir);
    const snap = buildWitnessSnapshot('2026-09-02', checkpoint, leaderboards);
    const res = await pub.publish(snap);
    expect(res.ok).toBe(true);
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(`${dir}/2026-09-02.json`, 'utf8');
    expect(JSON.parse(content)).toEqual(snap);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports failure instead of throwing', async () => {
    const pub = new LocalFilePublisher('/dir', {
      mkdir: async () => {
        throw new Error('disk full');
      },
      writeFile: async () => {},
    });
    const res = await pub.publish(buildWitnessSnapshot('2026-09-02', checkpoint, []));
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('disk full');
  });
});

describe('GitHubDispatchPublisher (fake fetch — untested against the live API)', () => {
  it('POSTs a repository_dispatch with the snapshot as client_payload', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const pub = new GitHubDispatchPublisher({
      owner: 'BEXAI',
      repo: 'ludus-witness',
      token: 'ghp_test',
      fetchFn: fakeFetch,
    });
    const snap = buildWitnessSnapshot('2026-09-02', checkpoint, leaderboards);
    const res = await pub.publish(snap);
    expect(res.ok).toBe(true);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.github.com/repos/BEXAI/ludus-witness/dispatches');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer ghp_test');
    expect(headers['accept']).toBe('application/vnd.github+json');
    const body = JSON.parse(String(call.init.body));
    expect(body.event_type).toBe('ludus-witness');
    expect(body.client_payload).toEqual(snap);
  });

  it('surfaces non-204 responses and network errors as failures', async () => {
    const failFetch = (async () => new Response('bad credentials', { status: 401 })) as typeof fetch;
    const pub = new GitHubDispatchPublisher({ owner: 'o', repo: 'r', token: 't', fetchFn: failFetch });
    const snap = buildWitnessSnapshot('2026-09-02', checkpoint, []);
    const res = await pub.publish(snap);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('401');

    const throwFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const pub2 = new GitHubDispatchPublisher({ owner: 'o', repo: 'r', token: 't', fetchFn: throwFetch });
    const res2 = await pub2.publish(snap);
    expect(res2.ok).toBe(false);
    expect(res2.detail).toContain('ECONNREFUSED');
  });
});
