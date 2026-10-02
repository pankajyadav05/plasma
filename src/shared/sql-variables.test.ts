import { describe, expect, it } from 'vitest';
import {
  bindVariables,
  findVariableOccurrences,
  hasPositionalParams,
  isUninferableParamError,
  listVariables,
  toSqlLiteral,
  uninferableParamName,
  validateVariableValue,
} from './sql-variables';

const names = (sql: string) => findVariableOccurrences(sql).map((o) => `${o.syntax}:${o.name}`);

describe('findVariableOccurrences', () => {
  it("finds :name, :'name' and $name", () => {
    expect(names("select * from t where a = :a and b = :'b' and c = $c")).toEqual([
      'colon:a',
      'quoted:b',
      'dollar:c',
    ]);
  });

  it('records token offsets', () => {
    const sql = "where x = :'abc' or y = :d";
    const [q, c] = findVariableOccurrences(sql);
    expect(sql.slice(q!.start, q!.end)).toBe(":'abc'");
    expect(sql.slice(c!.start, c!.end)).toBe(':d');
  });

  it('ignores placeholders inside string literals', () => {
    expect(names("select ':a', 'it''s :b', E'\\':c' || :d")).toEqual(['colon:d']);
  });

  it('ignores placeholders inside quoted identifiers', () => {
    expect(names('select "col:a", "x""$b" from t where y = :y')).toEqual(['colon:y']);
  });

  it('ignores placeholders inside comments', () => {
    expect(names('select 1 -- :a\n, :b /* :c /* :nested */ $d */ , :e')).toEqual([
      'colon:b',
      'colon:e',
    ]);
  });

  it('ignores placeholders inside dollar-quoted bodies', () => {
    const sql = 'do $$ begin perform :a; end $$; select :b';
    expect(names(sql)).toEqual(['colon:b']);
    expect(names('select $tag$ :a $name $tag$, :z')).toEqual(['colon:z']);
  });

  it('does not treat ::casts as variables', () => {
    expect(names('select x::int, y::text[], z::numeric(10,2), :v::int')).toEqual(['colon:v']);
    expect(names('select 1:::foo')).toEqual([]);
  });

  it('skips a colon that follows an identifier or digit (array slices, a:b)', () => {
    expect(names('select arr[lo:hi], arr[1:n], a:b from t')).toEqual([]);
    expect(names('select arr[ :lo : :hi ]')).toEqual(['colon:lo', 'colon:hi']);
  });

  it('does not treat positional $1 or identifier tails as variables', () => {
    expect(names('select $1, $2 from t where a$b = :x')).toEqual(['colon:x']);
    expect(hasPositionalParams('select $1')).toBe(true);
    expect(hasPositionalParams("select '$1'")).toBe(false);
  });

  it('accepts a placeholder at the very start, after parens and commas', () => {
    expect(names(':a')).toEqual(['colon:a']);
    expect(names('f(:a,:b)')).toEqual(['colon:a', 'colon:b']);
  });

  it('keeps repeats and lists distinct names in first-use order', () => {
    const sql = 'select :b, :a, :b, $a';
    expect(findVariableOccurrences(sql)).toHaveLength(4);
    expect(listVariables(sql)).toEqual(['b', 'a']);
  });

  it("ignores a lone :' that is not a quoted variable", () => {
    expect(names("select ':' || :a, ':x'")).toEqual(['colon:a']);
  });

  it('survives unterminated literals and comments', () => {
    expect(names("select 'oops :a")).toEqual([]);
    expect(names('select /* :a')).toEqual([]);
    expect(names('select $$ :a')).toEqual([]);
  });
});

describe('bindVariables', () => {
  const text = (value: string) => ({ mode: 'text' as const, value });

  it('binds values as $n parameters in first-use order', () => {
    const r = bindVariables('select * from t where a = :a and b = :b', {
      a: text('x'),
      b: { mode: 'number', value: ' 42 ' },
    });
    expect(r.sql).toBe('select * from t where a = $1 and b = $2');
    expect(r.params).toEqual(['x', '42']);
    expect(r.paramNames).toEqual(['a', 'b']);
  });

  it('reuses one parameter for a repeated name and every syntax', () => {
    const r = bindVariables("select :a, :'a', $a, :b", { a: text('v'), b: text('w') });
    expect(r.sql).toBe('select $1, $1, $1, $2');
    expect(r.params).toEqual(['v', 'w']);
  });

  it('leaves strings, comments, casts and dollar quotes untouched', () => {
    const sql = "select ':a', :a::int -- :a\n, $$:a$$";
    const r = bindVariables(sql, { a: text('1') });
    expect(r.sql).toBe("select ':a', $1::int -- :a\n, $$:a$$");
  });

  it('maps null, boolean and date modes', () => {
    const r = bindVariables('select :n, :b, :d', {
      n: { mode: 'null', value: 'ignored' },
      b: { mode: 'boolean', value: 'TRUE' },
      d: { mode: 'date', value: '2024-05-01' },
    });
    expect(r.params).toEqual([null, 'true', '2024-05-01']);
  });

  it('substitutes raw mode verbatim and does not bind it', () => {
    const r = bindVariables('select * from :tbl where id = :id order by :col', {
      tbl: { mode: 'raw', value: ' public.users ' },
      id: text('7'),
      col: { mode: 'raw', value: 'created_at desc' },
    });
    expect(r.sql).toBe('select * from public.users where id = $1 order by created_at desc');
    expect(r.params).toEqual(['7']);
    expect(r.rawNames.sort()).toEqual(['col', 'tbl']);
  });

  it("raw replaces the whole :'name' token", () => {
    const r = bindVariables("select :'x'", { x: { mode: 'raw', value: 'now()' } });
    expect(r.sql).toBe('select now()');
  });

  it('reports missing and invalid values without producing runnable SQL', () => {
    const r = bindVariables('select :a, :b, :c', {
      a: text('ok'),
      b: { mode: 'number', value: 'abc' },
    });
    expect(r.missing).toEqual(['c']);
    expect(r.invalid.b).toBe('Enter a number');
    expect(r.sql).toBe('select :a, :b, :c');
    expect(r.params).toEqual([]);
  });

  it('refuses to mix variables with positional parameters', () => {
    const r = bindVariables('select $1, :a', { a: text('x') });
    expect(r.conflict).toMatch(/\$1/);
    expect(r.params).toEqual([]);
  });

  it('is a no-op for SQL without variables', () => {
    const r = bindVariables('select 1', {});
    expect(r).toMatchObject({ sql: 'select 1', params: [], missing: [], conflict: null });
  });

  it('inlines named variables as safe literals when asked', () => {
    const r = bindVariables(
      'select :a, :b',
      { a: text("o'brien"), b: text('y') },
      { inline: new Set(['a']) },
    );
    expect(r.sql).toBe("select 'o''brien', $1");
    expect(r.params).toEqual(['y']);
    expect(r.paramNames).toEqual(['b']);
  });

  it('can not be used to inject through a bound text value', () => {
    const r = bindVariables('select * from t where n = :n', { n: text("x'; drop table t; --") });
    expect(r.sql).toBe('select * from t where n = $1');
    expect(r.params).toEqual(["x'; drop table t; --"]);
  });
});

describe('literals and validation', () => {
  it('quotes text and doubles backslashes in an E string', () => {
    expect(toSqlLiteral({ mode: 'text', value: "a'b" })).toBe("'a''b'");
    expect(toSqlLiteral({ mode: 'text', value: 'a\\b' })).toBe("E'a\\\\b'");
    expect(toSqlLiteral({ mode: 'null', value: '' })).toBe('NULL');
    expect(toSqlLiteral({ mode: 'number', value: ' 3.5 ' })).toBe('3.5');
    expect(toSqlLiteral({ mode: 'boolean', value: 'False' })).toBe('false');
  });

  it('validates numbers, dates, booleans and raw', () => {
    const v = validateVariableValue;
    expect(v({ mode: 'number', value: '-1.5e3' })).toBeNull();
    expect(v({ mode: 'number', value: '1,5' })).not.toBeNull();
    expect(v({ mode: 'number', value: '' })).not.toBeNull();
    expect(v({ mode: 'date', value: '2024-02-29' })).toBeNull();
    expect(v({ mode: 'date', value: '2024-02-29 10:11:12.5+02' })).toBeNull();
    expect(v({ mode: 'date', value: 'yesterday' })).not.toBeNull();
    expect(v({ mode: 'boolean', value: 'true' })).toBeNull();
    expect(v({ mode: 'boolean', value: 'yes' })).not.toBeNull();
    expect(v({ mode: 'raw', value: '  ' })).not.toBeNull();
    expect(v({ mode: 'null', value: '' })).toBeNull();
    expect(v({ mode: 'text', value: '' })).toBeNull();
  });
});

describe('uninferable parameter fallback', () => {
  it('recognises the Postgres error and maps it back to the variable', () => {
    const bound = bindVariables('select :a, :b', {
      a: { mode: 'text', value: '1' },
      b: { mode: 'text', value: '2' },
    });
    const msg = 'could not determine data type of parameter $2';
    expect(isUninferableParamError(msg)).toBe(true);
    expect(isUninferableParamError('syntax error')).toBe(false);
    expect(uninferableParamName(msg, bound)).toBe('b');
    expect(uninferableParamName('nope', bound)).toBeNull();
  });
});
