import type { QueryResult } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import { firstGeoJsonColumn } from './PostGisDialog';

const result = (rows: unknown[][]): QueryResult =>
  ({
    columns: [
      { name: 'name', dataTypeID: 25, dataTypeName: 'text' },
      { name: 'geom', dataTypeID: 25, dataTypeName: 'text' },
    ],
    rows,
    rowCount: rows.length,
    durationMs: 1,
  }) as QueryResult;

describe('firstGeoJsonColumn (R-21)', () => {
  it('skips text columns that are not GeoJSON and picks the one that is', () => {
    const r = result([['alpha', '{"type":"Point","coordinates":[1,2]}']]);
    expect(firstGeoJsonColumn(r, ['name', 'geom'])).toBe('geom');
  });

  it('returns null when nothing parses (e.g. WKB hex)', () => {
    expect(
      firstGeoJsonColumn(result([['a', '0101000000000000000000F03F']]), ['name', 'geom']),
    ).toBeNull();
  });
});
