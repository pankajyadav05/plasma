import { describe, expect, it } from 'vitest';
import { pgTypeName } from './pg-type-oids';

describe('pgTypeName', () => {
  it('names base, bpchar and array types', () => {
    expect(pgTypeName(23)).toBe('int4');
    expect(pgTypeName(1042)).toBe('bpchar');
    expect(pgTypeName(1007)).toBe('int4[]');
    expect(pgTypeName(1009)).toBe('text[]');
    expect(pgTypeName(1115)).toBe('timestamp[]');
    expect(pgTypeName(17)).toBe('bytea');
  });

  it('falls back to oid:N for extension types', () => {
    expect(pgTypeName(987654)).toBe('oid:987654');
  });
});
