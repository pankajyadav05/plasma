import { describe, expect, it } from 'vitest';
import { parsePgText } from './pg-type-parsers';

describe('pg type parsers', () => {
  it('keeps date and timestamp text verbatim (no JS Date, no UTC shift)', () => {
    expect(parsePgText(1082, '2026-09-29')).toBe('2026-09-29');
    expect(parsePgText(1114, '2024-01-05 10:11:12.123456')).toBe('2024-01-05 10:11:12.123456');
    expect(parsePgText(1184, '2024-01-05 10:11:12.123456+05:30')).toBe(
      '2024-01-05 10:11:12.123456+05:30',
    );
    expect(parsePgText(1083, '10:11:12')).toBe('10:11:12');
    expect(parsePgText(1182, '{2024-01-01,2024-01-02}')).toBe('{2024-01-01,2024-01-02}');
  });

  it('keeps interval, bytea, numeric, int8 and money as Postgres text', () => {
    expect(parsePgText(1186, '3 days 04:05:06')).toBe('3 days 04:05:06');
    expect(parsePgText(17, '\\xdeadbeef')).toBe('\\xdeadbeef');
    expect(parsePgText(1700, '12345678901234567890.000001')).toBe('12345678901234567890.000001');
    expect(parsePgText(20, '9007199254740993')).toBe('9007199254740993');
    expect(parsePgText(1231, '{1.10,2.20}')).toBe('{1.10,2.20}');
    expect(parsePgText(1007, '{1,2,3}')).toBe('{1,2,3}');
    expect(parsePgText(600, '(1,2)')).toBe('(1,2)');
  });

  it('still parses exact scalar types and json', () => {
    expect(parsePgText(23, '42')).toBe(42);
    expect(parsePgText(16, 't')).toBe(true);
    expect(parsePgText(701, '0.1')).toBe(0.1);
    expect(parsePgText(3802, '{"a":1}')).toEqual({ a: 1 });
  });
});
