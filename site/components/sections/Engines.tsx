'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Plate, SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import { Sheet, SheetCell, SheetGrid } from '@/components/sheet';
import { ENGINE_MARKS, ENGINE_VIEWBOX } from '@/lib/engine-marks';
import { cn } from '@/lib/cn';
import type { CaptureKey, Captures } from '@/lib/captures';

interface Engine {
  key: keyof typeof ENGINE_MARKS;
  name: string;
  kind: string;
  color: string;
  doc: string;
  shot?: CaptureKey;
  lead: string;
  points: string[];
}

/** Capabilities per engine, each one taken from that engine's docs page. */
const ENGINES: Engine[] = [
  {
    key: 'postgres',
    name: 'PostgreSQL',
    kind: 'Relational',
    color: 'var(--color-pg)',
    doc: 'postgres',
    shot: 'pg-workbench',
    lead: 'The full workbench.',
    points: [
      'Safe Run previews the rows a write changes before you commit',
      'Health advisor: unused indexes, bloat, long sessions, lock waits',
      'EXPLAIN ANALYZE as a tree with timings',
      'Live LISTEN and NOTIFY tail',
      'Roles, backup and restore, schema diff, migration check',
      'pgvector similarity search and a PostGIS map preview',
    ],
  },
  {
    key: 'mysql',
    name: 'MySQL',
    kind: 'Relational',
    color: 'var(--color-mysql)',
    doc: 'mysql-mariadb',
    lead: 'Tables, queries and diagrams.',
    points: [
      'SQL editor, notebooks and grid editing with conflict detection',
      'Structure tab: columns, keys, foreign keys, indexes and triggers',
      'ER diagram and plain EXPLAIN',
      'SSH tunnel and TLS with client certificates',
      'Cancel sends KILL QUERY for the running thread',
    ],
  },
  {
    key: 'mariadb',
    name: 'MariaDB',
    kind: 'Relational',
    color: 'var(--color-mariadb)',
    doc: 'mysql-mariadb',
    lead: 'The same workbench as MySQL.',
    points: [
      'SQL editor, notebooks and grid editing with conflict detection',
      'Structure tab, ER diagram and plain EXPLAIN',
      'Query timeout maps to max_statement_time',
      'AI and MCP queries run read-only, and must look like reads first',
      'SSH tunnel and TLS',
    ],
  },
  {
    key: 'sqlite',
    name: 'SQLite',
    kind: 'Embedded',
    color: 'var(--color-sqlite)',
    doc: 'sqlite',
    lead: 'A file, nothing else.',
    points: [
      'Open any file or create a new one, with no server, login or tunnel',
      'Read-only open: a read-only file handle plus query_only',
      'Grid editing with conflict detection, structure and ER diagram',
      'Export a consistent copy of the open file with the backup API',
      'Plasma only opens paths you picked, passed on the command line or saved',
    ],
  },
  {
    key: 'clickhouse',
    name: 'ClickHouse',
    kind: 'Columnar',
    color: 'var(--color-clickhouse)',
    doc: 'clickhouse',
    lead: 'Analytics over HTTP.',
    points: [
      'Queries over HTTP or HTTPS, with SSH tunnels',
      'Results are read-only; change data with SQL',
      'A mutation asks first: Run an asynchronous mutation?',
      'Read-only uses the server setting readonly=1, which it refuses to lift',
      'Cancel aborts the request and sends KILL QUERY',
    ],
  },
  {
    key: 'duckdb',
    name: 'DuckDB',
    kind: 'Analytical',
    color: 'var(--color-duckdb)',
    doc: 'duckdb',
    lead: 'Files as tables.',
    points: [
      'Query CSV, TSV, Parquet, JSON, NDJSON and Excel files with SQL',
      'Drop files on the window: each file, and each Excel sheet, becomes a view',
      'A column profile for every view: nulls, approximate distinct count, minimum, maximum',
      'Attach a saved PostgreSQL connection read-only and join it with your files',
      'Extensions download only after you agree',
    ],
  },
  {
    key: 'redis',
    name: 'Redis',
    kind: 'Key-value',
    color: 'var(--color-redis)',
    doc: 'redis',
    shot: 'redis',
    lead: 'Keys, typed and guarded.',
    points: [
      'Key tree split on the colon, found with SCAN and never KEYS',
      'Typed editors for strings, hashes, lists, sets, sorted sets, streams and JSON',
      'TTL editing with a live countdown',
      'A CLI that classifies every command and asks before dangerous ones',
      'Memory analyzer, slow log, pub/sub and keyspace events',
      'Bulk delete previews first; on Prod you type the count',
    ],
  },
  {
    key: 'opensearch',
    name: 'OpenSearch',
    kind: 'Search',
    color: 'var(--color-os)',
    doc: 'opensearch',
    shot: 'opensearch',
    lead: 'Indices, documents and the console.',
    points: [
      'Indices with health, grouped when they roll over',
      'Search with a query string or the query DSL, with a time range',
      'View, edit and delete documents',
      'A console, plus SQL through the SQL plugin',
      'Basic, API key and AWS SigV4 authentication',
      'Every request is classified; writes ask on Prod',
    ],
  },
];

function Mark({ e, className }: { e: Engine; className: string }) {
  return (
    <svg viewBox={ENGINE_VIEWBOX[e.key] ?? '0 0 24 24'} aria-hidden="true" focusable="false" className={className} style={{ color: e.color }}>
      <path d={ENGINE_MARKS[e.key]} fill="currentColor" />
    </svg>
  );
}

export function Engines({ captures }: { captures: Captures }) {
  const [i, setI] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const e = ENGINES[i];
  const shot = e.shot ? captures[e.shot] : undefined;

  const onKey = (ev: KeyboardEvent, idx: number) => {
    let n = idx;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') n = (idx + 1) % ENGINES.length;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') n = (idx - 1 + ENGINES.length) % ENGINES.length;
    else if (ev.key === 'Home') n = 0;
    else if (ev.key === 'End') n = ENGINES.length - 1;
    else return;
    ev.preventDefault();
    setI(n);
    tabs.current[n]?.focus();
  };

  return (
    <section id="engines" aria-labelledby="engines-title" className="border-t border-rule bg-paper-2/50 py-24 md:py-32">
      <div className="wrap">
        <SectionHead name="Engines" />
        <div className="mt-14 grid gap-8 lg:grid-cols-12">
          <Reveal className="lg:col-span-8">
            <h2 id="engines-title" className="display t-h2">
              Eight engines. Each one treated as itself.
            </h2>
          </Reveal>
          <Reveal className="lg:col-span-4 lg:self-end" delay={100}>
            <p className="prose-p">
              Each engine gets the tools it needs. The keys, the tabs, the Read-only switch and the Prod tag stay the same.
            </p>
          </Reveal>
        </div>

        <Reveal className="mt-16" delay={60}>
          <Sheet>
            <div
              role="tablist"
              aria-label="Choose an engine"
              className="overflow-hidden"
            >
              <div className="-ml-px -mt-px grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8">
                {ENGINES.map((x, idx) => {
                  const on = idx === i;
                  return (
                    <button
                      key={x.key}
                      ref={(el) => {
                        tabs.current[idx] = el;
                      }}
                      type="button"
                      role="tab"
                      id={`engine-tab-${x.key}`}
                      aria-selected={on}
                      aria-controls="engine-panel"
                      tabIndex={on ? 0 : -1}
                      onClick={() => setI(idx)}
                      onKeyDown={(ev) => onKey(ev, idx)}
                      style={{ '--i': idx } as CSSProperties}
                      className={cn(
                        'sheet-cell group flex flex-col items-start gap-4 text-left focus-visible:outline-offset-[-3px]',
                        on && 'bg-paper-2',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn('sheet-bar', on && '!scale-x-100')}
                      />
                      <Mark e={x} className={cn('h-7 w-7 shrink-0 transition-[transform,opacity] duration-300 md:h-8 md:w-8', !on && 'opacity-60 group-hover:opacity-100')} />
                      <span className={cn('whitespace-nowrap text-[16px] font-bold leading-none tracking-[-0.015em] md:text-[17px]', on ? 'text-ink' : 'text-ink-2 group-hover:text-ink')}>
                        {x.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </Sheet>

          <div
            id="engine-panel"
            role="tabpanel"
            aria-labelledby={`engine-tab-${e.key}`}
            tabIndex={0}
            key={e.key}
            className="outcome mt-12 rounded-md"
          >
            <div className={cn('grid gap-10', shot && 'lg:grid-cols-12 lg:gap-10 xl:gap-14')}>
              <div className={cn(shot ? 'lg:col-span-5' : '')}>
                <div className="flex items-end gap-5">
                  <Mark e={e} className={cn('shrink-0', shot ? 'h-10 w-10' : 'h-16 w-16 md:h-20 md:w-20')} />
                  <div className="min-w-0">
                    <p className="label">{e.kind}</p>
                    <h3 className="t-h3 mt-1">{e.name}</h3>
                  </div>
                </div>
                <p className="lede mt-6 !max-w-[26em]">{e.lead}</p>

                {shot ? (
                  <ul className="mt-8 border-t border-ink">
                    {e.points.map((p) => (
                      <li key={p} className="border-b border-rule py-3.5 text-[15.5px] leading-[1.45] text-ink-2">
                        {p}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              {shot && (
                <div className="lg:col-span-7">
                  <Plate>
                    <Image
                      src={shot.src}
                      alt={shot.alt}
                      width={shot.width}
                      height={shot.height}
                      sizes="(min-width: 1400px) 720px, (min-width: 1024px) 55vw, 100vw"
                      loading="lazy"
                      className="block h-auto w-full"
                    />
                  </Plate>
                </div>
              )}
            </div>

            {!shot && (
              <Sheet className="mt-10">
                <SheetGrid as="ul" label={`${e.name} in Plasma`} className="sm:grid-cols-2 lg:grid-cols-3">
                  {e.points.map((p, n) => (
                    <SheetCell as="li" key={p} index={n} className="!pb-6">
                      <span className="flex gap-3 text-[16px] leading-[1.45] text-ink">
                        <span aria-hidden="true" className="sheet-tick mt-[9px]" />
                        {p}
                      </span>
                    </SheetCell>
                  ))}
                </SheetGrid>
              </Sheet>
            )}

            <Link
              href={`/docs/${e.doc}/`}
              className="mono mt-8 inline-flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.06em] text-ink underline decoration-signal decoration-2 underline-offset-[5px] transition-colors hover:text-signal"
            >
              {e.name} in the docs
              <span aria-hidden="true">&rarr;</span>
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
