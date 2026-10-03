import { describe, expect, it } from 'vitest';
import { mysqlPlanToJson, sqlitePlanToJson } from './explain-plan';
import { mysqlServerVersion, mysqlTypeName, normalizeMysqlCell, toMysqlBinding } from './mysql';

describe('mysql values', () => {
  it('names wire types', () => {
    expect(mysqlTypeName(3)).toBe('int');
    expect(mysqlTypeName(253, 45)).toBe('varchar');
    expect(mysqlTypeName(252, 45)).toBe('text');
    expect(mysqlTypeName(252, 63)).toBe('blob');
    expect(mysqlTypeName(253, 63)).toBe('binary');
    expect(mysqlTypeName(245)).toBe('json');
    expect(mysqlTypeName(undefined)).toBe('');
  });

  it('keeps cells lossless for the grid', () => {
    expect(normalizeMysqlCell(Buffer.from([1, 255]))).toBe('\\x01ff');
    expect(normalizeMysqlCell('12', 8)).toBe(12);
    expect(normalizeMysqlCell('9007199254740993', 8)).toBe('9007199254740993');
    expect(normalizeMysqlCell('12', 253)).toBe('12');
    expect(toMysqlBinding(true)).toBe(1);
    expect(toMysqlBinding({ a: 1 })).toBe('{"a":1}');
  });

  it('tells MySQL from MariaDB', () => {
    expect(mysqlServerVersion('8.4.0')).toBe('MySQL 8.4.0');
    expect(mysqlServerVersion('8.0.36-0ubuntu0.22.04')).toBe('MySQL 8.0.36');
    expect(mysqlServerVersion('10.11.9-MariaDB')).toBe('MariaDB 10.11.9');
    expect(mysqlServerVersion('5.5.5-10.6.12-MariaDB-log')).toBe('MariaDB 10.6.12');
  });
});

describe('plan conversion', () => {
  it('turns EXPLAIN FORMAT=JSON into a plan tree', () => {
    const plan = mysqlPlanToJson({
      query_block: {
        select_id: 1,
        cost_info: { query_cost: '2.40' },
        nested_loop: [
          { table: { table_name: 'a', access_type: 'ALL', rows_examined_per_scan: 10 } },
          {
            table: {
              table_name: 'b',
              access_type: 'ref',
              key: 'ix_b',
              rows_examined_per_scan: 1,
              cost_info: { prefix_cost: '3.5' },
              attached_condition: '(b.x > 1)',
            },
          },
        ],
      },
    }) as Array<{ Plan: Record<string, unknown> }>;
    const root = plan[0]!.Plan as { Plans: Array<Record<string, unknown>> };
    expect(plan[0]!.Plan['Total Cost']).toBe(2.4);
    expect(root.Plans[0]).toMatchObject({
      'Node Type': 'Full scan',
      'Relation Name': 'a',
      'Plan Rows': 10,
    });
    expect(root.Plans[1]).toMatchObject({
      'Node Type': 'ref scan',
      'Index Name': 'ix_b',
      'Total Cost': 3.5,
      Filter: '(b.x > 1)',
    });
  });

  it('nests ordering / grouping operations and rejects other payloads', () => {
    const plan = mysqlPlanToJson(
      JSON.stringify({
        query_block: { ordering_operation: { table: { table_name: 't', access_type: 'index' } } },
      }),
    ) as Array<{ Plan: { Plans: Array<{ 'Node Type': string; Plans: unknown[] }> } }>;
    expect(plan[0]!.Plan.Plans[0]!['Node Type']).toBe('Ordering operation');
    expect(plan[0]!.Plan.Plans[0]!.Plans).toHaveLength(1);
    expect(() => mysqlPlanToJson({ nope: 1 })).toThrow(/unexpected EXPLAIN/);
  });

  it('builds the SQLite tree from parent ids', () => {
    const plan = sqlitePlanToJson([
      { id: 2, parent: 0, detail: 'SEARCH t USING INDEX ix (a=?)' },
      { id: 5, parent: 2, detail: 'USE TEMP B-TREE FOR ORDER BY' },
    ]) as Array<{ Plan: { Plans: Array<Record<string, unknown>> } }>;
    const first = plan[0]!.Plan.Plans[0]!;
    expect(first['Relation Name']).toBe('t');
    expect(first['Index Name']).toBe('ix');
    expect((first.Plans as unknown[]).length).toBe(1);
  });
});
