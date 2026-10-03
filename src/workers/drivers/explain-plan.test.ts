import { describe, expect, it } from 'vitest';
import { clickhousePlanToJson } from './explain-plan';

describe('clickhousePlanToJson', () => {
  it('nests nodes by indentation and names the scanned table', () => {
    const plan = clickhousePlanToJson([
      'Expression ((Project names))',
      '  Filter (WHERE)',
      '    ReadFromMergeTree (default.events)',
      '  Limit (preliminary LIMIT)',
    ]) as Array<{ Plan: { Plans: Array<Record<string, unknown>> } }>;
    const top = plan[0]?.Plan.Plans[0] as {
      'Node Type': string;
      Plans: Array<Record<string, unknown>>;
    };
    expect(top['Node Type']).toBe('Expression ((Project names))');
    expect(top.Plans.map((n) => n['Node Type'])).toEqual([
      'Filter (WHERE)',
      'Limit (preliminary LIMIT)',
    ]);
    const scan = (top.Plans[0] as { Plans: Array<Record<string, unknown>> }).Plans[0];
    expect(scan).toMatchObject({
      'Node Type': 'ReadFromMergeTree (default.events)',
      'Relation Name': 'default.events',
    });
  });

  it('copes with blank lines and an empty plan', () => {
    expect(clickhousePlanToJson([])).toEqual([{ Plan: { 'Node Type': 'Query plan', Plans: [] } }]);
    const plan = clickhousePlanToJson(['A', '', 'B']) as Array<{ Plan: { Plans: unknown[] } }>;
    expect(plan[0]?.Plan.Plans).toHaveLength(2);
  });
});
