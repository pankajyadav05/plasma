import { describe, expect, it } from 'vitest';
import {
  buildTableStructure,
  parseConstraint,
  parseIndex,
  splitIdentList,
} from './table-structure';

describe('splitIdentList', () => {
  it('splits on top-level commas and unquotes identifiers', () => {
    expect(splitIdentList('id, "Order Id", lower(email)')).toEqual([
      'id',
      'Order Id',
      'lower(email)',
    ]);
    expect(splitIdentList('"a""b", c')).toEqual(['a"b', 'c']);
  });
});

describe('parseConstraint', () => {
  it('parses a composite primary key', () => {
    const c = parseConstraint('t_pkey', 'PRIMARY KEY (tenant_id, id)');
    expect(c.type).toBe('primary');
    expect(c.columns).toEqual(['tenant_id', 'id']);
  });

  it('parses a foreign key target', () => {
    const c = parseConstraint(
      'orders_user_fk',
      'FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE',
    );
    expect(c.type).toBe('foreign');
    expect(c.columns).toEqual(['user_id']);
    expect(c.references).toBe('public.users(id)');
  });

  it('classifies CHECK without extracting columns', () => {
    const c = parseConstraint('qty_positive', 'CHECK ((qty > 0))');
    expect(c.type).toBe('check');
    expect(c.columns).toEqual([]);
  });
});

describe('parseIndex', () => {
  it('extracts uniqueness, method, columns and partial condition', () => {
    const idx = parseIndex(
      'users_email_live',
      'CREATE UNIQUE INDEX users_email_live ON public.users USING btree (lower(email)) WHERE (deleted_at IS NULL)',
    );
    expect(idx).toMatchObject({
      unique: true,
      method: 'btree',
      columns: 'lower(email)',
      condition: '(deleted_at IS NULL)',
    });
  });

  it('handles non-btree methods', () => {
    const idx = parseIndex('doc_gin', 'CREATE INDEX doc_gin ON public.docs USING gin (body)');
    expect(idx).toMatchObject({ unique: false, method: 'gin', columns: 'body', condition: '' });
  });
});

describe('buildTableStructure', () => {
  it('marks PK / unique / FK columns from constraints', () => {
    const s = buildTableStructure([
      { kind: 'col', c1: 'id', c2: 'bigint', c3: 'NOT NULL', c4: "nextval('t_id_seq'::regclass)" },
      { kind: 'col', c1: 'email', c2: 'text', c3: 'NOT NULL', c4: '' },
      { kind: 'col', c1: 'org_id', c2: 'integer', c3: '', c4: '' },
      { kind: 'con', c1: 't_pkey', c2: 'PRIMARY KEY (id)', c3: '', c4: '' },
      { kind: 'con', c1: 't_email_key', c2: 'UNIQUE (email)', c3: '', c4: '' },
      {
        kind: 'con',
        c1: 't_org_fk',
        c2: 'FOREIGN KEY (org_id) REFERENCES orgs(id)',
        c3: '',
        c4: '',
      },
      {
        kind: 'idx',
        c1: 't_pkey',
        c2: 'CREATE UNIQUE INDEX t_pkey ON public.t USING btree (id)',
        c3: '',
        c4: '',
      },
    ]);
    expect(
      s.columns.map((c) => [c.name, c.primaryKey, c.unique, c.references, c.nullable]),
    ).toEqual([
      ['id', true, false, null, false],
      ['email', false, true, null, false],
      ['org_id', false, false, 'orgs(id)', true],
    ]);
    expect(s.constraints).toHaveLength(3);
    expect(s.indexes[0]).toMatchObject({ name: 't_pkey', unique: true, columns: 'id' });
  });
});
