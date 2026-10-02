import { describe, expect, it } from 'vitest';
import {
  buildExplainPlanPrompt,
  buildFixSqlPrompt,
  buildNlFilterPrompt,
  isSafeWhereFragment,
  parseExplainPlanResponse,
  parseFixSqlResponse,
  parseNlFilterResponse,
  relevantSchema,
  summarizePlanForAi,
  taskMaxTokens,
  taskSystemPrompt,
} from './ai-tasks';
import type { SchemaInfo } from './protocol';

describe('fix-sql', () => {
  it('puts the error and the SQL in the prompt', () => {
    const p = buildFixSqlPrompt({
      sql: 'select nme from users',
      error: 'column "nme" does not exist',
    });
    expect(p).toContain('column "nme" does not exist');
    expect(p).toContain('```sql\nselect nme from users\n```');
  });

  it('truncates very large SQL', () => {
    const p = buildFixSqlPrompt({ sql: 'x'.repeat(50_000), error: 'e' });
    expect(p.length).toBeLessThan(16_000);
    expect(p).toContain('truncated');
  });

  it('parses the fenced fix and the prose explanation', () => {
    const r = parseFixSqlResponse(
      'The column is called name.\n\n```sql\nSELECT name FROM users;\n```\nDone.',
    );
    expect(r).toEqual({
      sql: 'SELECT name FROM users',
      explanation: 'The column is called name.\n\nDone.',
    });
  });

  it('accepts an untagged fence and keeps multi-line SQL', () => {
    const r = parseFixSqlResponse('Fixed.\n```\nSELECT 1\nFROM t\n```');
    expect(r?.sql).toBe('SELECT 1\nFROM t');
  });

  it('rejects answers with no code, empty code or several statements', () => {
    expect(parseFixSqlResponse('I cannot tell.')).toBeNull();
    expect(parseFixSqlResponse('```sql\n  \n```')).toBeNull();
    expect(parseFixSqlResponse('```sql\nselect 1; drop table users;\n```')).toBeNull();
  });

  it('does not split on semicolons inside strings', () => {
    expect(parseFixSqlResponse("```sql\nselect 'a;b'\n```")?.sql).toBe("select 'a;b'");
  });
});

const plan = [
  {
    Plan: {
      'Node Type': 'Hash Join',
      'Total Cost': 1234.5,
      'Plan Rows': 100,
      'Actual Rows': 5000,
      'Actual Loops': 1,
      'Actual Total Time': 12.345,
      'Hash Cond': '(o.user_id = u.id)',
      Plans: [
        {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          Schema: 'public',
          'Total Cost': 900,
          'Plan Rows': 10,
          Filter: '(total > 500)',
          'Rows Removed by Filter': 99990,
          'Shared Read Blocks': 800,
        },
        { 'Node Type': 'Index Scan', 'Relation Name': 'users', 'Index Name': 'users_pkey' },
      ],
    },
    'Planning Time': 0.4,
    'Execution Time': 13.1,
  },
];

describe('explain-plan', () => {
  it('summarises the plan tree compactly', () => {
    const text = summarizePlanForAi(plan);
    expect(text).toContain(
      '- Hash Join (cost=1235 rows=100 actual_rows=5000 loops=1 time=12.35ms)',
    );
    expect(text).toContain('  - Seq Scan on public.orders (cost=900 rows=10 read_blocks=800)');
    expect(text).toContain('Filter: (total > 500)');
    expect(text).toContain('Rows Removed by Filter: 99990');
    expect(text).toContain('using users_pkey');
    expect(text).toContain('Execution time: 13.10 ms');
  });

  it('caps the plan size', () => {
    const big = {
      Plan: {
        'Node Type': 'Append',
        Plans: Array.from({ length: 5000 }, () => ({
          'Node Type': 'Seq Scan',
          'Relation Name': 'x',
        })),
      },
    };
    expect(summarizePlanForAi(big, 1000).length).toBeLessThan(1100);
  });

  it('builds a prompt with the query, mode and plan', () => {
    const p = buildExplainPlanPrompt({ sql: 'select 1', plan, analyzed: true });
    expect(p).toContain('select 1');
    expect(p).toContain('EXPLAIN ANALYZE');
    expect(p).toContain('Seq Scan on public.orders');
  });

  it('extracts index suggestions and the walk-through', () => {
    const r = parseExplainPlanResponse(
      [
        'The scan reads every order.',
        '',
        '```sql',
        '-- filter on total reads 100k rows',
        'CREATE INDEX CONCURRENTLY idx_orders_total ON public.orders (total);',
        '```',
        'Second one:',
        '```sql',
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_u ON users (email) WHERE active;',
        '```',
      ].join('\n'),
    );
    expect(r.explanation).toContain('The scan reads every order.');
    expect(r.explanation).not.toContain('CREATE INDEX');
    expect(r.indexes).toEqual([
      {
        sql: 'CREATE INDEX CONCURRENTLY idx_orders_total ON public.orders (total)',
        reason: 'filter on total reads 100k rows',
      },
      {
        sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_u ON users (email) WHERE active',
        reason: '',
      },
    ]);
  });

  it('adds CONCURRENTLY when the model forgot it', () => {
    const r = parseExplainPlanResponse('```sql\nCREATE UNIQUE INDEX IF NOT EXISTS i ON t (a)\n```');
    expect(r.indexes[0]?.sql).toBe('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS i ON t (a)');
    const r2 = parseExplainPlanResponse('```sql\ncreate index i on t (a)\n```');
    expect(r2.indexes[0]?.sql).toBe('CREATE INDEX CONCURRENTLY i on t (a)');
  });

  it('drops anything that is not a single CREATE INDEX', () => {
    const r = parseExplainPlanResponse(
      [
        '```sql',
        'DROP INDEX idx_old;',
        '```',
        '```sql',
        'CREATE INDEX CONCURRENTLY a ON t (x); DROP TABLE t;',
        '```',
        '```sql',
        'VACUUM t',
        '```',
      ].join('\n'),
    );
    expect(r.indexes).toEqual([]);
  });

  it('caps suggestions at three and dedupes', () => {
    const block = (n: number) => `\`\`\`sql\nCREATE INDEX CONCURRENTLY i${n} ON t (c${n})\n\`\`\``;
    const text = [1, 1, 2, 3, 4, 5].map(block).join('\n');
    expect(parseExplainPlanResponse(text).indexes.map((i) => i.sql.split(' ')[3])).toEqual([
      'i1',
      'i2',
      'i3',
    ]);
  });
});

const cols = [
  { name: 'id', dataType: 'integer' },
  { name: 'total', dataType: 'numeric' },
  { name: 'created_at', dataType: 'timestamptz' },
];

describe('nl-filter', () => {
  it('builds a prompt with the columns and today', () => {
    const p = buildNlFilterPrompt({
      request: 'orders over 500',
      schema: 'public',
      table: 'orders',
      columns: cols,
      today: '2026-10-02',
    });
    expect(p).toContain('public.orders');
    expect(p).toContain('Today: 2026-10-02');
    expect(p).toContain('- total (numeric)');
    expect(p).toContain('Request: orders over 500');
  });

  it('maps a JSON answer to filter rows', () => {
    const r = parseNlFilterResponse(
      '{"filters":[{"column":"total","op":">","value":"500"},{"column":"created_at","op":"BETWEEN","value":"2026-09-21, 2026-09-27"}],"where":null,"explanation":"Over 500 last week"}',
      cols,
    );
    expect(r).toEqual({
      kind: 'filters',
      filters: [
        { column: 'total', op: '>', value: '500' },
        { column: 'created_at', op: 'BETWEEN', value: '2026-09-21, 2026-09-27' },
      ],
      explanation: 'Over 500 last week',
    });
  });

  it('tolerates a code fence, prose around it, and numeric values', () => {
    const r = parseNlFilterResponse(
      'Sure!\n```json\n{"filters":[{"column":"total","op":">=","value":500}],"where":null,"explanation":"x"}\n```',
      cols,
    );
    expect(r.kind).toBe('filters');
    expect(r.kind === 'filters' && r.filters[0]?.value).toBe('500');
  });

  it('handles IS NULL without a value and normalises operator case', () => {
    const r = parseNlFilterResponse(
      '{"filters":[{"column":"total","op":"is null","value":""}],"explanation":""}',
      cols,
    );
    expect(r).toMatchObject({ kind: 'filters', filters: [{ op: 'IS NULL', value: '' }] });
  });

  it('refuses unknown columns, unknown operators and missing values', () => {
    for (const f of [
      '{"column":"nope","op":"=","value":"1"}',
      '{"column":"total","op":"~","value":"1"}',
      '{"column":"total","op":"=","value":""}',
    ]) {
      expect(
        parseNlFilterResponse(`{"filters":[${f}],"where":null,"explanation":"e"}`, cols).kind,
      ).toBe('none');
    }
  });

  it('falls back to a safe WHERE fragment', () => {
    const r = parseNlFilterResponse(
      '{"filters":[],"where":"total > 500 OR created_at < now() - interval \'7 days\'","explanation":"or"}',
      cols,
    );
    expect(r).toMatchObject({
      kind: 'where',
      where: "total > 500 OR created_at < now() - interval '7 days'",
    });
  });

  it('does not mix a bad filter with a partial one; uses where or none', () => {
    const r = parseNlFilterResponse(
      '{"filters":[{"column":"total","op":">","value":"1"},{"column":"zzz","op":"=","value":"1"}],"where":null}',
      cols,
    );
    expect(r.kind).toBe('none');
  });

  it('returns none for garbage', () => {
    expect(parseNlFilterResponse('no json here', cols).kind).toBe('none');
    expect(parseNlFilterResponse('{broken', cols).kind).toBe('none');
    expect(parseNlFilterResponse('[1,2]', cols).kind).toBe('none');
  });

  it('rejects dangerous WHERE fragments', () => {
    const bad = [
      '1=1; drop table orders',
      'total > 1 -- c',
      'total > 1 /* c */',
      'id in (select id from secrets)',
      'pg_sleep(10) is not null',
      'id = 1 or (delete from t) is null',
      '',
    ];
    for (const w of bad) expect(isSafeWhereFragment(w)).toBe(false);
    expect(isSafeWhereFragment("name = 'drop; select'")).toBe(false); // semicolon anywhere is refused
    expect(isSafeWhereFragment("name = 'delete me'")).toBe(true); // keywords inside literals are fine
    expect(isSafeWhereFragment('total > 5 and "set" = 1')).toBe(true);
  });
});

describe('system prompts and schema reduction', () => {
  it('has a prompt and a token budget per task', () => {
    for (const t of ['fix-sql', 'explain-plan', 'nl-filter'] as const) {
      expect(taskSystemPrompt(t).length).toBeGreaterThan(100);
      expect(taskMaxTokens(t)).toBeGreaterThan(0);
    }
    expect(taskSystemPrompt('explain-plan')).toContain('CREATE INDEX CONCURRENTLY');
    expect(taskSystemPrompt('nl-filter')).toContain('JSON');
  });

  const t = (name: string) => ({
    schema: 'public',
    name,
    kind: 'table' as const,
    rowCountEstimate: 1,
  });
  const c = (table: string, name: string) => ({
    schema: 'public',
    table,
    name,
    ordinal: 1,
    dataType: 'int',
    isNullable: true,
    isPrimaryKey: false,
    defaultValue: null,
  });
  const schema = {
    schemas: [],
    tables: [t('orders'), t('users'), t('audit'), t('misc')],
    columns: [c('orders', 'id'), c('users', 'id'), c('audit', 'id'), c('misc', 'id')],
    foreignKeys: [
      {
        schema: 'public',
        table: 'orders',
        column: 'user_id',
        refSchema: 'public',
        refTable: 'users',
        refColumn: 'id',
      },
    ],
    indexes: [
      {
        schema: 'public',
        table: 'orders',
        name: 'orders_pkey',
        definition: 'x',
        unique: true,
        primary: true,
      },
      {
        schema: 'public',
        table: 'audit',
        name: 'audit_pkey',
        definition: 'x',
        unique: true,
        primary: true,
      },
    ],
    routines: [],
    sequences: [],
    types: [],
    extensions: [],
  } as unknown as SchemaInfo;

  it('keeps referenced tables plus their FK neighbours', () => {
    const r = relevantSchema(schema, 'SELECT * FROM Orders WHERE total > 1');
    expect(r.tables.map((x) => x.name)).toEqual(['orders', 'users']);
    expect(r.columns).toHaveLength(2);
    expect(r.indexes?.map((i) => i.name)).toEqual(['orders_pkey']);
  });

  it('falls back to the first tables when nothing matches', () => {
    expect(relevantSchema(schema, 'select nothing').tables).toHaveLength(4);
  });
});
