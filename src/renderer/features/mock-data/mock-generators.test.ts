import { describe, expect, it } from 'vitest';
import {
  COUNTRY_CODES,
  GENERATOR_CHOICES,
  type GenKind,
  charLength,
  defaultKind,
  fitLength,
  generate,
} from './mock-generators';

const col = (dataType: string, kind: GenKind = 'auto', name = 'c', fixedValue = '') => ({
  name,
  dataType,
  kind,
  fixedValue,
});

describe('charLength', () => {
  it('parses Postgres character type widths', () => {
    expect(charLength('character(2)')).toBe(2);
    expect(charLength('char(3)')).toBe(3);
    expect(charLength('character varying(40)')).toBe(40);
    expect(charLength('varchar(10)')).toBe(10);
    expect(charLength('bpchar(1)')).toBe(1);
  });
  it('is undefined for unbounded / non-character types', () => {
    expect(charLength('text')).toBeUndefined();
    expect(charLength('character varying')).toBeUndefined();
    expect(charLength('numeric(10,2)')).toBeUndefined();
    expect(charLength('character varying(5)[]')).toBeUndefined();
    expect(charLength('bit(3)')).toBeUndefined();
  });
});

describe('defaultKind', () => {
  it('uses country codes for char(2) instead of lorem', () => {
    expect(defaultKind({ name: 'country', dataType: 'character(2)' })).toBe('country');
    expect(defaultKind({ name: 'whatever', dataType: 'character(2)' })).toBe('country');
  });
  it('uses letters for tiny widths and words for short varchars', () => {
    expect(defaultKind({ name: 'code', dataType: 'character(3)' })).toBe('letters');
    expect(defaultKind({ name: 'title', dataType: 'character varying(20)' })).toBe('word');
    expect(defaultKind({ name: 'bio', dataType: 'character varying(255)' })).toBe('lorem');
  });
  it('keeps name heuristics for wide enough varchars', () => {
    expect(defaultKind({ name: 'email', dataType: 'character varying(255)' })).toBe('email');
    expect(defaultKind({ name: 'first_name', dataType: 'varchar(50)' })).toBe('name-first');
  });
  it('keeps the type heuristics for other types', () => {
    expect(defaultKind({ name: 'id', dataType: 'uuid' })).toBe('uuid');
    expect(defaultKind({ name: 'n', dataType: 'integer' })).toBe('int');
    expect(defaultKind({ name: 'price', dataType: 'numeric(10,2)' })).toBe('numeric');
    expect(defaultKind({ name: 'created_at', dataType: 'text' })).toBe('timestamp');
    expect(defaultKind({ name: 'notes', dataType: 'text' })).toBe('lorem');
  });
  it('only returns selectable generators', () => {
    for (const t of ['character(1)', 'character(2)', 'varchar(4)', 'varchar(9)', 'text']) {
      expect(GENERATOR_CHOICES).toContain(defaultKind({ name: 'x', dataType: t }));
    }
  });
});

describe('fitLength', () => {
  it('truncates without leaving trailing spaces', () => {
    expect(fitLength('lorem ipsum', 6)).toBe('lorem');
    expect(fitLength('abc', 5)).toBe('abc');
    expect(fitLength('abc', undefined)).toBe('abc');
  });
});

describe('generate', () => {
  it('never exceeds the column width for any string generator', () => {
    const kinds: GenKind[] = [
      'auto',
      'name-first',
      'name-last',
      'name-full',
      'email',
      'url',
      'lorem',
      'word',
      'country',
      'letters',
      'uuid',
      'json',
      'timestamp',
      'date',
    ];
    for (const n of [1, 2, 3, 5, 8, 12]) {
      for (const kind of kinds) {
        for (let i = 0; i < 25; i++) {
          const v = generate(col(`character varying(${n})`, kind), i);
          expect(typeof v).toBe('string');
          expect((v as string).length).toBeLessThanOrEqual(n);
          expect((v as string).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('char(2) auto yields a two-letter country code', () => {
    for (let i = 0; i < 20; i++) {
      const v = generate(col('character(2)', 'auto', 'country'), i);
      expect(COUNTRY_CODES).toContain(v);
    }
  });

  it('uses the fixed value verbatim', () => {
    expect(generate(col('text', 'fixed', 'c', 'hello'), 0)).toBe('hello');
    expect(generate(col('character(2)', 'fixed', 'c', 'toolong'), 0)).toBe('toolong');
  });

  it('null generator yields SQL NULL', () => {
    expect(generate(col('text', 'null'), 0)).toBeNull();
  });

  it('is deterministic with an injected rng', () => {
    const rng = () => 0;
    expect(generate(col('text', 'name-first'), 0, rng)).toBe('Ada');
    expect(generate(col('integer', 'int'), 0, rng)).toBe(0);
  });
});
