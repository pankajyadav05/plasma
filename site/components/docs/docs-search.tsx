'use client';

import Link from 'next/link';
import { useId, useMemo, useRef, useState } from 'react';

export interface SearchEntry {
  /** Page title. */
  page: string;
  /** Heading text (the page title itself for page entries). */
  heading: string;
  href: string;
  /** Lower-cased haystack. */
  hay: string;
}

/** One section's readable text, from /docs/search.json. */
export interface FullTextEntry {
  page: string;
  heading: string;
  href: string;
  text: string;
}

interface Indexed extends SearchEntry {
  text: string;
  lower: string;
}

const SNIPPET = 110;

/** The words around the first match, cut at word boundaries. */
function snippet(e: Indexed, terms: string[]): string | null {
  const at = terms.map((t) => e.lower.indexOf(t)).filter((i) => i >= 0);
  if (at.length === 0) return null;
  const first = Math.min(...at);
  let start = Math.max(0, first - SNIPPET / 3);
  let end = Math.min(e.text.length, start + SNIPPET);
  if (start > 0) start = e.text.indexOf(' ', start) + 1 || start;
  if (end < e.text.length) end = e.text.lastIndexOf(' ', end) || end;
  return `${start > 0 ? '… ' : ''}${e.text.slice(start, end)}${end < e.text.length ? ' …' : ''}`;
}

/**
 * Client-side search. Titles and headings work at once; the full text of every
 * section is fetched from /docs/search.json the first time the box is used.
 * No library, nothing leaves the site.
 */
export function DocsSearch({ index, onNavigate }: { index: SearchEntry[]; onNavigate?: () => void }) {
  const [q, setQ] = useState('');
  const [full, setFull] = useState<Indexed[] | null>(null);
  const loading = useRef(false);
  const id = useId();

  const load = () => {
    if (full || loading.current) return;
    loading.current = true;
    fetch('/docs/search.json')
      .then((r) => (r.ok ? (r.json() as Promise<FullTextEntry[]>) : Promise.reject(new Error(String(r.status)))))
      .then((rows) =>
        setFull(
          rows.map((r) => ({
            ...r,
            lower: r.text.toLowerCase(),
            hay: `${r.heading} ${r.page} ${r.text}`.toLowerCase(),
          })),
        ),
      )
      .catch(() => {
        loading.current = false;
      });
  };

  const terms = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const results = useMemo(() => {
    if (terms.length === 0) return [];
    const pool: Indexed[] = full ?? index.map((e) => ({ ...e, text: '', lower: '' }));
    return pool
      .map((e) => {
        if (!terms.every((t) => e.hay.includes(t))) return null;
        const title = e.heading.toLowerCase();
        const score = terms.reduce(
          (s, t) => s + (title.startsWith(t) ? 6 : title.includes(t) ? 4 : e.page.toLowerCase().includes(t) ? 2 : 1),
          0,
        );
        return { e, score };
      })
      .filter((r): r is { e: Indexed; score: number } => r !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((r) => ({ ...r.e, snip: snippet(r.e, terms) }));
  }, [index, full, terms]);

  return (
    <div role="search" className="relative">
      <label htmlFor={id} className="sr-only">
        Search the docs
      </label>
      <input
        id={id}
        type="search"
        value={q}
        onFocus={load}
        onChange={(e) => {
          load();
          setQ(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setQ('');
        }}
        placeholder="Search the docs"
        autoComplete="off"
        spellCheck={false}
        className="docs-search h-10 w-full rounded-full border border-rule bg-paper-2 px-4 text-[14.5px] text-ink placeholder:text-ink-3 focus:border-ink"
      />
      <div aria-live="polite" className="sr-only">
        {terms.length > 0 ? `${results.length} results` : ''}
      </div>
      {terms.length > 0 && (
        <ul className="mt-2 max-h-[60vh] overflow-y-auto rounded-[12px] border border-rule bg-paper-2 p-1.5">
          {results.length === 0 && <li className="px-3 py-2 text-[14px] text-ink-2">Nothing matches.</li>}
          {results.map((r) => (
            <li key={r.href}>
              <Link
                href={r.href}
                onClick={() => {
                  setQ('');
                  onNavigate?.();
                }}
                className="block rounded-lg px-3 py-2 hover:bg-ink/[0.06]"
              >
                <span className="block text-[14.5px] font-semibold leading-snug text-ink">{r.heading}</span>
                {r.heading !== r.page && <span className="label block normal-case tracking-normal">{r.page}</span>}
                {r.snip && <span className="mt-1 block text-[13px] leading-snug text-ink-2">{r.snip}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
