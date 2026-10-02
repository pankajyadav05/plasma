import { describe, expect, it } from 'vitest';
import {
  buildIncomingCountSql,
  buildPeekSql,
  describeIncoming,
  fkByColumnName,
  formatIncomingCount,
  groupForeignKeys,
  incomingFks,
  incomingRequestsForRow,
  lookupForRow,
  openArgs,
  outgoingFks,
  parseIncomingCounts,
  requestsKey,
} from './fk-nav';

const fks = [
  {
    schema: 'public',
    table: 'orders',
    column: 'user_id',
    refSchema: 'public',
    refTable: 'users',
    refColumn: 'id',
    constraint: 'orders_user_fk',
  },
  {
    schema: 'public',
    table: 'orders',
    column: 'approver_id',
    refSchema: 'public',
    refTable: 'users',
    refColumn: 'id',
    constraint: 'orders_approver_fk',
  },
  {
    schema: 'public',
    table: 'order_items',
    column: 'order_id',
    refSchema: 'public',
    refTable: 'orders',
    refColumn: 'id',
    constraint: 'items_order_fk',
  },
  {
    schema: 'public',
    table: 'ledger',
    column: 'a',
    refSchema: 'public',
    refTable: 'pairs',
    refColumn: 'x',
    constraint: 'ledger_pair',
  },
  {
    schema: 'public',
    table: 'ledger',
    column: 'b',
    refSchema: 'public',
    refTable: 'pairs',
    refColumn: 'y',
    constraint: 'ledger_pair',
  },
];

describe('groupForeignKeys', () => {
  it('keeps two FKs to the same table apart and merges composite columns', () => {
    const g = groupForeignKeys(fks);
    expect(g).toHaveLength(4);
    expect(g.find((x) => x.constraint === 'ledger_pair')?.pairs).toEqual([
      { column: 'a', refColumn: 'x' },
      { column: 'b', refColumn: 'y' },
    ]);
  });
  it('falls back to one group per edge without constraint names', () => {
    const g = groupForeignKeys([
      { schema: 's', table: 't', column: 'a', refSchema: 's', refTable: 'u', refColumn: 'id' },
      { schema: 's', table: 't', column: 'b', refSchema: 's', refTable: 'u', refColumn: 'id2' },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]?.pairs).toHaveLength(2);
  });
});

describe('outgoing / incoming', () => {
  it('lists FKs declared on and pointing at a table', () => {
    expect(outgoingFks(fks, 'public', 'orders').map((g) => g.constraint)).toEqual([
      'orders_user_fk',
      'orders_approver_fk',
    ]);
    expect(incomingFks(fks, 'public', 'users').map((g) => describeIncoming(g))).toEqual([
      'orders.user_id',
      'orders.approver_id',
    ]);
    expect(describeIncoming(groupForeignKeys(fks)[3]!)).toBe('ledger.(a, b)');
    expect(incomingFks(undefined, 'public', 'users')).toEqual([]);
  });
  it('maps columns to their group', () => {
    const m = fkByColumnName(outgoingFks(fks, 'public', 'orders'));
    expect(m.get('user_id')?.refTable).toBe('users');
    expect(m.has('id')).toBe(false);
  });
});

describe('lookupForRow', () => {
  const [pair] = incomingFks(fks, 'public', 'pairs');
  it('reads parent values for an incoming lookup (composite)', () => {
    const v: Record<string, string> = { x: '1', y: '2' };
    expect(lookupForRow(pair!, 'incoming', (c) => v[c])).toEqual({
      match: [
        { column: 'a', value: '1' },
        { column: 'b', value: '2' },
      ],
    });
  });
  it('reads child values for an outgoing lookup', () => {
    const v: Record<string, string> = { a: '1', b: '2' };
    expect(lookupForRow(pair!, 'outgoing', (c) => v[c])?.match).toEqual([
      { column: 'x', value: '1' },
      { column: 'y', value: '2' },
    ]);
  });
  it('returns null when a value is NULL or missing', () => {
    expect(lookupForRow(pair!, 'incoming', (c) => (c === 'x' ? '1' : null))).toBeNull();
    expect(lookupForRow(pair!, 'incoming', () => undefined)).toBeNull();
  });
});

describe('SQL builders', () => {
  it('builds one capped count statement with numbered params', () => {
    const [byUser, byApprover] = incomingFks(fks, 'public', 'users');
    const { sql, params } = buildIncomingCountSql([
      { group: byUser!, lookup: { match: [{ column: 'user_id', value: '7' }] } },
      { group: byApprover!, lookup: { match: [{ column: 'approver_id', value: '7' }] } },
    ]);
    expect(sql).toBe(
      'SELECT (SELECT count(*) FROM (SELECT 1 FROM "public"."orders" WHERE "user_id" = $1 LIMIT 1001) s), (SELECT count(*) FROM (SELECT 1 FROM "public"."orders" WHERE "approver_id" = $2 LIMIT 1001) s)',
    );
    expect(params).toEqual(['7', '7']);
  });
  it('quotes hostile identifiers', () => {
    const g = groupForeignKeys([
      {
        schema: 's"x',
        table: 't"y',
        column: 'c"z',
        refSchema: 's',
        refTable: 'u',
        refColumn: 'id',
      },
    ])[0]!;
    const { sql } = buildIncomingCountSql([
      { group: g, lookup: { match: [{ column: 'c"z', value: '1' }] } },
    ]);
    expect(sql).toContain('"s""x"."t""y"');
    expect(sql).toContain('"c""z" = $1');
  });
  it('builds the peek SELECT', () => {
    expect(
      buildPeekSql('public', 'users', {
        match: [
          { column: 'id', value: '7' },
          { column: 'tenant', value: 't1' },
        ],
      }),
    ).toEqual({
      sql: 'SELECT * FROM "public"."users" WHERE "id" = $1 AND "tenant" = $2 LIMIT 1',
      params: ['7', 't1'],
    });
  });
});

describe('counts', () => {
  it('parses counts from numbers and bigint text, flagging the cap', () => {
    expect(parseIncomingCounts([12, '0', '1001', null], 4)).toEqual([
      { count: 12, capped: false },
      { count: 0, capped: false },
      { count: 1000, capped: true },
      null,
    ]);
  });
  it('formats counts', () => {
    expect(formatIncomingCount({ count: 12, capped: false })).toBe('12 rows');
    expect(formatIncomingCount({ count: 1, capped: false })).toBe('1 row');
    expect(formatIncomingCount({ count: 1000, capped: true })).toBe('1,000+ rows');
    expect(formatIncomingCount(undefined)).toBe('…');
  });
});

describe('openArgs', () => {
  it('splits the first match from the composite remainder', () => {
    expect(
      openArgs('public', 'ledger', {
        match: [
          { column: 'a', value: '1' },
          { column: 'b', value: '2' },
        ],
      }),
    ).toEqual({
      schema: 'public',
      table: 'ledger',
      column: 'a',
      value: '1',
      also: [{ column: 'b', value: '2' }],
    });
  });
});

describe('incomingRequestsForRow', () => {
  const cols = [
    { name: 'id', dataTypeName: 'int4' },
    { name: 'name', dataTypeName: 'text' },
  ];
  it('builds one request per incoming FK from the row values', () => {
    const reqs = incomingRequestsForRow(incomingFks(fks, 'public', 'users'), cols, [7, 'Ann']);
    expect(reqs.map((r) => r.lookup.match)).toEqual([
      [{ column: 'user_id', value: '7' }],
      [{ column: 'approver_id', value: '7' }],
    ]);
    expect(requestsKey(reqs)).toContain('user_id=7');
  });
  it('skips FKs whose referenced column is NULL or not in the result', () => {
    expect(
      incomingRequestsForRow(incomingFks(fks, 'public', 'users'), cols, [null, 'Ann']),
    ).toEqual([]);
    expect(
      incomingRequestsForRow(incomingFks(fks, 'public', 'users'), [cols[1]!], ['Ann']),
    ).toEqual([]);
  });
});
