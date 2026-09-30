import type { SchemaInfo } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import {
  displayText,
  editorText,
  enumValuesFor,
  fieldEditorKind,
  validateFieldInput,
} from './details-fields';

const schema = {
  schemas: [],
  tables: [],
  columns: [],
  foreignKeys: [],
  routines: [],
  sequences: [],
  types: [
    { schema: 'public', name: 'mood', kind: 'enum', values: ['sad', 'ok', 'happy'] },
    { schema: 'public', name: 'pos', kind: 'composite' },
  ],
  extensions: [],
} as unknown as SchemaInfo;

describe('fieldEditorKind', () => {
  it('picks typed editors', () => {
    expect(fieldEditorKind('bool')).toBe('bool');
    expect(fieldEditorKind('jsonb')).toBe('json');
    expect(fieldEditorKind('json')).toBe('json');
    expect(fieldEditorKind('mood', ['a'])).toBe('enum');
    expect(fieldEditorKind('text')).toBe('text');
    expect(fieldEditorKind('varchar(20)')).toBe('text');
  });
  it('arrays always edit as text literals', () => {
    expect(fieldEditorKind('_bool')).toBe('text');
    expect(fieldEditorKind('jsonb[]')).toBe('text');
  });
});

describe('enumValuesFor', () => {
  it('finds enum labels by bare or qualified name', () => {
    expect(enumValuesFor(schema, 'mood')).toEqual(['sad', 'ok', 'happy']);
    expect(enumValuesFor(schema, 'public.mood')).toEqual(['sad', 'ok', 'happy']);
  });
  it('ignores non-enum and unknown types', () => {
    expect(enumValuesFor(schema, 'pos')).toBeNull();
    expect(enumValuesFor(schema, 'text')).toBeNull();
    expect(enumValuesFor(null, 'mood')).toBeNull();
  });
});

describe('displayText', () => {
  it('does not JSON-quote scalars', () => {
    expect(displayText('hello', 'text')).toBe('hello');
    expect(displayText(42, 'int4')).toBe('42');
    expect(displayText(true, 'bool')).toBe('true');
    // The worker hands dates over as Postgres text.
    const d = '2024-01-02 03:04:05';
    expect(displayText(d, 'timestamp')).not.toMatch(/^"/);
    expect(displayText(d, 'timestamp')).toContain('2024-01-02');
  });
  it('pretty-prints json documents and json text', () => {
    expect(displayText({ a: 1 }, 'jsonb')).toBe('{\n  "a": 1\n}');
    expect(displayText('{"a":1}', 'text')).toBe('{\n  "a": 1\n}');
  });
  it('renders arrays as Postgres literals', () => {
    expect(displayText([1, 2], '_int4')).toBe('{1,2}');
  });
});

describe('editorText / validateFieldInput', () => {
  it('seeds the editor with Postgres text', () => {
    expect(editorText(null, 'text')).toBe('');
    expect(editorText({ a: 1 }, 'jsonb')).toBe('{\n  "a": 1\n}');
    expect(editorText(false, 'bool')).toBe('false');
  });
  it('validates JSON only for json editors', () => {
    expect(validateFieldInput('json', '{"a":1}')).toBeNull();
    expect(validateFieldInput('json', '{a:1}')).toMatch(/Invalid JSON/);
    expect(validateFieldInput('text', '{a:1}')).toBeNull();
  });
});
