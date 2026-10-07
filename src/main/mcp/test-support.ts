import type { QueryResult, SchemaInfo } from '@shared/protocol';
import type { McpAuditInput, McpConnectionInfo, McpToolsDeps } from './tools';

/** Fakes for tests of the MCP tools and server (no database, no Electron). */
export const conn = (over: Partial<McpConnectionInfo> = {}): McpConnectionInfo => ({
  id: 'c1',
  name: 'Shop',
  engine: 'postgres',
  readOnly: false,
  production: false,
  access: 'read',
  unmasked: false,
  openInPlasma: false,
  ...over,
});

export const schemaInfo = (): SchemaInfo => ({
  schemas: [{ name: 'public' }, { name: 'other' }],
  tables: [
    { schema: 'public', name: 'orders', kind: 'table', rowCountEstimate: 5 },
    { schema: 'public', name: 'users', kind: 'table', rowCountEstimate: 2 },
    { schema: 'other', name: 'misc', kind: 'table', rowCountEstimate: 1 },
  ],
  columns: [
    {
      schema: 'public',
      table: 'orders',
      name: 'id',
      dataType: 'integer',
      ordinal: 1,
      isPrimaryKey: true,
      isNullable: false,
      hasDefault: true,
    },
    {
      schema: 'public',
      table: 'orders',
      name: 'user_id',
      dataType: 'integer',
      ordinal: 2,
      isPrimaryKey: false,
      isNullable: false,
      hasDefault: false,
    },
    {
      schema: 'public',
      table: 'users',
      name: 'email',
      dataType: 'text',
      ordinal: 1,
      isPrimaryKey: false,
      isNullable: false,
      hasDefault: false,
    },
    {
      schema: 'other',
      table: 'misc',
      name: 'x',
      dataType: 'text',
      ordinal: 1,
      isPrimaryKey: false,
      isNullable: true,
      hasDefault: false,
    },
  ],
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
      definition: 'CREATE UNIQUE INDEX orders_pkey ON public.orders (id)',
      unique: true,
      primary: true,
    },
  ],
  routines: [],
  sequences: [],
  types: [],
  extensions: [],
});

export const queryResult = (rows: unknown[][] = [[1, 'ann@example.com']]): QueryResult =>
  ({
    columns: [
      { name: 'id', dataTypeName: 'int4' },
      { name: 'email', dataTypeName: 'text' },
    ],
    rows,
    rowCount: rows.length,
    durationMs: 3,
  }) as unknown as QueryResult;

export function fakeToolsDeps(over: Partial<McpToolsDeps> & { list?: McpConnectionInfo[] } = {}) {
  const audits: McpAuditInput[] = [];
  const calls = {
    read: [] as Array<{ id: string; sql: string; maxRows: number }>,
    schema: 0,
    propose: [] as unknown[],
  };
  const deps: McpToolsDeps = {
    connections: () => over.list ?? [conn()],
    async runRead(id, sql, maxRows) {
      calls.read.push({ id, sql, maxRows });
      return queryResult();
    },
    async schema() {
      calls.schema++;
      return schemaInfo();
    },
    // Stands in for the real masker: hide e-mail addresses.
    maskRows: (_id, _cols, rows) =>
      rows.map((r) => r.map((v) => (typeof v === 'string' && v.includes('@') ? '•••' : v))),
    proposals: {
      create(input) {
        calls.propose.push(input);
        return { ok: true, id: 'p-1' };
      },
      async wait(id) {
        return { proposal_id: id, status: 'applied', message: 'Applied.', rows_affected: 2 };
      },
    },
    memory: () => ({ state: 'empty' }),
    checkRemember: () => null,
    waitMs: 5,
    scrub: (_id, text) => text.replace(/db\.internal\.corp|svc_user/g, '…'),
    audit: (e) => audits.push(e),
    now: () => Date.now(),
    ...over,
  };
  return { deps, audits, calls };
}
