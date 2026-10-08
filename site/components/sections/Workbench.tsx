'use client';

import Image from 'next/image';
import { useState } from 'react';
import { Caption, Plate, SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import { Sheet } from '@/components/sheet';
import { cn } from '@/lib/cn';
import type { AnyCaptureKey, Capture, Captures } from '@/lib/captures';
import { LearnMore } from '@/components/docs/learn-more';

interface Row {
  kind: string;
  name: string;
  spec: string;
  /** Preferred capture first; the first one that exists is shown. None: keep the previous image. */
  shots: AnyCaptureKey[];
}

const ROWS: Row[] = [
  { kind: 'Write', name: 'SQL editor', spec: 'Run the statement at the cursor, a selection or the whole script. Each statement gets its own result tab.', shots: ['pg-editor'] },
  { kind: 'Edit', name: 'Grid editing', spec: 'Stage cell edits, review the list of changes, commit in one transaction. If someone changed a row meanwhile, Plasma shows both values instead of overwriting.', shots: ['conflict', 'pg-workbench'] },
  { kind: 'Diff', name: 'Result Compare', spec: 'Diff two result sets by key, even across connections, such as staging against production. Export the differences.', shots: ['compare'] },
  { kind: 'Alter', name: 'Structure', spec: 'Add columns, indexes and constraints on PostgreSQL. Read the generated SQL before it runs.', shots: ['pg-structure'] },
  { kind: 'Map', name: 'ER diagram', spec: 'See the tables and foreign keys of a schema. Export the diagram as PNG or SVG.', shots: ['pg-er'] },
  { kind: 'Plan', name: 'Explain', spec: 'Read a query plan as a tree with costs. On PostgreSQL, EXPLAIN ANALYZE adds real timings.', shots: ['pg-explain'] },
  { kind: 'Document', name: 'Notebooks', spec: 'SQL cells and Markdown notes in one document, kept per connection. Export as Markdown.', shots: ['notebook'] },
  { kind: 'Recall', name: 'History and snippets', spec: 'Search the last 5,000 statements you ran. Keep favourites as saved queries and snippets with tab stops.', shots: [] },
  { kind: 'Move', name: 'Import and export', spec: 'Import CSV, TSV, JSON, NDJSON or SQL into PostgreSQL. Export results as CSV, JSON or SQL INSERT.', shots: ['pg-import'] },
  { kind: 'Find', name: 'Search in database', spec: 'Find a value in every table of a PostgreSQL database, then go straight to the row.', shots: ['pg-search'] },
  { kind: 'Reach', name: 'Command palette', spec: 'Open tables, queries and commands from the keyboard.', shots: ['palette'] },
];

function pick(captures: Captures, shots: AnyCaptureKey[]): { key: AnyCaptureKey; c: Capture } | null {
  for (const k of shots) {
    const c = captures[k];
    if (c) return { key: k, c };
  }
  return null;
}

function Shot({ c, on, priority }: { c: Capture; on: boolean; priority?: boolean }) {
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
  // A row without a capture keeps the previous image on screen.
  const [shown, setShown] = useState<{ key: AnyCaptureKey; name: string }>(() => {
    const first = pick(captures, ROWS[0].shots);
    return { key: first?.key ?? 'pg-editor', name: ROWS[0].name };
  });

  const choose = (i: number) => {
    setActive(i);
    const hit = pick(captures, ROWS[i].shots);
    if (hit) setShown({ key: hit.key, name: ROWS[i].name });
  };

  const shots = Array.from(new Set(ROWS.flatMap((r) => r.shots))).filter((k) => captures[k]);
  const current = captures[shown.key];

  return (
    <section id="workbench" aria-labelledby="workbench-title" className="py-24 md:py-32">
      <div className="wrap">
        <SectionHead name="Workbench" />

        <div className="mt-14 grid gap-16 lg:grid-cols-12 lg:gap-10 xl:gap-16">
          <div className="lg:col-span-5">
            <div className="lg:sticky lg:top-28">
              <Reveal>
                <h2 id="workbench-title" className="display t-h2 !text-[clamp(2.2rem,1rem+3vw,3.7rem)]">
                  Everything you do with a database, in tabs.
                </h2>
                <p className="lede mt-8">
                  Each table and query opens in a tab. The sidebar shows your schema. The grid works like a
                  spreadsheet, and nothing is written until you commit it.
                </p>
                <LearnMore href="/docs/getting-started/">Tour the workbench</LearnMore>
              </Reveal>

              {/* Sticky plate, desktop only. Mobile rows expand inline. */}
              <div className="mt-14 hidden lg:block">
                <Plate>
                  <div className="relative aspect-[16/10]" role="img" aria-label={current?.alt}>
                    {shots.map((k) => (
                      <Shot key={k} c={captures[k]!} on={shown.key === k} />
                    ))}
                  </div>
                </Plate>
                <Caption>{shown.name}</Caption>
              </div>
            </div>
          </div>

          <div className="lg:col-span-7">
            <Sheet>
              <ul>
                {ROWS.map((r, i) => {
                  const on = i === active;
                  const hit = pick(captures, r.shots);
                  return (
                    <li key={r.name} className="border-b border-rule last:border-b-0">
                      <button
                        type="button"
                        aria-expanded={hit ? on : undefined}
                        onMouseEnter={() => choose(i)}
                        onFocus={() => choose(i)}
                        onClick={() => choose(i)}
                        className={cn(
                          'group relative grid w-full grid-cols-1 items-baseline gap-x-6 gap-y-1.5 rounded-none px-4 py-6 text-left transition-colors duration-300 sm:grid-cols-[6.5rem_11rem_1fr] focus-visible:outline-offset-[-2px] lg:py-7',
                          on ? 'bg-paper-2/70' : 'hover:bg-paper-2/40',
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'absolute inset-x-0 -top-px h-[2px] origin-left bg-signal transition-transform duration-500',
                            on ? 'scale-x-100' : 'scale-x-0',
                          )}
                        />
                        <span
                          className={cn(
                            'mono text-[10.5px] font-medium uppercase tracking-[0.08em] transition-colors',
                            on ? 'text-ink' : 'text-ink-2',
                          )}
                        >
                          {r.kind}
                        </span>
                        <span className="text-[19px] font-bold leading-snug tracking-[-0.01em] text-ink" style={{ fontVariationSettings: "'wdth' 108" }}>
                          {r.name}
                        </span>
                        <span className="text-[16px] leading-[1.5] text-ink-2">{r.spec}</span>
                      </button>
                      {/* Mobile and tablet: tap-to-expand crop */}
                      {hit && (
                        <div
                          className={cn(
                            'grid transition-[grid-template-rows] duration-500 ease-out lg:hidden',
                            on ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                          )}
                        >
                          <div className="overflow-hidden">
                            <div className="pb-6">
                              <div className="plate max-sm:rounded-none">
                                <div className="relative aspect-[16/10]">
                                  <Image
                                    src={hit.c.src}
                                    alt={on ? hit.c.alt : ''}
                                    width={hit.c.width}
                                    height={hit.c.height}
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
                      )}
                    </li>
                  );
                })}
              </ul>
            </Sheet>
          </div>
        </div>
      </div>
    </section>
  );
}
