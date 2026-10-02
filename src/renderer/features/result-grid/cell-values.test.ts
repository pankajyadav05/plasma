import { describe, expect, it } from 'vitest';
import {
  BYTEA_EDIT_MAX_BYTES,
  base64ToBytes,
  boolText,
  byteaEditable,
  byteaSize,
  byteaToBytes,
  bytesToBase64,
  bytesToByteaText,
  checkTemporal,
  cycleBool,
  enumLabelsFor,
  formatHexView,
  formatOffset,
  formatPgArray,
  fromDatetimeLocal,
  generateUuid,
  isUuid,
  joinTemporal,
  jsonDeleteAt,
  jsonLeafText,
  jsonSetAt,
  locateJsonError,
  minifyJson,
  nowText,
  offsetOf,
  parseBool,
  parseHexInput,
  parseJson,
  parseJsonLeaf,
  parsePgArray,
  prettyJson,
  smartEditorKind,
  splitTemporal,
  toDatetimeLocal,
  validateScalar,
} from './cell-values';

describe('smartEditorKind', () => {
  it('routes types to editors', () => {
    expect(smartEditorKind('jsonb')).toBe('json');
    expect(smartEditorKind('int4[]')).toBe('array');
    expect(smartEditorKind('_text')).toBe('array');
    expect(smartEditorKind('date')).toBe('date');
    expect(smartEditorKind('timetz')).toBe('time');
    expect(smartEditorKind('timestamp')).toBe('timestamp');
    expect(smartEditorKind('timestamptz')).toBe('timestamptz');
    expect(smartEditorKind('bool')).toBe('bool');
    expect(smartEditorKind('uuid')).toBe('uuid');
    expect(smartEditorKind('bytea')).toBe('bytea');
    expect(smartEditorKind('mood', ['sad', 'ok'])).toBe('enum');
    expect(smartEditorKind('text')).toBe('text');
    expect(smartEditorKind('interval')).toBe('text');
    expect(smartEditorKind('mood', [])).toBe('text');
  });
  it('finds enum labels by bare or qualified name', () => {
    const schema = {
      types: [{ schema: 'app', name: 'mood', kind: 'enum' as const, values: ['sad', 'ok'] }],
    };
    expect(enumLabelsFor(schema, 'mood')).toEqual(['sad', 'ok']);
    expect(enumLabelsFor(schema, 'app.mood')).toEqual(['sad', 'ok']);
    expect(enumLabelsFor(schema, 'text')).toBeNull();
    expect(enumLabelsFor(null, 'mood')).toBeNull();
  });
});

describe('json', () => {
  it('validates with line and column', () => {
    const bad = parseJson('{\n  "a": 1,\n  "b": }');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/line 3/);
    expect(parseJson('[1,2]')).toEqual({ ok: true, value: [1, 2] });
  });
  it('pretty-prints and minifies, null on invalid', () => {
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(minifyJson('{ "a" : [ 1, 2 ] }')).toBe('{"a":[1,2]}');
    expect(prettyJson('{oops')).toBeNull();
    expect(minifyJson('')).toBeNull();
  });
  it('edits by path immutably', () => {
    const doc = { a: { b: [1, 2, 3] }, c: 'x' };
    const next = jsonSetAt(doc, ['a', 'b', 1], 20) as typeof doc;
    expect(next.a.b).toEqual([1, 20, 3]);
    expect(doc.a.b).toEqual([1, 2, 3]);
    expect(jsonSetAt(doc, ['d', 'e'], true)).toEqual({ ...doc, d: { e: true } });
    expect(jsonDeleteAt(doc, ['a', 'b', 0])).toEqual({ a: { b: [2, 3] }, c: 'x' });
    expect(jsonDeleteAt(doc, ['c'])).toEqual({ a: { b: [1, 2, 3] } });
    expect(jsonSetAt(doc, [], 5)).toBe(5);
  });
  it('types tree leaves from what the user typed', () => {
    expect(parseJsonLeaf('12')).toBe(12);
    expect(parseJsonLeaf('true')).toBe(true);
    expect(parseJsonLeaf('null')).toBeNull();
    expect(parseJsonLeaf('"12"')).toBe('12');
    expect(parseJsonLeaf('hello')).toBe('hello');
    expect(parseJsonLeaf('{"a":1}')).toBe('{"a":1}');
    expect(jsonLeafText('12')).toBe('"12"');
    expect(jsonLeafText(12)).toBe('12');
  });
});

describe('pg arrays', () => {
  it('parses simple, quoted and NULL elements', () => {
    expect(parsePgArray('{1,2,3}')).toEqual({ ok: true, elements: ['1', '2', '3'] });
    expect(parsePgArray('{}')).toEqual({ ok: true, elements: [] });
    expect(parsePgArray('{"a b",NULL,"NULL","x\\"y","c,d"}')).toEqual({
      ok: true,
      elements: ['a b', null, 'NULL', 'x"y', 'c,d'],
    });
    expect(parsePgArray(' { a , b } ')).toEqual({ ok: true, elements: ['a', 'b'] });
  });
  it('refuses what a flat list cannot represent', () => {
    expect(parsePgArray('{{1,2},{3,4}}').ok).toBe(false);
    expect(parsePgArray('[0:1]={1,2}').ok).toBe(false);
    expect(parsePgArray('nope').ok).toBe(false);
    expect(parsePgArray('{"open}').ok).toBe(false);
  });
  it('formats with minimal quoting and round-trips', () => {
    const els = ['a b', null, 'NULL', 'x"y', 'c,d', '', 'plain', 'back\\slash'];
    const text = formatPgArray(els);
    expect(text).toBe('{"a b",NULL,"NULL","x\\"y","c,d","",plain,"back\\\\slash"}');
    expect(parsePgArray(text)).toEqual({ ok: true, elements: els });
    expect(formatPgArray([])).toBe('{}');
  });
  it('validates typed elements', () => {
    expect(validateScalar('int4', '12')).toBeNull();
    expect(validateScalar('int4', '1.5')).toMatch(/whole number/);
    expect(validateScalar('numeric', '-1.5e3')).toBeNull();
    expect(validateScalar('float8', 'abc')).toMatch(/number/);
    expect(validateScalar('bool', 'yes')).toBeNull();
    expect(validateScalar('bool', 'maybe')).toMatch(/true or false/);
    expect(validateScalar('uuid', '123e4567-e89b-12d3-a456-426614174000')).toBeNull();
    expect(validateScalar('uuid', 'x')).toMatch(/UUID/);
    expect(validateScalar('date', '2024-02-30')).toMatch(/calendar/);
    expect(validateScalar('mood', 'sad', ['sad', 'ok'])).toBeNull();
    expect(validateScalar('mood', 'angry', ['sad', 'ok'])).toMatch(/enum/);
    expect(validateScalar('text', 'anything')).toBeNull();
  });
});

describe('booleans', () => {
  it('parses Postgres boolean spellings', () => {
    expect(parseBool('t')).toBe(true);
    expect(parseBool('FALSE')).toBe(false);
    expect(parseBool('0')).toBe(false);
    expect(parseBool(null)).toBeNull();
    expect(parseBool('maybe')).toBeUndefined();
  });
  it('cycles NULL → true → false → NULL in both directions', () => {
    expect(cycleBool(null)).toBe(true);
    expect(cycleBool(true)).toBe(false);
    expect(cycleBool(false)).toBeNull();
    expect(cycleBool(null, true)).toBe(false);
    expect(cycleBool(true, true)).toBeNull();
    expect(boolText(true)).toBe('true');
    expect(boolText(false)).toBe('false');
    expect(boolText(null)).toBeNull();
  });
});

describe('uuid', () => {
  it('generates valid v4 uuids', () => {
    for (let i = 0; i < 5; i++) {
      const u = generateUuid();
      expect(isUuid(u)).toBe(true);
      expect(u[14]).toBe('4');
    }
    const fixed = generateUuid(() => new Uint8Array(16).fill(255));
    expect(fixed).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(isUuid('nope')).toBe(false);
  });
});

describe('temporal', () => {
  it('splits and joins each flavour', () => {
    expect(splitTemporal('2024-03-09', 'date')).toEqual({ date: '2024-03-09', time: '', tz: '' });
    expect(splitTemporal('2024-03-09 10:11:12.5', 'timestamp')).toEqual({
      date: '2024-03-09',
      time: '10:11:12.5',
      tz: '',
    });
    expect(splitTemporal('2024-03-09 10:11:12+05:30', 'timestamptz')).toEqual({
      date: '2024-03-09',
      time: '10:11:12',
      tz: '+05:30',
    });
    expect(splitTemporal('2024-03-09T10:11:12Z', 'timestamptz')?.tz).toBe('Z');
    expect(splitTemporal('10:11:12-08', 'timetz')).toEqual({
      date: '',
      time: '10:11:12',
      tz: '-08',
    });
    expect(splitTemporal('10:11', 'time')?.time).toBe('10:11');
    expect(splitTemporal('infinity', 'timestamp')).toBeNull();
    expect(joinTemporal({ date: '2024-03-09', time: '10:11', tz: '+05:30' }, 'timestamptz')).toBe(
      '2024-03-09 10:11:00+05:30',
    );
    expect(joinTemporal({ date: '2024-03-09', time: '10:11:12', tz: '+01' }, 'timestamp')).toBe(
      '2024-03-09 10:11:12',
    );
    expect(joinTemporal({ date: '', time: '10:11', tz: '' }, 'time')).toBe('10:11:00');
  });
  it('round-trips through datetime-local', () => {
    expect(toDatetimeLocal('2024-03-09 10:11:12+05:30', 'timestamptz')).toBe('2024-03-09T10:11:12');
    expect(toDatetimeLocal('2024-03-09 10:11:12.123456', 'timestamp')).toBe(
      '2024-03-09T10:11:12.123',
    );
    expect(toDatetimeLocal('garbage', 'timestamp')).toBe('');
    expect(fromDatetimeLocal('2024-03-09T10:11:12', '+05:30', 'timestamptz')).toBe(
      '2024-03-09 10:11:12+05:30',
    );
    expect(fromDatetimeLocal('2024-03-09T10:11', '', 'timestamp')).toBe('2024-03-09 10:11:00');
  });
  it('reads the stored offset', () => {
    expect(offsetOf('2024-03-09 10:11:12-08', 'timestamptz')).toBe('-08');
    expect(offsetOf('2024-03-09 10:11:12', 'timestamp')).toBe('');
  });
  it('warns about unparseable or impossible values, accepts specials', () => {
    expect(checkTemporal('date', '2024-02-29')).toBeNull();
    expect(checkTemporal('date', '2023-02-29')).toMatch(/calendar/);
    expect(checkTemporal('date', '2024-13-01')).toMatch(/calendar/);
    expect(checkTemporal('timestamp', '2024-01-01 25:00:00')).toMatch(/valid time/);
    expect(checkTemporal('timestamp', '2024-01-01 24:00:00')).toBeNull();
    expect(checkTemporal('timestamptz', 'infinity')).toBeNull();
    expect(checkTemporal('timestamptz', 'now')).toBeNull();
    expect(checkTemporal('date', 'next tuesday')).toMatch(/Not a recognised date/);
  });
  it('writes "now" from the local clock', () => {
    const d = new Date(2024, 2, 9, 4, 5, 6);
    expect(nowText('date', d)).toBe('2024-03-09');
    expect(nowText('time', d)).toBe('04:05:06');
    expect(nowText('timestamp', d)).toBe('2024-03-09 04:05:06');
    expect(nowText('timestamptz', d)).toMatch(/^2024-03-09 04:05:06[+-]\d{2}(:\d{2})?$/);
  });
  it('formats offsets', () => {
    expect(formatOffset(330)).toBe('+05:30');
    expect(formatOffset(-480)).toBe('-08');
    expect(formatOffset(0)).toBe('+00');
  });
});

describe('bytea', () => {
  it('decodes and encodes hex text', () => {
    const b = byteaToBytes('\\xdeadbeef');
    expect([...b!]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(bytesToByteaText(b!)).toBe('\\xdeadbeef');
    expect(byteaToBytes('\\xabc')).toBeNull();
    expect(byteaToBytes('plain')).toBeNull();
    expect(byteaToBytes('\\x')).toEqual(new Uint8Array(0));
    expect(byteaSize('\\xdeadbeef')).toBe(4);
    expect(byteaSize('nope')).toBeNull();
  });
  it('round-trips base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe('AAEC+vv8/Q==');
    expect([...base64ToBytes(b64)!]).toEqual([...bytes]);
    expect(base64ToBytes('AAEC+vv8/Q')).toBeNull();
    expect(base64ToBytes('!!!!')).toBeNull();
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
  });
  it('parses hex typed by users and formats a hex view', () => {
    expect([...parseHexInput('de ad\nBE ef')!]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect([...parseHexInput('0xdead')!]).toEqual([0xde, 0xad]);
    expect([...parseHexInput('\\xdead')!]).toEqual([0xde, 0xad]);
    expect(parseHexInput('xyz')).toBeNull();
    expect(parseHexInput('abc')).toBeNull();
    expect(formatHexView(new Uint8Array(17).fill(1))).toBe(`${Array(16).fill('01').join(' ')}\n01`);
  });
  it('is only editable when small', () => {
    expect(byteaEditable(null)).toBe(true);
    expect(byteaEditable('\\xdead')).toBe(true);
    expect(byteaEditable(`\\x${'00'.repeat(BYTEA_EDIT_MAX_BYTES)}`)).toBe(true);
    expect(byteaEditable(`\\x${'00'.repeat(BYTEA_EDIT_MAX_BYTES + 1)}`)).toBe(false);
    expect(byteaEditable('not hex')).toBe(false);
  });
});

describe('locateJsonError', () => {
  it('points at the first problem', () => {
    expect(locateJsonError('{"a": 1,}')?.at).toBe(8);
    expect(locateJsonError('[1, 2')?.message).toMatch(/end of JSON/);
    expect(locateJsonError('{"a" 1}')?.message).toMatch(/Expected ':'/);
    expect(locateJsonError('{"a": tru}')?.message).toMatch(/Unexpected token 't'/);
    expect(locateJsonError('"abc')?.message).toMatch(/Unterminated/);
    expect(locateJsonError('1 2')?.message).toMatch(/after the JSON value/);
  });
  it('accepts valid documents', () => {
    for (const ok of [
      '{}',
      '[]',
      '0',
      '-1.5e3',
      'null',
      '"a\\n"',
      '{"a":[1,{"b":null}],"c":"\\u00e9"}',
      ' [ 1 , 2 ] ',
    ]) {
      expect(locateJsonError(ok)).toBeNull();
      expect(parseJson(ok).ok).toBe(true);
    }
  });
});
