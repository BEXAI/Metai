import { describe, expect, it } from 'vitest';
import { MemoryDocketRepo, type DocketRepo } from '../docket.ts';

describe('docket', () => {
  it('appends with monotonic ids and lists ascending', async () => {
    const docket: DocketRepo = new MemoryDocketRepo();
    const a = await docket.append({
      kind: 'rule_fix',
      subject_json: { game: 'go', version: '1.0.1' },
      reason: 'superko fixture corrected',
      disposition: 'noted',
      created_at: '2026-09-01T00:00:00Z',
    });
    const b = await docket.append({
      kind: 'screen:trade_bias',
      subject_json: { operator_pair: ['opA', 'opB'] },
      reason: 'net flow',
      disposition: 'watching',
    });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(b.created_at).toBeTruthy();

    const all = await docket.list();
    expect(all.map((e) => e.id)).toEqual([1, 2]);
  });

  it('filters by kind, since_id, and limit', async () => {
    const docket = new MemoryDocketRepo();
    for (let i = 0; i < 5; i++) {
      await docket.append({
        kind: i % 2 === 0 ? 'engine_bug' : 'adjudication',
        subject_json: { i },
        reason: `entry ${i}`,
        disposition: i % 2 === 0 ? 'noted' : 'adjudicated',
      });
    }
    expect((await docket.list({ kind: 'engine_bug' })).map((e) => e.id)).toEqual([1, 3, 5]);
    expect((await docket.list({ since_id: 3 })).map((e) => e.id)).toEqual([4, 5]);
    expect((await docket.list({ limit: 2 })).map((e) => e.id)).toEqual([1, 2]);
    expect((await docket.list({ kind: 'adjudication', since_id: 2, limit: 1 })).map((e) => e.id)).toEqual([4]);
  });

  it('is append-only: returned rows are copies and the interface has no update/delete', async () => {
    const docket = new MemoryDocketRepo();
    await docket.append({ kind: 'x', subject_json: { a: 1 }, reason: 'r', disposition: 'noted' });
    const rows = await docket.list();
    rows[0]!.reason = 'TAMPERED';
    rows[0]!.disposition = 'cleared';
    const again = await docket.list();
    expect(again[0]!.reason).toBe('r');
    expect(again[0]!.disposition).toBe('noted');
    // Compile-time property, asserted at runtime for the report: no mutators exposed.
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(docket));
    expect(proto).not.toContain('update');
    expect(proto).not.toContain('delete');
    expect(proto).not.toContain('remove');
  });
});
