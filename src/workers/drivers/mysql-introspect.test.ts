import { describe, expect, it } from 'vitest';
import { buildMysqlSchema, mysqlIntrospectQueries } from './mysql-introspect';

const raw = {
  schemas: [['shop']],
  tables: [
    ['shop', 'orders', 'BASE TABLE', 120],
    ['shop', 'v_open', 'VIEW', null],
  ],
  columns: [
    ['shop', 'orders', 'id', 'int', 1, 'PRI', 'NO', null, 'auto_increment'],
    ['shop', 'orders', 'user_id', 'bigint(20)', 2, 'MUL', 'NO', null, ''],
    ['shop', 'orders', 'state', "enum('a','b')", 3, '', 'YES', "'a'", ''],
    ['shop', 'orders', 'total', 'int', 4, '', 'YES', null, 'VIRTUAL GENERATED'],
  ],
  foreignKeys: [
    ['shop', 'orders', 'user_id', 'shop', 'users', 'id', 'fk_u', 'CASCADE', 'SET NULL'],
  ],
  indexes: [
    ['shop', 'orders', 'PRIMARY', 0, 1, 'id', null],
    ['shop', 'orders', 'ix_u_s', 1, 1, 'user_id', null],
    ['shop', 'orders', 'ix_u_s', 1, 2, 'state', 8],
  ],
  triggers: [['shop', 'orders', 'trg']],
};

describe('buildMysqlSchema', () => {
  const info = buildMysqlSchema(raw);

  it('maps tables and views with the estimate', () => {
    expect(info.schemas).toEqual([{ name: 'shop' }]);
    expect(info.tables).toEqual([
      { schema: 'shop', name: 'orders', kind: 'table', rowCountEstimate: 120 },
      { schema: 'shop', name: 'v_open', kind: 'view', rowCountEstimate: null },
    ]);
  });

  it('maps columns: keys, nullability, defaults, auto-increment, generated', () => {
    const c = (n: string) => info.columns.find((x) => x.name === n)!;
    expect(c('id')).toMatchObject({
      isPrimaryKey: true,
      isNullable: false,
      hasDefault: true,
      identity: 'by default',
    });
    expect(c('user_id')).toMatchObject({
      isPrimaryKey: false,
      dataType: 'bigint(20)',
      hasDefault: false,
    });
    expect(c('state')).toMatchObject({ isNullable: true, defaultExpr: "'a'", hasDefault: true });
    expect(c('total').hasDefault).toBe(true);
  });

  it('maps foreign keys with their rules', () => {
    expect(info.foreignKeys).toEqual([
      {
        schema: 'shop',
        table: 'orders',
        column: 'user_id',
        refSchema: 'shop',
        refTable: 'users',
        refColumn: 'id',
        constraint: 'fk_u',
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
    ]);
  });

  it('folds index columns back into one index each', () => {
    expect(info.indexes).toEqual([
      expect.objectContaining({ name: 'PRIMARY', primary: true, unique: true }),
      {
        schema: 'shop',
        table: 'orders',
        name: 'ix_u_s',
        definition: 'CREATE INDEX `ix_u_s` ON `orders` (`user_id`, `state`(8))',
        unique: false,
        primary: false,
      },
    ]);
    expect(info.triggers).toEqual([{ schema: 'shop', table: 'orders', name: 'trg' }]);
  });

  it('honours scope options', () => {
    expect(buildMysqlSchema(raw, { columns: false }).columns).toEqual([]);
    expect(buildMysqlSchema(raw, { objects: false }).tables).toEqual([]);
  });
});

describe('mysqlIntrospectQueries', () => {
  it('scopes column queries to known schemas and skips them when none match', () => {
    const q = mysqlIntrospectQueries({ objects: false, columnSchemas: ['shop', 'nope'] }, ['shop']);
    expect(q.map((x) => x.key)).toEqual(['columns', 'foreignKeys', 'indexes', 'triggers']);
    expect(q[0]!.params).toEqual(['shop']);
    expect(mysqlIntrospectQueries({ columnSchemas: ['nope'] }, ['shop']).map((x) => x.key)).toEqual(
      ['schemas', 'tables'],
    );
  });

  it('never lists system schemas', () => {
    const q = mysqlIntrospectQueries({ columns: false }, []);
    expect(q[0]!.params).toContain('mysql');
    expect(q[0]!.sql).toMatch(/NOT IN/);
  });
});
