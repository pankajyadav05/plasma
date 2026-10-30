import type { QueryResult } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import { formatAllResultsAs, formatResultAs } from './export';

const result: QueryResult = {
  columns: [
    { name: 'id', dataTypeID: 23, dataTypeName: 'int4' },
    { name: 'note', dataTypeID: 25, dataTypeName: 'text' },
  ],
  rows: [
    [1, 'a|b'],
    [2, null],
    [3, 'line1\nline2 <x>'],
  ],
  rowCount: 3,
  durationMs: 1,
};

describe('formatResultAs', () => {
  it('renders a Markdown table with escaped pipes, NULLs and line breaks', () => {
    expect(formatResultAs(result, 'markdown')).toBe(
      [
        '| id | note |',
        '| --- | --- |',
        '| 1 | a\\|b |',
        '| 2 | NULL |',
        '| 3 | line1<br>line2 <x> |',
      ].join('\n'),
    );
  });

  it('renders an HTML table with escaped content', () => {
    const html = formatResultAs(result, 'html');
    expect(html).toContain('<thead><tr><th>id</th><th>note</th></tr></thead>');
    expect(html).toContain('<tr><td>3</td><td>line1\nline2 &lt;x&gt;</td></tr>');
    expect(html).toContain('<tr><td>2</td><td></td></tr>');
  });

  it('renders TSV with whitespace-collapsed cells', () => {
    expect(formatResultAs(result, 'tsv')).toBe(
      ['id\tnote', '1\ta|b', '2\t', '3\tline1 line2 <x>'].join('\n'),
    );
  });
});

describe('formatAllResultsAs', () => {
  const two = [
    { label: 'Result 1 · orders', columns: result.columns, rows: [[1, 'a']] },
    { label: 'Result 2 <x>', columns: [result.columns[0]!], rows: [[7]] },
  ];

  it('puts a Markdown heading above each table', () => {
    expect(formatAllResultsAs(two, 'markdown')).toBe(
      [
        '### Result 1 · orders',
        '',
        '| id | note |',
        '| --- | --- |',
        '| 1 | a |',
        '',
        '### Result 2 <x>',
        '',
        '| id |',
        '| --- |',
        '| 7 |',
      ].join('\n'),
    );
  });

  it('puts an escaped HTML heading above each table', () => {
    const html = formatAllResultsAs(two, 'html');
    expect(html).toContain('<h3>Result 1 · orders</h3>\n<table>');
    expect(html).toContain('<h3>Result 2 &lt;x&gt;</h3>');
    expect(html.match(/<table>/g)).toHaveLength(2);
  });

  it('stacks TSV blocks with a title line and a blank line between', () => {
    expect(formatAllResultsAs(two, 'tsv')).toBe(
      ['Result 1 · orders', 'id\tnote', '1\ta', '', 'Result 2 <x>', 'id', '7'].join('\n'),
    );
  });
});
