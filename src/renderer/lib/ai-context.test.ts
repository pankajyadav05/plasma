import { describe, expect, it } from 'vitest';
import { buildAgentContext } from './ai-context';

const schema = {
  columns: ['id', 'status', 'total'].map((name, i) => ({
    schema: 'public',
    table: 'orders',
    name,
    dataType: 'text',
    ordinal: i + 1,
  })),
} as never;

const table = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  kind: 'table',
  title: 'orders',
  sql: '',
  tableSchema: 'public',
  tableName: 'orders',
  hiddenColumns: new Set<string>(['total']),
  tableSort: [{ column: 'id', direction: 'desc' }],
  filters: [
    { id: 'f', column: 'status', op: '=', value: 'paid' },
    { id: 'g', column: 'total', op: 'IS NULL', value: '' },
    { id: 'h', column: 'id', op: '>', value: '5', enabled: false },
  ],
  pageSize: 10,
  ...over,
});

describe('buildAgentContext', () => {
  it('describes the active table tab; filter values only with the row-data opt-in (P0-2)', () => {
    const st = { tabs: [table()] as never, activeTabId: 't1', schema };
    expect(buildAgentContext(st, { rowData: true })).toBe(
      'Current tab: table public.orders; columns shown: id, status; sort: id desc; filters: status = paid; total IS NULL; id > 5 (off); page size: 10',
    );
    const hidden = buildAgentContext(st) ?? '';
    expect(hidden).not.toContain('paid');
    expect(hidden).toContain('status = <hidden>');
    expect(hidden).toContain('total IS NULL');
  });

  it('describes the SQL editor and clips its SQL to 2000 characters', () => {
    const sql = `select ${'x'.repeat(5000)}`;
    const out = buildAgentContext({
      tabs: [{ id: 's', kind: 'sql', sql }] as never,
      activeTabId: 's',
      schema,
    });
    expect(out?.startsWith('Current tab: SQL editor\nselect x')).toBe(true);
    expect(out?.length).toBeLessThan(2100);
    expect(
      buildAgentContext({
        tabs: [{ id: 's', kind: 'sql', sql: '' }] as never,
        activeTabId: 's',
        schema,
      }),
    ).toBe('Current tab: SQL editor');
  });

  it('has nothing for other tabs or no tab', () => {
    expect(
      buildAgentContext({
        tabs: [{ id: 'r', kind: 'redis-cli' }] as never,
        activeTabId: 'r',
        schema,
      }),
    ).toBeUndefined();
    expect(buildAgentContext({ tabs: [], activeTabId: null as never, schema })).toBeUndefined();
  });
});
