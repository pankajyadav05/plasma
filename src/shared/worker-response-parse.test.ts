import { describe, expect, it } from 'vitest';
import { parseQueryResultEnvelope, parseWorkerResponse } from './worker-response-parse';

const columns = [{ name: 'id', dataTypeID: 23, dataTypeName: 'int4' }];

describe('parseQueryResultEnvelope', () => {
  it('accepts a large row array without walking cell schemas', () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => [i, `r${i}`]);
    const msg = {
      kind: 'queryResult',
      id: 'q1',
      result: {
        columns,
        rows,
        rowCount: rows.length,
        durationMs: 12,
        truncated: true,
      },
    };
    const parsed = parseQueryResultEnvelope(msg);
    expect(parsed?.result.rows).toHaveLength(5_000);
    expect(parsed?.result.truncated).toBe(true);
    expect(parsed?.result.rows[4999]).toEqual([4999, 'r4999']);
  });

  it('rejects non-array row tuples', () => {
    expect(
      parseQueryResultEnvelope({
        kind: 'queryResult',
        id: 'q1',
        result: { columns, rows: [{ a: 1 }], rowCount: 1, durationMs: 1 },
      }),
    ).toBeNull();
  });
});

describe('parseWorkerResponse', () => {
  it('routes queryResult through the envelope fast path', () => {
    const res = parseWorkerResponse({
      kind: 'queryResult',
      id: 'abc',
      result: {
        columns,
        rows: [[1]],
        rowCount: 1,
        durationMs: 3,
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.kind).toBe('queryResult');
      if (res.data.kind === 'queryResult') {
        expect(res.data.result.truncated).toBe(false);
      }
    }
  });

  it('parses queryChunk broadcasts', () => {
    const res = parseWorkerResponse({
      kind: 'queryChunk',
      id: 'abc',
      revision: 2,
      rows: [[1], [2]],
      chunkIndex: 0,
      done: false,
      truncated: false,
      columns,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.kind).toBe('queryChunk');
  });
});
