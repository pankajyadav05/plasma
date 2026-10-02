'use client';

import Image from 'next/image';
import { useState } from 'react';
import { Caption, Plate, SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import { cn } from '@/lib/cn';
import type { CaptureKey, Captures } from '@/lib/captures';

interface Row {
  ref: string;
  name: string;
  spec: string;
  shot: CaptureKey;
}

const ROWS: Row[] = [
  { ref: '01.1', name: 'SQL editor', spec: 'Run the statement under your cursor (⌘↵), your selection, or the whole script (⇧⌘↵).', shot: 'pg-editor' },
  { ref: '01.2', name: 'Results', spec: 'Each statement gets its own result tab, with real row counts and timings.', shot: 'pg-editor' },
  { ref: '01.3', name: 'Inline editing', spec: 'Changes are staged, shown as SQL, and committed together in one transaction.', shot: 'pg-workbench' },
  { ref: '01.4', name: 'Structure', spec: 'Add columns, indexes and constraints, with Preview SQL before anything runs.', shot: 'pg-structure' },
  { ref: '01.5', name: 'ER diagram', spec: "See a schema's tables and foreign keys, drag them around, and export to PNG or SVG.", shot: 'pg-er' },
  { ref: '01.6', name: 'Import', spec: 'CSV, TSV, JSON, NDJSON or a .sql file. Streams in batches and rolls back on error.', shot: 'pg-import' },
  { ref: '01.7', name: 'Backup & restore', spec: 'pg_dump and pg_restore with a version check, progress and cancel.', shot: 'pg-import' },
  { ref: '01.8', name: 'Roles', spec: 'Users, memberships and table privileges, staged with Preview SQL.', shot: 'pg-roles' },
  { ref: '01.9', name: 'Search in database', spec: 'Find a value across every table, then jump to the exact row.', shot: 'pg-search' },
  { ref: '01.10', name: 'Split panes', spec: 'Two tabs side by side. ⌥⌘] moves between them.', shot: 'pg-split' },
];

function Shot({ c, on, priority }: { c: Captures[CaptureKey]; on: boolean; priority?: boolean }) {
  return (
    <Image
      src={c.src}
      alt={on ? c.alt : ''}
      width={c.width}
      height={c.height}
      priority={priority}
      sizes="(min-width: 1024px) 560px, 100vw"
      aria-hidden={!on}
      className={cn(
        'absolute inset-0 h-full w-full object-cover object-left-top transition-opacity duration-500 ease-out',
        on ? 'opacity-100' : 'opacity-0',
      )}
    />
  );
}

export function Workbench({ captures }: { captures: Captures }) {
  const [active, setActive] = useState(0);
  const row = ROWS[active];
  const shots = Array.from(new Set(ROWS.map((r) => r.shot)));

  return (
    <section id="workbench" aria-labelledby="workbench-title" className="py-28 md:py-44">
      <div className="wrap">
        <SectionHead plate="Plate 01" name="The workbench" />

        <div className="mt-16 grid gap-16 lg:grid-cols-12 lg:gap-10 xl:gap-16">
          <div className="lg:col-span-5">
            <div className="lg:sticky lg:top-28">
              <Reveal>
                <h2 id="workbench-title" className="display t-h2">
                  The workbench.
                </h2>
                <p className="lede mt-8">
                  Tabs for every table and query, a sidebar that knows your schema, and a grid that behaves like a
                  spreadsheet without forgetting it&apos;s a database.
                </p>
              </Reveal>

              {/* Sticky plate, desktop only. Mobile rows expand inline. */}
              <div className="mt-14 hidden lg:block">
                <Plate>
                  <div className="relative aspect-[16/10]" role="img" aria-label={captures[row.shot].alt}>
                    {shots.map((k) => (
                      <Shot key={k} c={captures[k]} on={row.shot === k} />
                    ))}
                  </div>
                </Plate>
                <Caption fig={`Fig ${row.ref}`}>{row.name}</Caption>
              </div>
            </div>
          </div>

          <div className="lg:col-span-7">
            <div className="label flex items-center gap-6 border-b border-ink pb-3">
              <span className="w-12 shrink-0">Ref</span>
              <span className="hidden w-44 shrink-0 sm:block">Function</span>
              <span>Specification</span>
            </div>
            <ul>
              {ROWS.map((r, i) => {
                const on = i === active;
                const c = captures[r.shot];
                return (
                  <li key={r.ref} className="border-b border-rule">
                    <button
                      type="button"
                      aria-expanded={on}
                      onMouseEnter={() => setActive(i)}
                      onFocus={() => setActive(i)}
                      onClick={() => setActive(i)}
                      className={cn(
                        'group relative grid w-full grid-cols-[3rem_1fr] items-baseline gap-x-6 gap-y-1 rounded-none px-0 py-6 text-left transition-colors duration-300 sm:grid-cols-[3rem_11rem_1fr] focus-visible:outline-offset-[-2px] lg:py-7',
                        on ? 'bg-paper-2/70' : 'hover:bg-paper-2/40',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'absolute inset-y-0 left-0 w-px origin-top bg-ink transition-transform duration-500',
                          on ? 'scale-y-100' : 'scale-y-0',
                        )}
                      />
                      <span className={cn('mono pl-3 text-[11.5px] transition-colors', on ? 'text-ink' : 'text-ink-2')}>
                        {r.ref}
                      </span>
                      <span className="text-[19px] font-bold leading-snug tracking-[-0.01em] text-ink" style={{ fontVariationSettings: "'wdth' 108" }}>
                        {r.name}
                      </span>
                      <span className="col-start-2 text-[16px] leading-[1.5] text-ink-2 sm:col-start-3">{r.spec}</span>
                    </button>
                    {/* Mobile and tablet: tap-to-expand crop */}
                    <div
                      className={cn(
                        'grid transition-[grid-template-rows] duration-500 ease-out lg:hidden',
                        on ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                      )}
                    >
                      <div className="overflow-hidden">
                        <div className="-mx-5 pb-6 sm:mx-0">
                          <div className="plate max-sm:rounded-none max-sm:border-x-0">
                            <div className="relative aspect-[16/10]">
                              <Image
                                src={c.src}
                                alt={on ? c.alt : ''}
                                width={c.width}
                                height={c.height}
                                loading="lazy"
                                sizes="(min-width: 640px) 90vw, 100vw"
                                aria-hidden={!on}
                                className="absolute inset-0 h-full w-full object-cover object-left-top"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
