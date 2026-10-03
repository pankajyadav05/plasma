import { describe, expect, it } from 'vitest';
import {
  buildAddColumnSql,
  buildRenameColumnSql,
  buildRenameTableSql,
} from './SimpleStructureView';

describe('simple structure ALTERs', () => {
  it('adds a column with the engine quoting', () => {
    expect(
      buildAddColumnSql('sqlite', 'main', 'users', {
        name: 'nick',
        type: 'TEXT',
        notNull: false,
        defaultExpr: '',
      }),
    ).toBe('ALTER TABLE "main"."users" ADD COLUMN "nick" TEXT;');
    expect(
      buildAddColumnSql('mysql', 'shop', 'users', {
        name: 'age',
        type: 'int',
        notNull: true,
        defaultExpr: '0',
      }),
    ).toBe('ALTER TABLE `shop`.`users` ADD COLUMN `age` int NOT NULL DEFAULT 0;');
  });

  it('refuses NOT NULL without a default and odd types', () => {
    expect(() =>
      buildAddColumnSql('sqlite', 'main', 't', {
        name: 'a',
        type: 'TEXT',
        notNull: true,
        defaultExpr: '',
      }),
    ).toThrow(/default/);
    expect(() =>
      buildAddColumnSql('sqlite', 'main', 't', {
        name: 'a',
        type: 'TEXT); DROP TABLE t;--',
        notNull: false,
        defaultExpr: '',
      }),
    ).toThrow(/valid column type/);
  });

  it('renames columns and tables, escaping quotes', () => {
    expect(buildRenameColumnSql('sqlite', 'main', 't', 'a', 'b"c')).toBe(
      'ALTER TABLE "main"."t" RENAME COLUMN "a" TO "b""c";',
    );
    expect(buildRenameTableSql('mysql', 'db', 't', 'u')).toBe(
      'ALTER TABLE `db`.`t` RENAME TO `u`;',
    );
  });
});
