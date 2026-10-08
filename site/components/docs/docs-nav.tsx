'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { DocsSearch, type SearchEntry } from './docs-search';

export interface NavGroup {
  group: string;
  pages: { slug: string; title: string }[];
}

/** Sidebar content: search, then every page grouped. The current page is marked. */
export function DocsNav({ groups, index }: { groups: NavGroup[]; index: SearchEntry[] }) {
  const path = usePathname();
  const current = path?.replace(/\/+$/, '').split('/').filter(Boolean)[1] ?? null;
  const overview = (path ?? '').replace(/\/+$/, '') === '/docs';
  return (
    <div className="flex flex-col gap-6">
      <DocsSearch index={index} />
      <nav aria-label="Documentation">
        <Link
          href="/docs/"
          aria-current={overview ? 'page' : undefined}
          className={cn(
            'mb-4 block rounded-lg px-3 py-1.5 text-[15px] font-semibold',
            overview ? 'bg-ink text-paper' : 'text-ink hover:bg-ink/[0.06]',
          )}
        >
          Overview
        </Link>
        {groups.map((g) => (
          <div key={g.group} className="mb-5">
            <p className="label px-3 pb-1.5 text-ink-3">{g.group}</p>
            <ul>
              {g.pages.map((p) => {
                const on = p.slug === current;
                return (
                  <li key={p.slug}>
                    <Link
                      href={`/docs/${p.slug}/`}
                      aria-current={on ? 'page' : undefined}
                      className={cn(
                        'block rounded-lg px-3 py-1.5 text-[15px] leading-snug',
                        on ? 'bg-ink font-semibold text-paper' : 'text-ink-2 hover:bg-ink/[0.06] hover:text-ink',
                      )}
                    >
                      {p.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}
