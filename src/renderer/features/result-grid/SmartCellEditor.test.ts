import { describe, expect, it } from 'vitest';
import { checkDraft } from './SmartCellEditor';

describe('checkDraft (smart editor validation)', () => {
  it('accepts NULL for every kind', () => {
    for (const kind of ['json', 'array', 'date', 'uuid', 'enum', 'bool', 'bytea'] as const) {
      expect(checkDraft(kind, 'x', ['a'], null)).toEqual({ error: null, warning: null });
    }
  });
  it('blocks invalid JSON with a position, allows valid', () => {
    expect(checkDraft('json', 'jsonb', null, '{"a": }').error).toMatch(/Invalid JSON: .*line 1/);
    expect(checkDraft('json', 'jsonb', null, '{"a": 1}').error).toBeNull();
  });
  it('validates array elements against the element type', () => {
    expect(checkDraft('array', 'int4[]', null, '{1,2,x}').error).toBe(
      'Element 3: Expected a whole number',
    );
    expect(checkDraft('array', '_int4', null, '{1,NULL,3}').error).toBeNull();
    expect(checkDraft('array', 'mood[]', ['sad', 'ok'], '{sad,angry}').error).toMatch(/Element 2/);
  });
  it('falls back to text editing with a note for arrays a list cannot show', () => {
    const c = checkDraft('array', 'int4[]', null, '{{1,2},{3,4}}');
    expect(c.error).toBeNull();
    expect(c.warning).toMatch(/multi-dimensional/);
  });
  it('warns (does not block) on unrecognised temporal text', () => {
    expect(checkDraft('timestamptz', 'timestamptz', null, '2024-03-09 10:11:12+05:30')).toEqual({
      error: null,
      warning: null,
    });
    expect(checkDraft('date', 'date', null, 'next friday').warning).toMatch(
      /Not a recognised date/,
    );
    expect(checkDraft('date', 'date', null, '').warning).toMatch(/use NULL/);
    expect(checkDraft('timestamp', 'timestamp', null, 'infinity')).toEqual({
      error: null,
      warning: null,
    });
  });
  it('requires enum labels and boolean spellings', () => {
    expect(checkDraft('enum', 'mood', ['sad', 'ok'], 'ok').error).toBeNull();
    expect(checkDraft('enum', 'mood', ['sad', 'ok'], 'meh').error).toMatch(
      /not one of the enum labels/,
    );
    expect(checkDraft('bool', 'bool', null, 'true').error).toBeNull();
    expect(checkDraft('bool', 'bool', null, 'maybe').error).toMatch(/true or false/);
  });
  it('warns on malformed uuids', () => {
    expect(
      checkDraft('uuid', 'uuid', null, '123e4567-e89b-12d3-a456-426614174000').warning,
    ).toBeNull();
    expect(checkDraft('uuid', 'uuid', null, 'nope').warning).toMatch(/Not a UUID/);
  });
});
