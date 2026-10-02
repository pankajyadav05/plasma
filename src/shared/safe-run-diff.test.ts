import { describe, expect, it } from 'vitest';
import type { SafeRunReport } from './protocol';
import { buildSafeRunDiff, cellKey } from './safe-run-diff';

const col = (name: string) => ({ name, dataTypeID: 25, dataTypeName: 'text' });

function report(over: Partial<SafeRunReport>): SafeRunReport {
  return {
    runId: 'r',
    kind: 'update',
    statement: '',
    nested: false,
    affected: 0,
    affectedExact: true,
    estimateRows: null,
    mode: 'diff',
    note: null,
    keyKind: 'pk',
    keyColumns: ['id'],
    beforeColumns: [col('id'), col('name')],
    before: [],
    beforeCtids: null,
    beforeTotal: 0,
    afterColumns: [col('id'), col('name')],
    after: [],
    afterCtids: null,
    afterTotal: 0,
    durationMs: 1,
    expiresAt: 0,
    timeoutSec: 300,
    txnState: 'active',
    ...over,
  };
}

describe('cellKey', () => {
  it('compares by value across types', () => {
    expect(cellKey({ a: 1 })).toBe(cellKey({ a: 1 }));
    expect(cellKey(null)).not.toBe(cellKey('null'));
    expect(cellKey(1)).not.toBe(cellKey('1'));
    expect(cellKey(new Date(5))).toBe(cellKey(new Date(5)));
    expect(cellKey(10n)).toBe(cellKey(10n));
  });
});

describe('buildSafeRunDiff', () => {
  it('pairs UPDATE rows by primary key and highlights changed cells', () => {
    const d = buildSafeRunDiff(
      report({
        before: [
          [1, 'a'],
          [2, 'b'],
        ],
        after: [
          [2, 'B'],
          [1, 'a'],
        ],
        beforeTotal: 2,
        afterTotal: 2,
      }),
    );
    expect(d.pairing).toBe('key');
    expect(d.paired).toBe(true);
    expect(d.unchangedCount).toBe(1);
    expect(d.rows[0]).toMatchObject({ status: 'unchanged' });
    expect(d.rows[1]).toMatchObject({
      status: 'changed',
      before: [2, 'b'],
      after: [2, 'B'],
      changed: [false, true],
    });
  });

  it('leaves rows unpaired when the key itself changed', () => {
    const d = buildSafeRunDiff(
      report({ before: [[1, 'a']], after: [[9, 'a']], beforeTotal: 1, afterTotal: 1 }),
    );
    expect(d.paired).toBe(false);
    expect(d.rows.map((r) => r.status)).toEqual(['old', 'new']);
  });

  it('pairs a PK-less table by ctid order', () => {
    const d = buildSafeRunDiff(
      report({
        keyKind: 'ctid',
        keyColumns: [],
        before: [
          [2, 'b'],
          [1, 'a'],
        ],
        beforeCtids: ['(0,2)', '(0,1)'],
        after: [
          [1, 'A'],
          [2, 'b'],
        ],
        afterCtids: ['(0,3)', '(0,4)'],
        beforeTotal: 2,
        afterTotal: 2,
      }),
    );
    expect(d.pairing).toBe('ctid-order');
    expect(d.rows[0]).toMatchObject({ status: 'changed', before: [1, 'a'], after: [1, 'A'] });
    expect(d.rows[1]).toMatchObject({ status: 'unchanged' });
  });

  it('does not trust ctid order when the sides differ in size or are capped', () => {
    const d = buildSafeRunDiff(
      report({
        keyKind: 'ctid',
        keyColumns: [],
        before: [[1, 'a']],
        beforeCtids: ['(0,1)'],
        after: [],
        afterCtids: [],
        beforeTotal: 1,
        afterTotal: 0,
      }),
    );
    expect(d.pairing).toBe('none');
    expect(d.rows[0]!.status).toBe('old');
  });

  it('marks DELETE rows deleted, from the snapshot or from RETURNING', () => {
    const snap = buildSafeRunDiff(report({ kind: 'delete', before: [[1, 'a']], beforeTotal: 1 }));
    expect(snap.rows).toHaveLength(1);
    expect(snap.rows[0]!.status).toBe('deleted');
    const ret = buildSafeRunDiff(
      report({ kind: 'delete', mode: 'after-only', before: null, after: [[3, 'c']] }),
    );
    expect(ret.rows[0]).toMatchObject({ status: 'deleted', after: [3, 'c'] });
  });

  it('marks INSERT rows inserted', () => {
    const d = buildSafeRunDiff(
      report({ kind: 'insert', mode: 'after-only', before: null, after: [[1, 'x']] }),
    );
    expect(d.rows[0]!.status).toBe('inserted');
  });

  it('shows after-only UPDATE and MERGE rows as new', () => {
    const d = buildSafeRunDiff(report({ mode: 'after-only', before: null, after: [[1, 'x']] }));
    expect(d.rows[0]!.status).toBe('new');
    expect(d.paired).toBe(false);
  });

  it('compares only returned columns when the user wrote their own RETURNING', () => {
    const d = buildSafeRunDiff(
      report({
        before: [[1, 'a']],
        after: [[1]],
        afterColumns: [col('id')],
        beforeTotal: 1,
        afterTotal: 1,
      }),
    );
    expect(d.rows[0]).toMatchObject({ status: 'unchanged', changed: [false, false] });
  });
});

describe('buildSafeRunDiff with capped rows', () => {
  it('shows only matched pairs when a side was cut at the cap', () => {
    const d = buildSafeRunDiff(
      report({
        before: [
          [1, 'a'],
          [2, 'b'],
        ],
        after: [
          [2, 'B'],
          [3, 'c'],
        ],
        beforeTotal: 900,
        afterTotal: 900,
      }),
    );
    expect(d.rows.map((r) => r.status)).toEqual(['changed']);
    expect(d.paired).toBe(false);
  });
});
