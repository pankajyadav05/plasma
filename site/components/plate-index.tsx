'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

/** The plates of the page, in order. `id` is the section's anchor. */
export const PLATES = [
  { id: 'top', n: '00', name: 'Home' },
  { id: 'workbench', n: '01', name: 'Workbench' },
  { id: 'engines', n: '02', name: 'Engines' },
  { id: 'guardrails', n: '03', name: 'Guardrails' },
  { id: 'shortcuts', n: '04', name: 'Shortcuts' },
  { id: 'local', n: '05', name: 'Local-first' },
  { id: 'download', n: '06', name: 'Download' },
  { id: 'faq', n: 'A', name: 'Questions' },
] as const;

/**
 * Index rail for wide screens: one entry per plate, the number above the
 * name, and the plate you are reading marked. Below `xl` the top bar menu
 * does this job instead.
 */
export function PlateIndex() {
  const [active, setActive] = useState<string>('top');

  useEffect(() => {
    const sections = PLATES.map((p) => document.getElementById(p.id)).filter(
      (el): el is HTMLElement => el != null,
    );
    // A plate is "current" while it crosses the band just above the middle of the viewport.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: '-40% 0px -55% 0px' },
    );
    for (const s of sections) io.observe(s);
    return () => io.disconnect();
  }, []);

  const index = PLATES.findIndex((p) => p.id === active);

  return (
    <aside className="hidden xl:block">
      <nav
        aria-label="Page index"
        className="sticky top-16 flex h-[calc(100vh-4rem)] flex-col border-r border-rule px-7 pb-8 pt-10"
      >
        <p className="label text-ink-3">Index</p>
        <ol className="relative mt-6">
          {/* Spine with a fill that follows the current plate. */}
          <span aria-hidden="true" className="absolute bottom-3 left-[3px] top-3 w-px bg-rule" />
          <span
            aria-hidden="true"
            className="absolute left-[3px] top-3 w-px origin-top bg-ink transition-[height] duration-500 ease-out"
            style={{ height: `calc((100% - 1.5rem) * ${index / (PLATES.length - 1)})` }}
          />
          {PLATES.map((p, i) => {
            const on = p.id === active;
            const past = i < index;
            return (
              <li key={p.id}>
                <a
                  href={`#${p.id}`}
                  aria-current={on ? 'location' : undefined}
                  className="group relative flex gap-4 rounded-sm py-2 pl-0 pr-2"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'relative z-10 mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full border transition-colors duration-300',
                      on
                        ? 'border-signal bg-signal'
                        : past
                          ? 'border-ink bg-ink'
                          : 'border-ink-3 bg-paper group-hover:border-ink',
                    )}
                  />
                  <span className="flex flex-col">
                    <span
                      className={cn(
                        'text-[15px] font-semibold leading-tight tracking-[-0.005em] transition-colors duration-300',
                        on ? 'text-ink' : 'text-ink-2 group-hover:text-ink',
                      )}
                    >
                      {p.name}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
        <Link
          href="/docs/"
          className="group mt-8 flex items-baseline justify-between gap-3 rounded-sm border-t border-rule pt-5 pr-2"
        >
          <span className="text-[15px] font-semibold leading-tight tracking-[-0.005em] text-ink-2 group-hover:text-ink">
            Docs
          </span>
          <span aria-hidden="true" className="text-signal">
            &rarr;
          </span>
        </Link>
      </nav>
    </aside>
  );
}
