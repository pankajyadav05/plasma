'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

export interface TocItem {
  id: string;
  title: string;
  level: 2 | 3;
}

/** "On this page": follows the heading nearest the top of the viewport. */
export function Toc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState<string | null>(items[0]?.id ?? null);

  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => e != null);
    if (els.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: '-80px 0px -70% 0px' },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [items]);

  if (items.length < 2) return null;
  return (
    <nav aria-label="On this page">
      <p className="label text-ink-3">On this page</p>
      <ul className="mt-3 border-l border-rule">
        {items.map((i) => (
          <li key={i.id}>
            <a
              href={`#${i.id}`}
              aria-current={active === i.id ? 'location' : undefined}
              className={cn(
                '-ml-px block border-l py-1 text-[14px] leading-snug transition-colors',
                i.level === 3 ? 'pl-7' : 'pl-4',
                active === i.id
                  ? 'border-signal font-semibold text-ink'
                  : 'border-transparent text-ink-2 hover:text-ink',
              )}
            >
              {i.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
