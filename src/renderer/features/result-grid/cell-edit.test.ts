import { describe, expect, it } from 'vitest';
import { arrayElementType, cellToText, isNoopEdit, toPgArrayLiteral } from './cell-edit';

describe('cellToText', () => {
  it('keeps NULL distinct from the empty string', () => {
    expect(cellToText(null, 'text')).toBeNull();
    expect(cellToText(undefined, 'text')).toBeNull();
    expect(cellToText('', 'text')).toBe('');
  });

  it('serialises json/jsonb documents as JSON text', () => {
    expect(cellToText({ a: 1, b: [1, 2] }, 'jsonb')).toBe('{"a":1,"b":[1,2]}');
    expect(cellToText([1, 'x'], 'json')).toBe('[1,"x"]');
    expect(cellToText(true, 'jsonb')).toBe('true');
    // A parsed JSON string scalar keeps its quotes.
    expect(cellToText('hello', 'jsonb')).toBe('"hello"');
    // Raw JSON text from the worker is kept verbatim.
    expect(cellToText('{"a": 1}', 'jsonb')).toBe('{"a": 1}');
  });

  it('serialises arrays as Postgres array literals', () => {
    expect(cellToText([1, 2, 3], '_int4')).toBe('{1,2,3}');
    expect(cellToText(['a b', 'c', null, '', 'NULL', 'q"x'], 'text[]')).toBe(
      '{"a b",c,NULL,"","NULL","q\\"x"}',
    );
    expect(
      cellToText(
        [
          [1, 2],
          [3, 4],
        ],
        '_int4',
      ),
    ).toBe('{{1,2},{3,4}}');
    // Unknown type name (oid:1007) still detects the JS array.
    expect(cellToText([1, 2], 'oid:1007')).toBe('{1,2}');
  });

  it('passes date / timestamp text from the worker through untouched', () => {
    expect(cellToText('2026-09-29', 'date')).toBe('2026-09-29');
    expect(cellToText('2026-09-29 13:05:09.120', 'timestamp')).toBe('2026-09-29 13:05:09.120');
  });

  it('formats booleans, numbers, bytea and interval', () => {
    expect(cellToText(false, 'bool')).toBe('false');
    expect(cellToText(12.5, 'numeric')).toBe('12.5');
    expect(cellToText('9007199254740993', 'int8')).toBe('9007199254740993');
    expect(cellToText(new Uint8Array([0xde, 0xad]), 'bytea')).toBe('\\xdead');
    expect(cellToText({ 0: 222, 1: 173 }, 'bytea')).toBe('\\xdead');
    expect(cellToText({ days: 3 }, 'interval')).toBe('P3D');
    expect(cellToText({ hours: 1, minutes: 30 }, 'interval')).toBe('PT1H30M');
  });
});

describe('isNoopEdit', () => {
  it('treats NULL → NULL as a no-op and NULL → "" as a change', () => {
    expect(isNoopEdit(null, null, 'text')).toBe(true);
    expect(isNoopEdit(null, '', 'text')).toBe(false);
    expect(isNoopEdit('', null, 'text')).toBe(false);
  });

  it('compares by Postgres text', () => {
    expect(isNoopEdit(42, '42', 'int4')).toBe(true);
    expect(isNoopEdit(42, '43', 'int4')).toBe(false);
    expect(isNoopEdit(true, 'true', 'bool')).toBe(true);
    expect(isNoopEdit([1, 2], '{1,2}', '_int4')).toBe(true);
  });

  it('ignores JSON whitespace differences', () => {
    expect(isNoopEdit({ a: 1 }, '{ "a": 1 }', 'jsonb')).toBe(true);
    expect(isNoopEdit({ a: 1 }, '{"a":2}', 'jsonb')).toBe(false);
  });
});

describe('array helpers', () => {
  it('derives element types', () => {
    expect(arrayElementType('_int4')).toBe('int4');
    expect(arrayElementType('text[]')).toBe('text');
    expect(arrayElementType('text')).toBeNull();
  });

  it('formats json[] elements', () => {
    expect(toPgArrayLiteral([{ a: 1 }], 'jsonb')).toBe('{"{\\"a\\":1}"}');
  });
});
