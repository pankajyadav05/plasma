import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SNIPPETS,
  dedupeImports,
  escapeSnippetText,
  exportSnippetsJson,
  mergeSnippets,
  parseSnippetImport,
  prefixTaken,
  previewBody,
  removeSnippet,
  snippetBodyFromSelection,
  snippetTabStops,
  suggestPrefix,
  upsertSnippet,
  validateSnippet,
} from './snippets';

describe('built-in snippets', () => {
  it('are all valid, with unique prefixes', () => {
    for (const s of BUILTIN_SNIPPETS) expect(validateSnippet(s), s.name).toBeNull();
    const prefixes = BUILTIN_SNIPPETS.map((s) => s.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('cover the advertised set', () => {
    const names = BUILTIN_SNIPPETS.map((s) => s.name).join('|');
    for (const word of [
      'select where',
      'join',
      'upsert',
      'CTE',
      'window',
      'create index concurrently',
    ]) {
      expect(names.toLowerCase()).toContain(word.toLowerCase());
    }
  });

  it('every snippet has tab stops and ends with $0 or a closing stop', () => {
    for (const s of BUILTIN_SNIPPETS) {
      if (s.prefix === 'casew') continue;
      expect(snippetTabStops(s.body).length, s.name).toBeGreaterThan(0);
    }
    expect(snippetTabStops(BUILTIN_SNIPPETS.find((s) => s.prefix === 'upsert')!.body)).toEqual([
      '1:table',
      '2:id',
      '3:col',
      '4:1',
      '5:value',
      '0',
    ]);
  });

  it('create index concurrently really is CONCURRENTLY', () => {
    expect(BUILTIN_SNIPPETS.find((s) => s.prefix === 'cic')?.body).toContain(
      'CREATE INDEX CONCURRENTLY',
    );
  });
});

describe('selection to snippet', () => {
  it('escapes $, } and \\ so text inserts verbatim', () => {
    expect(escapeSnippetText("select '$1', {a}, 'x\\y'")).toBe("select '\\$1', {a\\}, 'x\\\\y'");
  });
  it('trims trailing whitespace and adds the final tab stop', () => {
    expect(snippetBodyFromSelection('select 1;\n\n')).toBe('select 1;$0');
    expect(
      validateSnippet({ name: 'n', prefix: 'p', body: snippetBodyFromSelection('select $$x$$') }),
    ).toBeNull();
  });
});

describe('validateSnippet', () => {
  const ok = { name: 'n', prefix: 'p', body: 'select ${1:x}' };
  it('accepts a good snippet', () => expect(validateSnippet(ok)).toBeNull());
  it('requires name, prefix, body and a simple prefix', () => {
    expect(validateSnippet({ ...ok, name: ' ' })).toMatch(/Name/);
    expect(validateSnippet({ ...ok, prefix: '' })).toMatch(/Prefix/);
    expect(validateSnippet({ ...ok, prefix: 'a b' })).toMatch(/Prefix/);
    expect(validateSnippet({ ...ok, body: '' })).toMatch(/Body/);
  });
  it('catches an unclosed placeholder but allows an escaped one', () => {
    expect(validateSnippet({ ...ok, body: 'select ${1:x' })).toMatch(/Unclosed/);
    expect(validateSnippet({ ...ok, body: 'select \\${1:x' })).toBeNull();
  });
});

describe('suggestPrefix', () => {
  it('uses initials of multi-word names', () => {
    expect(suggestPrefix('Top N per group')).toBe('tnpg');
    expect(suggestPrefix('join')).toBe('join');
    expect(suggestPrefix('  !!! ')).toBe('');
  });
});

describe('import / export', () => {
  const list = [{ name: 'a', prefix: 'aa', description: 'd', body: 'select ${1}' }];

  it('round-trips through JSON', () => {
    const r = parseSnippetImport(exportSnippetsJson(list));
    expect(r.skipped).toEqual([]);
    expect(r.snippets).toEqual(list);
  });

  it('reads a bare array', () => {
    expect(parseSnippetImport(JSON.stringify(list)).snippets).toEqual(list);
  });

  it('reads the VS Code format (array bodies, array prefixes, key as name)', () => {
    const r = parseSnippetImport(
      JSON.stringify({
        'Select top': {
          prefix: ['st', 'selt'],
          body: ['SELECT *', 'FROM ${1:t}', 'LIMIT 10;'],
          description: 'x',
        },
      }),
    );
    expect(r.snippets).toEqual([
      {
        name: 'Select top',
        prefix: 'st',
        description: 'x',
        body: 'SELECT *\nFROM ${1:t}\nLIMIT 10;',
      },
    ]);
  });

  it('skips bad entries with a reason and never throws', () => {
    const r = parseSnippetImport(
      JSON.stringify({
        snippets: [list[0], { name: 'x' }, 7, { name: 'y', prefix: 'bad prefix', body: 'z' }],
      }),
    );
    expect(r.snippets).toHaveLength(1);
    expect(r.skipped).toHaveLength(3);
    expect(parseSnippetImport('not json').skipped[0]).toMatch(/valid JSON/);
    expect(parseSnippetImport('42').snippets).toEqual([]);
  });

  it('dedupes by prefix and body', () => {
    const incoming = [...list, list[0]!, { ...list[0]!, body: 'other' }];
    const { fresh, duplicates } = dedupeImports(incoming, list);
    expect(fresh).toEqual([{ ...list[0]!, body: 'other' }]);
    expect(duplicates).toBe(2);
  });
});

describe('user snippet list', () => {
  const def = { name: ' Mine ', prefix: ' mn ', description: ' d ', body: 'select 1$0' };
  let n = 0;
  const id = () => `id${++n}`;

  it('adds new snippets first, trimmed, with timestamps', () => {
    const a = upsertSnippet([], def, 10, id);
    const b = upsertSnippet(a, { ...def, prefix: 'other' }, 20, id);
    expect(b.map((s) => s.prefix)).toEqual(['other', 'mn']);
    expect(a[0]).toMatchObject({
      name: 'Mine',
      prefix: 'mn',
      description: 'd',
      createdAt: 10,
      updatedAt: 10,
    });
  });

  it('updates in place by id and keeps createdAt', () => {
    const [first] = upsertSnippet([], def, 10, id);
    const next = upsertSnippet([first!], { ...def, id: first!.id, body: 'select 2$0' }, 30, id);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: first!.id,
      body: 'select 2$0',
      createdAt: 10,
      updatedAt: 30,
    });
  });

  it('removes by id', () => {
    const list = upsertSnippet([], def, 1, id);
    expect(removeSnippet(list, list[0]!.id)).toEqual([]);
    expect(removeSnippet(list, 'nope')).toHaveLength(1);
  });

  it('detects a taken prefix, ignoring case and the snippet itself', () => {
    const list = upsertSnippet([], def, 1, id);
    expect(prefixTaken(list, 'MN')).toBe(true);
    expect(prefixTaken(list, 'mn', list[0]!.id)).toBe(false);
    expect(prefixTaken(list, 'zz')).toBe(false);
  });

  it('merges: user snippets win over a built-in with the same prefix', () => {
    const merged = mergeSnippets([{ name: 'mine', prefix: 'SELW', description: '', body: 'x' }]);
    expect(merged[0]).toMatchObject({ prefix: 'SELW', source: 'user' });
    expect(merged.filter((s) => s.prefix.toLowerCase() === 'selw')).toHaveLength(1);
    expect(merged.some((s) => s.source === 'builtin')).toBe(true);
  });
});

describe('previewBody', () => {
  it('shows placeholder defaults and drops bare tab stops and escapes', () => {
    expect(previewBody('SELECT ${1:cols} FROM ${2|a,b|} WHERE x = \\$1$0')).toBe(
      'SELECT cols FROM a WHERE x = $1',
    );
    expect(previewBody('a $1 b ${2} c')).toBe('a  b  c');
  });
});
