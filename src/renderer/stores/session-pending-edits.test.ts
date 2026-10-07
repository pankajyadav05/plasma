import type { ColumnMeta } from '@shared/protocol';
import { dialectFor } from '@shared/sql-dialect';
import { describe, expect, it } from 'vitest';
import type { PendingEdit } from './session';
import {
  buildEditBatch,
  duplicateValues,
  failedStatementIndex,
  overlayRows,
  pkValuesFromRow,
  rowKeyOf,
  summarizeEdits,
} from './session-pending-edits';

const columns: ColumnMeta[] = [
  { name: 'id', dataTypeID: 23, dataTypeName: 'int4' },
  { name: 'email', dataTypeID: 25, dataTypeName: 'text' },
  { name: 'meta', dataTypeID: 3802, dataTypeName: 'jsonb' },
];
const rows: unknown[][] = [
  [1, 'a@b.co', { a: 1 }],
  [2, 'c@d.co', null],
];

function edit(partial: Partial<PendingEdit>): PendingEdit {
  const pkValues = partial.pkValues ?? { id: '1' };
  return {
    id: partial.id ?? Math.random().toString(36),
    tabId: 'tab-a',
    schema: 'public',
    table: 'users',
    pkValues,
    rowKey: rowKeyOf(pkValues),
    column: '',
    oldValue: null,
    newValue: null,
    rowIndex: 0,
    columnIndex: 0,
    connectionGen: 1,
    ...partial,
  };
}

describe('pkValuesFromRow / rowKeyOf', () => {
  it('serialises PK values as Postgres text', () => {
    expect(pkValuesFromRow(columns, rows[0]!, ['id'])).toEqual({ id: '1' });
    expect(pkValuesFromRow(columns, rows[0]!, ['missing'])).toBeNull();
    expect(pkValuesFromRow(columns, rows[0]!, [])).toBeNull();
  });

  it('is independent of key order', () => {
    expect(rowKeyOf({ a: '1', b: '2' })).toBe(rowKeyOf({ b: '2', a: '1' }));
  });
});

describe('overlayRows', () => {
  it('applies pending updates by PK, not by row index (survives paging)', () => {
    const edits = [
      edit({ pkValues: { id: '2' }, column: 'email', newValue: 'x@y.z', rowIndex: 40 }),
    ];
    const out = overlayRows('tab-a', columns, rows, ['id'], edits);
    expect(out[0]?.status).toBe('clean');
    expect(out[1]?.status).toBe('edited');
    expect(out[1]?.row[1]).toBe('x@y.z');
    expect(out[1]?.editedCols.has(1)).toBe(true);
    // Server rows are not mutated.
    expect(rows[1]?.[1]).toBe('c@d.co');
  });

  it('marks deleted rows and ignores other tabs', () => {
    const edits = [
      edit({ kind: 'delete', pkValues: { id: '1' } }),
      edit({ tabId: 'tab-b', pkValues: { id: '2' }, column: 'email', newValue: 'z' }),
    ];
    const out = overlayRows('tab-a', columns, rows, ['id'], edits);
    expect(out[0]?.status).toBe('deleted');
    expect(out[1]?.status).toBe('clean');
  });

  it('keeps explicit NULL edits as null', () => {
    const edits = [edit({ column: 'email', newValue: null })];
    const out = overlayRows('tab-a', columns, rows, ['id'], edits);
    expect(out[0]?.row[1]).toBeNull();
    expect(out[0]?.status).toBe('edited');
  });
});

describe('buildEditBatch: concurrent-edit guards (B1)', () => {
  const upd = (over: Partial<PendingEdit> = {}) =>
    edit({
      id: 'u',
      column: 'email',
      oldValue: 'a@b.co',
      oldType: 'text',
      newValue: 'new@b.co',
      ...over,
    });

  it('compares the original value of every column an UPDATE changes', () => {
    const { updates } = buildEditBatch([
      upd(),
      upd({ id: 'u2', column: 'meta', oldValue: '{"a":1}', oldType: 'jsonb', newValue: '{}' }),
    ]);
    expect(updates[0]?.sql).toBe(
      'UPDATE "public"."users" SET "email" = $1, "meta" = $2 WHERE "id" = $3 AND "email" IS NOT DISTINCT FROM $4 AND "meta" IS NOT DISTINCT FROM $5',
    );
    expect(updates[0]?.params).toEqual(['new@b.co', '{}', '1', 'a@b.co', '{"a":1}']);
  });

  it('does not compare columns the UPDATE leaves alone', () => {
    const { updates } = buildEditBatch([upd()]);
    expect(updates[0]?.sql).not.toContain('"meta"');
  });

  it('a json column (not jsonb) is compared as jsonb', () => {
    const { updates } = buildEditBatch([
      upd({ column: 'meta', oldValue: '{"a": 1}', oldType: 'json', newValue: '{}' }),
    ]);
    expect(updates[0]?.sql).toContain('"meta"::jsonb IS NOT DISTINCT FROM $3::jsonb');
  });

  it('skips a column of a type with no usable equality, and values over the size cap', () => {
    const { updates } = buildEditBatch([
      upd({ column: 'area', oldValue: '(1,2)', oldType: 'point', newValue: '(3,4)' }),
      upd({
        id: 'big',
        column: 'body',
        oldValue: 'x'.repeat(70_000),
        oldType: 'text',
        newValue: 'y',
      }),
    ]);
    expect(updates[0]?.sql).toBe(
      'UPDATE "public"."users" SET "area" = $1, "body" = $2 WHERE "id" = $3',
    );
  });

  it('a DELETE compares every other column of the row it was staged from', () => {
    const { updates } = buildEditBatch([
      edit({
        id: 'd',
        kind: 'delete',
        pkValues: { id: '1' },
        originalRow: [
          { column: 'id', value: '1', type: 'int4' },
          { column: 'email', value: 'a@b.co', type: 'text' },
          { column: 'meta', value: null, type: 'jsonb' },
        ],
      }),
    ]);
    expect(updates[0]?.sql).toBe(
      'DELETE FROM "public"."users" WHERE "id" = $1 AND "email" IS NOT DISTINCT FROM $2 AND "meta" IS NOT DISTINCT FROM $3',
    );
    expect(updates[0]?.params).toEqual(['1', 'a@b.co', null]);
    expect(updates[0]?.kind).toBe('delete');
  });

  it('an edit the user chose to keep over an unexplained difference is no longer compared', () => {
    const { updates } = buildEditBatch([upd({ unguarded: true })]);
    expect(updates[0]?.sql).toBe('UPDATE "public"."users" SET "email" = $1 WHERE "id" = $2');
  });

  it('does not compare floats on Postgres before 12 (they print rounded)', () => {
    const f = upd({ column: 'f', oldValue: '0.1', oldType: 'float8', newValue: '0.2' });
    expect(
      buildEditBatch([f], dialectFor('postgres'), { serverVersion: 'PostgreSQL 11.9' }).updates[0]
        ?.sql,
    ).not.toContain('DISTINCT');
    expect(
      buildEditBatch([f], dialectFor('postgres'), { serverVersion: 'PostgreSQL 16.2' }).updates[0]
        ?.sql,
    ).toContain('DISTINCT');
  });

  it('a column the server flags as not comparable is skipped', () => {
    const e = upd({ column: 'c', oldValue: '(1,2)', oldType: 'pt', oldNoEquality: true });
    expect(buildEditBatch([e]).updates[0]?.sql).not.toContain('DISTINCT');
  });

  it('spells the guard per dialect', () => {
    const mysql = buildEditBatch([upd()], dialectFor('mysql')).updates[0]!;
    expect(mysql.sql).toBe(
      'UPDATE `public`.`users` SET `email` = $1 WHERE `id` = $2 AND `email` <=> $3',
    );
    const sqlite = buildEditBatch([upd()], dialectFor('sqlite')).updates[0]!;
    // one bind, used twice (the driver expands each $n occurrence)
    expect(sqlite.sql).toContain('("email" IS $3 OR CAST("email" AS TEXT) IS $3)');
    expect(sqlite.params).toEqual(['new@b.co', '1', 'a@b.co']);
  });

  it('INSERTs are tagged so a duplicate key is reported as a conflict', () => {
    const { updates } = buildEditBatch([
      edit({ id: 'i', kind: 'insert', pkValues: {}, values: { id: '9' } }),
    ]);
    expect(updates[0]?.kind).toBe('insert');
  });
});

describe('buildEditBatch', () => {
  it('merges a row’s cell edits into one UPDATE keyed by the ORIGINAL PK', () => {
    const edits = [
      edit({ id: 'e1', column: 'id', newValue: '10' }),
      edit({ id: 'e2', column: 'email', newValue: null }),
      edit({ id: 'e3', column: 'meta', newValue: '{"a":2}' }),
    ];
    const batch = buildEditBatch(edits);
    expect(batch.updates).toHaveLength(1);
    // The PK column itself is addressed by key, not compared a second time.
    expect(batch.updates[0]?.sql).toBe(
      'UPDATE "public"."users" SET "id" = $1, "email" = $2, "meta" = $3 WHERE "id" = $4 AND "email" IS NOT DISTINCT FROM $5 AND "meta" IS NOT DISTINCT FROM $6',
    );
    expect(batch.updates[0]?.params).toEqual(['10', null, '{"a":2}', '1', null, null]);
    expect(batch.updates[0]?.kind).toBe('update');
    expect(batch.editIds[0]).toEqual(['e1', 'e2', 'e3']);
    expect(batch.updates[0]?.label).toBe('update "public"."users"');
  });

  it('orders deletes, then updates, then inserts; a delete drops that row’s updates', () => {
    const edits = [
      edit({ id: 'u1', pkValues: { id: '1' }, column: 'email', newValue: 'gone' }),
      edit({
        id: 'i1',
        kind: 'insert',
        pkValues: {},
        rowKey: undefined,
        values: { email: 'n@e.w', meta: null },
      }),
      edit({ id: 'u2', pkValues: { id: '2' }, column: 'email', newValue: 'kept' }),
      edit({ id: 'd1', kind: 'delete', pkValues: { id: '1' } }),
    ];
    const batch = buildEditBatch(edits);
    expect(batch.updates.map((u) => u.sql.split(' ')[0])).toEqual(['DELETE', 'UPDATE', 'INSERT']);
    expect(batch.editIds).toEqual([['d1'], ['u2'], ['i1']]);
    expect(batch.updates[0]?.params).toEqual(['1']);
    expect(batch.updates[2]?.sql).toBe(
      'INSERT INTO "public"."users" ("email", "meta") VALUES ($1, $2)',
    );
    expect(batch.updates[2]?.params).toEqual(['n@e.w', null]);
  });

  it('uses DEFAULT VALUES for an empty insert', () => {
    const batch = buildEditBatch([edit({ kind: 'insert', pkValues: {}, values: {} })]);
    expect(batch.updates[0]?.sql).toBe('INSERT INTO "public"."users" DEFAULT VALUES');
  });
});

describe('failedStatementIndex', () => {
  it('reads structured and message forms', () => {
    expect(failedStatementIndex(Object.assign(new Error('x'), { failedIndex: 2 }))).toBe(2);
    expect(failedStatementIndex(new Error('Edit 3 of 4 (update x) failed: violates'))).toBe(2);
    expect(failedStatementIndex(new Error('boom'))).toBeNull();
  });
});

describe('duplicateValues', () => {
  it('copies columns as text and skips defaulted PKs', () => {
    const tableCols = [
      {
        schema: 'public',
        table: 'users',
        name: 'id',
        dataType: 'int4',
        ordinal: 1,
        isPrimaryKey: true,
        isNullable: false,
        hasDefault: true,
      },
      {
        schema: 'public',
        table: 'users',
        name: 'email',
        dataType: 'text',
        ordinal: 2,
        isPrimaryKey: false,
        isNullable: true,
        hasDefault: false,
      },
      {
        schema: 'public',
        table: 'users',
        name: 'meta',
        dataType: 'jsonb',
        ordinal: 3,
        isPrimaryKey: false,
        isNullable: true,
        hasDefault: false,
      },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: minimal schema fixture
    expect(duplicateValues(columns, rows[0]!, tableCols as any)).toEqual({
      email: 'a@b.co',
      meta: '{"a":1}',
    });
  });
});

describe('summarizeEdits', () => {
  it('counts rows, inserts and deletes', () => {
    expect(
      summarizeEdits([
        edit({ column: 'email', newValue: 'a' }),
        edit({ column: 'meta', newValue: 'b' }),
        edit({ kind: 'delete', pkValues: { id: '2' } }),
        edit({ kind: 'insert', pkValues: {}, values: {} }),
      ]),
    ).toBe('1 update, 1 insert, 1 delete');
  });
});
