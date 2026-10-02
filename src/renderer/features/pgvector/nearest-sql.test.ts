import { describe, expect, it } from 'vitest';
import { buildNearestSql, parseTableRef } from './nearest-sql';

describe('parseTableRef (R-22)', () => {
  it('parses plain, qualified and quoted references', () => {
    expect(parseTableRef('items')).toEqual({ table: 'items' });
    expect(parseTableRef('public.items')).toEqual({ schema: 'public', table: 'items' });
    expect(parseTableRef('"My Schema"."we""ird"')).toEqual({
      schema: 'My Schema',
      table: 'we"ird',
    });
  });
  it('rejects anything that is not a table reference', () => {
    expect(parseTableRef('items; DROP TABLE x')).toBeNull();
    expect(parseTableRef('')).toBeNull();
    expect(parseTableRef('a.b.c')).toBeNull();
    expect(parseTableRef('/* TODO */ <table>')).toBeNull();
  });
});

describe('buildNearestSql (R-22)', () => {
  const base = { anchor: '[1,2,3]', column: 'embedding', distance: 'cosine' as const, limit: 5 };

  it('builds a runnable query with quoted identifiers', () => {
    const sql = buildNearestSql({ ...base, table: { schema: 'public', table: 'docs' } });
    expect(sql).toBe(
      `SELECT *, "embedding" <=> '[1,2,3]'::vector AS distance\nFROM "public"."docs"\nORDER BY "embedding" <=> '[1,2,3]'::vector\nLIMIT 5;`,
    );
    expect(sql).not.toContain('TODO');
  });

  it('escapes embedded quotes in identifiers and the literal', () => {
    const sql = buildNearestSql({
      ...base,
      anchor: "[1,'x']",
      column: 'em"b',
      table: { table: 't"x' },
    });
    expect(sql).toContain('"em""b"');
    expect(sql).toContain('"t""x"');
    expect(sql).toContain("'[1,''x'']'");
  });

  it('is empty until a source table is known', () => {
    expect(buildNearestSql({ ...base, table: null })).toBe('');
  });

  it('uses the right operator per distance and clamps the limit', () => {
    expect(buildNearestSql({ ...base, distance: 'l2', table: { table: 't' } })).toContain('<->');
    expect(buildNearestSql({ ...base, distance: 'inner', table: { table: 't' } })).toContain('<#>');
    expect(buildNearestSql({ ...base, limit: 99999, table: { table: 't' } })).toContain(
      'LIMIT 1000;',
    );
  });
});
