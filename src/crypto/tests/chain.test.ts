import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GENESIS_PREV, type LogEntry, type LogKind } from '../../kernel/replay.ts';
import type { Json } from '../../kernel/types.ts';
import { appendEntry, entryHash, verifyChain } from '../chain.ts';

const GAME = 'game-abc';

function buildChain(): LogEntry[] {
  const log: LogEntry[] = [];
  const entries: [LogKind, Json, string | null][] = [
    ['commitment', { commitment: 'c'.repeat(64), drand_round: 31840219 }, null],
    ['start', { game: 'chess', players: ['p0', 'p1'] }, null],
    ['move', { turn_index: 0, player: 'p0', notation: 'e4' }, 'aa'.repeat(64)],
    ['move', { turn_index: 1, player: 'p1', notation: 'e5' }, 'bb'.repeat(64)],
    ['resign', { turn_index: 2, player: 'p1' }, 'cc'.repeat(64)],
    ['end', { result: { winners: ['p0'], draw: false, reason: 'resignation' } }, null],
    ['reveal', { reveal_secret: 'd'.repeat(64) }, null],
  ];
  for (const [kind, payload, sig] of entries) {
    log.push(appendEntry(GAME, log, kind, payload, sig, '2026-09-02T00:00:00Z'));
  }
  return log;
}

describe('hash chain', () => {
  it('entryHash matches an independent recomputation of the frozen rule', () => {
    // canonicalJson of { kind, payload } with sorted keys, recomputed by hand.
    const payloadJson = '{"kind":"move","payload":{"player":"p0","turn_index":0}}';
    const expected = createHash('sha256')
      .update(`ludus.log.v1:${GAME}:3:${'e'.repeat(64)}:${payloadJson}`, 'utf8')
      .digest('hex');
    expect(entryHash(GAME, 3, 'e'.repeat(64), 'move', { turn_index: 0, player: 'p0' })).toBe(expected);
  });

  it('first entry links to GENESIS_PREV', () => {
    const e0 = appendEntry(GAME, [], 'commitment', { commitment: 'x' }, null, 't');
    expect(e0.seq).toBe(0);
    expect(e0.prev_hash).toBe(GENESIS_PREV);
    expect(e0.hash).toBe(entryHash(GAME, 0, GENESIS_PREV, 'commitment', { commitment: 'x' }));
  });

  it('appendEntry does not mutate the input log', () => {
    const log = buildChain();
    const before = log.length;
    const snapshot = JSON.stringify(log);
    appendEntry(GAME, log, 'strike', { player: 'p0' }, null, 't');
    expect(log.length).toBe(before);
    expect(JSON.stringify(log)).toBe(snapshot);
  });

  it('a well-formed chain verifies, as does the empty chain', () => {
    expect(verifyChain(GAME, [])).toEqual({ ok: true });
    expect(verifyChain(GAME, buildChain())).toEqual({ ok: true });
  });

  it('verification is game-id specific', () => {
    expect(verifyChain('other-game', buildChain()).ok).toBe(false);
  });

  it('detects tampering with every chained field', () => {
    const tampered: [string, (e: LogEntry) => LogEntry][] = [
      ['seq', (e) => ({ ...e, seq: e.seq + 1 })],
      ['kind', (e) => ({ ...e, kind: 'timeout' as LogKind })],
      ['payload', (e) => ({ ...e, payload: { turn_index: 0, player: 'p1', notation: 'e4' } })],
      ['payload deep', (e) => ({ ...e, payload: { ...(e.payload as object), notation: 'd4' } as Json })],
      ['prev_hash', (e) => ({ ...e, prev_hash: 'f'.repeat(64) })],
      ['hash', (e) => ({ ...e, hash: (e.hash[0] === '0' ? '1' : '0') + e.hash.slice(1) })],
    ];
    for (const [field, mutate] of tampered) {
      const log = buildChain();
      log[2] = mutate(log[2]!);
      const report = verifyChain(GAME, log);
      expect(report.ok, `tampered ${field} must fail`).toBe(false);
      expect(report.badSeq, `tampered ${field} detected at entry 2`).toBe(2);
    }
  });

  it('breaking one link is caught even when later hashes are recomputed to match', () => {
    // An attacker who rewrites entry 2's payload AND recomputes entry 2's hash
    // still fails: entry 3's prev_hash no longer matches.
    const log = buildChain();
    const e2 = log[2]!;
    const newPayload: Json = { turn_index: 0, player: 'p0', notation: 'd4' };
    log[2] = { ...e2, payload: newPayload, hash: entryHash(GAME, 2, e2.prev_hash, e2.kind, newPayload) };
    const report = verifyChain(GAME, log);
    expect(report.ok).toBe(false);
    expect(report.badSeq).toBe(3);
  });

  it('detects deletion and reordering', () => {
    const deleted = buildChain();
    deleted.splice(3, 1);
    expect(verifyChain(GAME, deleted)).toEqual({ ok: false, badSeq: 3 });

    const reordered = buildChain();
    const tmp = reordered[2]!;
    reordered[2] = reordered[3]!;
    reordered[3] = tmp;
    expect(verifyChain(GAME, reordered).ok).toBe(false);
    expect(verifyChain(GAME, reordered).badSeq).toBe(2);
  });

  it('truncation of the tail still verifies (append-only prefix property)', () => {
    // A prefix of a valid chain is itself a valid chain; guarding against
    // truncation is the checkpoint/witness layer's job, not the chain rule's.
    const log = buildChain().slice(0, 4);
    expect(verifyChain(GAME, log)).toEqual({ ok: true });
  });

  it('signature and created_at are outside the chain hash (signed separately)', () => {
    const log = buildChain();
    log[2] = { ...log[2]!, signature: 'ff'.repeat(64), created_at: '1999-01-01T00:00:00Z' };
    // Chain still verifies — move authenticity is enforced by the Ed25519
    // signature over the frozen 'ludus.move.v1' message, not by the chain.
    expect(verifyChain(GAME, log)).toEqual({ ok: true });
  });

  it('payload key order does not matter (canonical JSON)', () => {
    const a = entryHash(GAME, 0, GENESIS_PREV, 'move', { x: 1, y: 2 });
    const b = entryHash(GAME, 0, GENESIS_PREV, 'move', { y: 2, x: 1 });
    expect(a).toBe(b);
  });
});
