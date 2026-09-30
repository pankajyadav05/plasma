import { describe, expect, it } from 'vitest';
import {
  MAX_BIND_PARAMS,
  buildBatchInsert,
  mapCsvRow,
  mapJsonRow,
  rowsPerBatch,
} from './import-plan';

describe('buildBatchInsert', () => {
  it('numbers placeholders across rows and quotes names', () => {
    expect(buildBatchInsert('public', 'Users', ['id', 'Full Name'], 2)).toBe(
      'INSERT INTO public."Users" (id, "Full Name") VALUES ($1, $2), ($3, $4)',
    );
  });
  it('rejects empty input', () => {
    expect(() => buildBatchInsert('s', 't', [], 1)).toThrow();
    expect(() => buildBatchInsert('s', 't', ['a'], 0)).toThrow();
    expect(() => buildBatchInsert('s', 't', [''], 1)).toThrow();
  });
});

describe('rowsPerBatch', () => {
  it('stays under the bind-parameter limit', () => {
    expect(rowsPerBatch(3)).toBe(1000);
    expect(rowsPerBatch(100) * 100).toBeLessThanOrEqual(MAX_BIND_PARAMS);
    expect(rowsPerBatch(50000)).toBe(1);
    expect(rowsPerBatch(0)).toBe(1);
    expect(rowsPerBatch(3, 50)).toBe(50);
  });
});

describe('row mapping', () => {
  it('maps csv by index, padding ragged rows', () => {
    const m = [
      { target: 'a', source: 1 },
      { target: 'b', source: 0 },
      { target: 'c', source: 5 },
    ];
    expect(mapCsvRow(['x', 'y'], m)).toEqual(['y', 'x', null]);
  });
  it('maps json by key', () => {
    const m = [
      { target: 'a', source: 'k1' },
      { target: 'b', source: 'k2' },
      { target: 'c', source: 'missing' },
    ];
    expect(mapJsonRow({ k1: 1, k2: { z: 1 } }, m)).toEqual(['1', '{"z":1}', null]);
  });
});
