import { describe, expect, it } from 'vitest';
import { parseSummarize, summarizeSql } from './column-profile';

const col = (name: string) => ({ name, dataTypeID: 0, dataTypeName: 'varchar' });

describe('column profile', () => {
  it('quotes the relation, including attached catalogs', () => {
    expect(summarizeSql('main', 'Sales 2024')).toBe('SUMMARIZE "main"."Sales 2024"');
    expect(summarizeSql('pg_prod.public', 'users')).toBe('SUMMARIZE "pg_prod"."public"."users"');
  });

  it('reads type, null %, distinct estimate and min / max by column name', () => {
    const result = {
      columns: [
        'column_name',
        'column_type',
        'min',
        'max',
        'approx_unique',
        'avg',
        'count',
        'null_percentage',
      ].map(col),
      rows: [
        ['id', 'BIGINT', '1', '3', '3', '2.0', '3', '0.00'],
        ['region', 'VARCHAR', 'north', 'south', '2', null, '3', '33.33'],
      ],
    };
    expect(parseSummarize(result)).toEqual([
      { column: 'id', type: 'bigint', nullPercent: 0, distinct: 3, min: '1', max: '3', count: 3 },
      {
        column: 'region',
        type: 'varchar',
        nullPercent: 33.33,
        distinct: 2,
        min: 'north',
        max: 'south',
        count: 3,
      },
    ]);
  });

  it('returns nothing for a result that is not a SUMMARIZE', () => {
    expect(parseSummarize({ columns: [col('a')], rows: [[1]] })).toEqual([]);
  });
});
