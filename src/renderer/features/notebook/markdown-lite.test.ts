import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeHref } from './markdown-lite';

describe('safeHref', () => {
  it('allows http(s) and mailto only', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('mailto:a@b.co')).toBe('mailto:a@b.co');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>')).toBeNull();
    expect(safeHref('file:///etc/passwd')).toBeNull();
    expect(safeHref('//evil.com')).toBeNull();
  });
});

describe('parseInline', () => {
  it('parses code, bold, italic and links', () => {
    expect(parseInline('a `b` **c** *d* [e](https://x.io)')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'code', v: 'b' },
      { t: 'text', v: ' ' },
      { t: 'strong', c: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 'em', c: [{ t: 'text', v: 'd' }] },
      { t: 'text', v: ' ' },
      { t: 'link', href: 'https://x.io', c: [{ t: 'text', v: 'e' }] },
    ]);
  });

  it('keeps raw HTML as text and never makes unsafe links', () => {
    const nodes = parseInline('<img src=x onerror=alert(1)> [x](javascript:alert(1))');
    expect(nodes.every((n) => n.t === 'text')).toBe(true);
    expect(nodes.map((n) => (n.t === 'text' ? n.v : '')).join('')).toContain('<img src=x');
  });

  it('does not italicise snake_case identifiers', () => {
    expect(parseInline('my_table_name')).toEqual([{ t: 'text', v: 'my_table_name' }]);
  });
});

describe('parseMarkdown', () => {
  it('parses headings, paragraphs, lists, quotes, fences and rules', () => {
    const blocks = parseMarkdown(
      [
        '# Title',
        '',
        'line one',
        'line two',
        '',
        '- a',
        '- b',
        '',
        '1. x',
        '2. y',
        '',
        '> q',
        '',
        '```sql',
        'SELECT 1;',
        '```',
        '',
        '---',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'p', 'ul', 'ol', 'quote', 'code', 'hr']);
    expect(blocks[1]).toEqual({ t: 'p', c: [{ t: 'text', v: 'line one line two' }] });
    expect(blocks[5]).toEqual({ t: 'code', lang: 'sql', v: 'SELECT 1;' });
  });

  it('treats a script tag as paragraph text', () => {
    const [b] = parseMarkdown('<script>alert(1)</script>');
    expect(b).toEqual({ t: 'p', c: [{ t: 'text', v: '<script>alert(1)</script>' }] });
  });

  it('survives an unterminated fence', () => {
    expect(parseMarkdown('```\nabc')).toEqual([{ t: 'code', lang: '', v: 'abc' }]);
  });
});
