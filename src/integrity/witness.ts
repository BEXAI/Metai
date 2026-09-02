/**
 * Daily witness snapshot (spec §identity_and_integrity.game_log: "once a day
 * a witness snapshot is committed to a public GitHub repo by a GitHub Actions
 * job the Worker dispatches").
 *
 * The snapshot binds the day's latest signed Merkle checkpoint (root +
 * tree_size, produced by the 5-minute cron via src/crypto/checkpoint.ts) and
 * hashes of the current leaderboards. Anyone holding the witness file can
 * later detect a rewritten log or a retroactively edited leaderboard.
 *
 * Two publishers behind one interface:
 *  - LocalFilePublisher: writes witness/<date>.json — used in this build
 *    (no GitHub token in the environment; recorded in PLAN.md build notes).
 *  - GitHubDispatchPublisher: POSTs a repository_dispatch event to the GitHub
 *    API with the snapshot as client_payload; the Actions job commits it.
 *    Code-complete but UNTESTED against the real API (no token here) — unit
 *    tests exercise it with an injected fetch.
 */

import { canonicalJson, hashJson, sha256Hex } from '../crypto/canonical.ts';
import type { Json } from '../kernel/types.ts';

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

export interface CheckpointInfo {
  /** RFC 6962 Merkle root over all game logs, lowercase hex. */
  root: string;
  tree_size: number;
  /** Ed25519 signature by the checkpoint key, or null if unsigned. */
  signature: string | null;
}

export interface LeaderboardInput {
  game: string;
  variant: string;
  division: string;
  season_id: string;
  /** The leaderboard rows exactly as /api/leaderboards serves them. */
  rows: Json;
}

export interface LeaderboardHash {
  game: string;
  variant: string;
  division: string;
  season_id: string;
  /** sha256 over canonical JSON of the rows. */
  hash: string;
}

export interface WitnessSnapshot {
  version: 'ludus.witness.v1';
  /** UTC day 'YYYY-MM-DD'. */
  date: string;
  checkpoint: CheckpointInfo;
  leaderboard_hashes: LeaderboardHash[];
  /** sha256 over canonical JSON of everything above (self-check convenience). */
  content_sha256: string;
}

export function witnessDate(when: Date | string): string {
  const d = typeof when === 'string' ? new Date(when) : when;
  if (Number.isNaN(d.getTime())) throw new Error(`witnessDate: bad date ${String(when)}`);
  return d.toISOString().slice(0, 10);
}

export function buildWitnessSnapshot(
  when: Date | string,
  checkpoint: CheckpointInfo,
  leaderboards: readonly LeaderboardInput[],
): WitnessSnapshot {
  if (!/^[0-9a-f]{64}$/.test(checkpoint.root)) {
    throw new Error('buildWitnessSnapshot: checkpoint root must be 32 bytes of lowercase hex');
  }
  const leaderboard_hashes: LeaderboardHash[] = leaderboards
    .map((lb) => ({
      game: lb.game,
      variant: lb.variant,
      division: lb.division,
      season_id: lb.season_id,
      hash: hashJson(lb.rows),
    }))
    .sort((a, b) =>
      `${a.game} ${a.variant} ${a.division} ${a.season_id}`.localeCompare(
        `${b.game} ${b.variant} ${b.division} ${b.season_id}`,
      ),
    );
  const body = {
    version: 'ludus.witness.v1' as const,
    date: witnessDate(when),
    checkpoint: {
      root: checkpoint.root,
      tree_size: checkpoint.tree_size,
      signature: checkpoint.signature,
    },
    leaderboard_hashes,
  };
  return { ...body, content_sha256: sha256Hex(canonicalJson(body as unknown as Json)) };
}

/** Canonical serialized form — what gets written/committed, byte-stable. */
export function witnessJson(snapshot: WitnessSnapshot): string {
  return canonicalJson(snapshot as unknown as Json);
}

// ---------------------------------------------------------------------------
// Publishers
// ---------------------------------------------------------------------------

export interface PublishResult {
  ok: boolean;
  detail: string;
}

export interface WitnessPublisher {
  publish(snapshot: WitnessSnapshot): Promise<PublishResult>;
}

interface FileIo {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
}

async function nodeFileIo(): Promise<FileIo> {
  const fs = await import('node:fs/promises');
  return {
    mkdir: async (p) => {
      await fs.mkdir(p, { recursive: true });
    },
    writeFile: (p, c) => fs.writeFile(p, c, 'utf8'),
  };
}

/**
 * Writes witness/<date>.json (canonical JSON). Node-only (dynamic import of
 * node:fs/promises), which is fine: this publisher runs in local builds and
 * tests, never inside the Worker.
 */
export class LocalFilePublisher implements WitnessPublisher {
  constructor(
    private readonly dir: string,
    private readonly io?: FileIo,
  ) {}

  async publish(snapshot: WitnessSnapshot): Promise<PublishResult> {
    try {
      const io = this.io ?? (await nodeFileIo());
      await io.mkdir(this.dir);
      const path = `${this.dir}/${snapshot.date}.json`;
      await io.writeFile(path, witnessJson(snapshot) + '\n');
      return { ok: true, detail: `wrote ${path}` };
    } catch (err) {
      return { ok: false, detail: `local write failed: ${String(err)}` };
    }
  }
}

export interface GitHubDispatchConfig {
  /** e.g. 'BEXAI'. */
  owner: string;
  /** e.g. 'ludus-witness'. */
  repo: string;
  /** Fine-grained token with contents:write on the witness repo (Worker secret). */
  token: string;
  /** repository_dispatch event_type the Actions workflow listens for. */
  eventType?: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

/**
 * POSTs a repository_dispatch event carrying the snapshot; a GitHub Actions
 * workflow in the witness repo commits it. UNTESTED against the live GitHub
 * API in this build (no token in the environment) — covered by unit tests
 * with an injected fetch only.
 */
export class GitHubDispatchPublisher implements WitnessPublisher {
  constructor(private readonly cfg: GitHubDispatchConfig) {}

  async publish(snapshot: WitnessSnapshot): Promise<PublishResult> {
    const { owner, repo, token } = this.cfg;
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const url = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'ludus-witness',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({
          event_type: this.cfg.eventType ?? 'ludus-witness',
          client_payload: snapshot,
        }),
      });
      if (res.status === 204) return { ok: true, detail: `dispatched to ${owner}/${repo}` };
      const text = await res.text().catch(() => '');
      return { ok: false, detail: `github dispatch failed: HTTP ${res.status} ${text.slice(0, 200)}` };
    } catch (err) {
      return { ok: false, detail: `github dispatch failed: ${String(err)}` };
    }
  }
}
