/**
 * End-to-end unit tests for verifyReplay (gate A8's offline + tamper halves,
 * pre-integration): a hand-built 2-move fixture replay with real Ed25519
 * signatures verifies clean; targeted tampering trips the right named check.
 * Also smoke-runs the test/verify-replay.ts CLI under
 * `node --experimental-strip-types`.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ReplayFile } from '../replay.ts';
import type { AnyGame, Json } from '../types.ts';
import { verifyReplay } from '../verify.ts';
import { buildFixtureReplay, fixtureGame, fixtureKeypair, rehashLog, signMoveMessage } from './fixture-game.ts';

const games: Record<string, AnyGame> = { [fixtureGame.meta.id]: fixtureGame };

function failedNames(replay: ReplayFile): string[] {
  return verifyReplay(replay, games)
    .checks.filter((c) => !c.ok)
    .map((c) => c.name);
}

function clone(replay: ReplayFile): ReplayFile {
  return structuredClone(replay);
}

/** Flips one hex character (one nibble — a fortiori one byte) at position i. */
function flipHex(hex: string, i: number): string {
  const c = hex[i]!;
  const flipped = c === '0' ? '1' : '0';
  return hex.slice(0, i) + flipped + hex.slice(i + 1);
}

describe('verifyReplay on the fixture replay', () => {
  it('accepts a genuine replay: every named check passes', () => {
    const replay = buildFixtureReplay();
    const report = verifyReplay(replay, games);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    const names = report.checks.map((c) => c.name);
    for (const expected of [
      'structure',
      'commitment',
      'final_seed',
      'hash_chain',
      'signatures',
      'game_module',
      'recomputation',
      'result',
      'seed_draws',
      'reveal_after_end',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('is deterministic: building the fixture twice gives byte-identical files', () => {
    expect(JSON.stringify(buildFixtureReplay())).toBe(JSON.stringify(buildFixtureReplay()));
  });

  it('rejects one flipped byte in the reveal (A8 tamper half)', () => {
    const r = clone(buildFixtureReplay());
    r.reveal_secret = flipHex(r.reveal_secret, 0);
    const failed = failedNames(r);
    expect(failed).toContain('commitment');
    expect(failed).toContain('final_seed');
    expect(verifyReplay(r, games).ok).toBe(false);
  });

  it('rejects one flipped byte in a log payload (hash chain breaks)', () => {
    const r = clone(buildFixtureReplay());
    const move = r.log.find((e) => e.kind === 'move')!;
    const payload = move.payload as { [k: string]: Json };
    payload.state_hash = flipHex(payload.state_hash as string, 3);
    const failed = failedNames(r);
    expect(failed).toContain('hash_chain');
    expect(verifyReplay(r, games).ok).toBe(false);
  });

  it('rejects a tampered state_hash even when the chain is re-sealed (recomputation catches it)', () => {
    const r = clone(buildFixtureReplay());
    const move = r.log.find((e) => e.kind === 'move')!;
    const payload = move.payload as { [k: string]: Json };
    payload.state_hash = flipHex(payload.state_hash as string, 3);
    rehashLog(r); // chain hashes are now internally consistent again
    const failed = failedNames(r);
    expect(failed).not.toContain('hash_chain');
    expect(failed).toContain('recomputation');
  });

  it('rejects a move signed by the wrong key even when the chain is re-sealed', () => {
    const r = clone(buildFixtureReplay());
    const move = r.log.find((e) => e.kind === 'move')!;
    const payload = move.payload as { [k: string]: Json };
    const forger = fixtureKeypair('mallory');
    move.signature = signMoveMessage(
      forger,
      r.game_id,
      payload.turn_index as number,
      payload.submission as Json,
    );
    rehashLog(r);
    const failed = failedNames(r);
    expect(failed).toContain('signatures');
  });

  it('rejects a substituted move: the signature pins the submission', () => {
    const r = clone(buildFixtureReplay());
    const move = r.log.find((e) => e.kind === 'move')!;
    const payload = move.payload as { [k: string]: { [k: string]: Json } };
    payload.submission!.move = 'take1'; // room claims the agent took 1, but the agent signed take3
    rehashLog(r);
    const failed = failedNames(r);
    expect(failed).toContain('signatures');
  });

  it('rejects a reveal logged before the end entry', () => {
    const r = clone(buildFixtureReplay());
    const end = r.log[r.log.length - 2]!;
    const reveal = r.log[r.log.length - 1]!;
    r.log[r.log.length - 2] = { ...reveal, seq: end.seq };
    r.log[r.log.length - 1] = { ...end, seq: reveal.seq };
    rehashLog(r);
    const failed = failedNames(r);
    expect(failed).toContain('structure');
    expect(failed).toContain('reveal_after_end');
  });

  it('fails cleanly when the game module is missing', () => {
    const replay = buildFixtureReplay();
    const report = verifyReplay(replay, {});
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain('game_module');
    // integrity-only checks still pass without the game module
    const okNames = report.checks.filter((c) => c.ok).map((c) => c.name);
    expect(okNames).toEqual(expect.arrayContaining(['commitment', 'final_seed', 'hash_chain', 'signatures']));
  });
});

describe('test/verify-replay.ts CLI', () => {
  const cliPath = fileURLToPath(new URL('../../../test/verify-replay.ts', import.meta.url).toString());

  function runCli(replay: ReplayFile): { status: number; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ludus-verify-'));
    const file = join(dir, 'replay.json');
    writeFileSync(file, JSON.stringify(replay));
    try {
      const stdout = execFileSync(process.execPath, ['--experimental-strip-types', cliPath, file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { status: e.status ?? -1, stdout: e.stdout ?? '' };
    }
  }

  it('exits 0 and prints the report for a genuine replay', () => {
    const { status, stdout } = runCli(buildFixtureReplay());
    expect(status).toBe(0);
    expect(stdout).toContain('hash_chain');
    expect(stdout).toContain('REPLAY OK');
  });

  it('exits 1 for a tampered replay', () => {
    const r = clone(buildFixtureReplay());
    r.reveal_secret = flipHex(r.reveal_secret, 0);
    const { status, stdout } = runCli(r);
    expect(status).toBe(1);
    expect(stdout).toContain('REPLAY INVALID');
  });
});
