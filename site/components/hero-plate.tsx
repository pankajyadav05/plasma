'use client';

import Image from 'next/image';
import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Plate } from '@/components/plate';
import { cn } from '@/lib/cn';
import type { Captures } from '@/lib/captures';

type Engine = 'postgres' | 'redis' | 'opensearch';

const ENGINES: { id: Engine; label: string; key: 'pg-workbench' | 'redis' | 'opensearch'; color: string; fig: string }[] = [
  { id: 'postgres', label: 'Postgres', key: 'pg-workbench', color: 'bg-pg', fig: 'The Postgres workbench' },
  { id: 'redis', label: 'Redis', key: 'redis', color: 'bg-redis', fig: 'The Redis key browser' },
  { id: 'opensearch', label: 'OpenSearch', key: 'opensearch', color: 'bg-os', fig: 'The OpenSearch console' },
];

interface Callout {
  n: number;
  title: string;
  body: string;
  /** dot position as a percentage of the image */
  x: number;
  y: number;
  side: 'left' | 'right';
}

const COPY = [
  ['Capsule', 'Shows the engine, server, database and schema. The color shows the connection status.'],
  ['Sidebar', 'Shows tables, views and functions. Type to filter them.'],
  ['Grid', 'Edit cells, then commit all changes in one transaction.'],
  ['Details', 'Shows the selected row as a form.'],
] as const;

/**
 * Callout anchors are percentages of the image. Two sets: one for the real
 * workbench capture (v2) and one for the older illustrative fallback.
 */
const ANCHORS = {
  real: [
    { x: 25.2, y: 2.8, side: 'left' },
    { x: 13, y: 29.5, side: 'left' },
    { x: 41, y: 49.8, side: 'left' },
    { x: 87, y: 29, side: 'right' },
  ],
  fallback: [
    { x: 14, y: 3, side: 'left' },
    { x: 8, y: 27, side: 'left' },
    { x: 58, y: 70, side: 'right' },
    { x: 93, y: 36, side: 'right' },
  ],
} as const;

const LEFT_EDGE = 15.6; // stage %, just outside the plate
const RIGHT_EDGE = 84.4;
const PLATE_L = 17;
const PLATE_W = 66;

export function HeroPlate({ captures }: { captures: Captures }) {
  const [engine, setEngine] = useState<Engine>('postgres');
  const [hot, setHot] = useState<number | null>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const pg = captures['pg-workbench'];
  const anchors = pg.real ? ANCHORS.real : ANCHORS.fallback;
  const callouts: Callout[] = COPY.map(([title, body], i) => ({ n: i + 1, title, body, ...anchors[i] }));
  const showCallouts = engine === 'postgres';
  const active = ENGINES.find((e) => e.id === engine)!;

  const onKey = (e: KeyboardEvent, i: number) => {
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % ENGINES.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + ENGINES.length) % ENGINES.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ENGINES.length - 1;
    else return;
    e.preventDefault();
    setEngine(ENGINES[next].id);
    tabs.current[next]?.focus();
  };

  return (
    <div className="h-up mt-20 md:mt-28" style={{ '--d': '950ms' } as CSSProperties}>
      <div className="wrap">
        {/* Engine switch */}
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4 xl:mx-[17%]">
          <div
            role="tablist"
            aria-label="Choose an engine"
            className="inline-flex rounded-full border border-rule bg-paper-2 p-1"
          >
            {ENGINES.map((e, i) => {
              const on = e.id === engine;
              return (
                <button
                  key={e.id}
                  ref={(el) => {
                    tabs.current[i] = el;
                  }}
                  role="tab"
                  id={`tab-${e.id}`}
                  aria-selected={on}
                  aria-controls="hero-panel"
                  tabIndex={on ? 0 : -1}
                  onClick={() => setEngine(e.id)}
                  onKeyDown={(ev) => onKey(ev, i)}
                  className={cn(
                    'mono relative flex h-9 items-center gap-2 rounded-full px-4 text-[12px] font-medium tracking-[0.02em] transition-colors duration-300',
                    on ? 'bg-ink text-paper' : 'text-ink-2 hover:text-ink',
                  )}
                >
                  <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', e.color, !on && 'opacity-80')} />
                  {e.label}
                </button>
              );
            })}
          </div>
          <p className="label hidden sm:block" aria-live="polite">
            <span className="mr-3 inline-block h-[7px] w-[7px] bg-signal" aria-hidden="true" />
            {active.fig}
          </p>
        </div>

        <div className="relative xl:grid xl:grid-cols-[17fr_66fr_17fr]">
          <div className="-mx-5 sm:mx-0 xl:col-start-2">
            <Plate frameClassName="max-sm:rounded-none max-sm:border-x-0">
              <div
                id="hero-panel"
                role="tabpanel"
                aria-labelledby={`tab-${engine}`}
                className="relative"
                style={{ aspectRatio: `${pg.width} / ${pg.height}` }}
              >
                {ENGINES.map((e, i) => {
                  const c = captures[e.key];
                  const on = e.id === engine;
                  return (
                    <Image
                      key={e.id}
                      src={c.src}
                      alt={c.alt}
                      width={c.width}
                      height={c.height}
                      priority={i === 0}
                      sizes="(min-width: 1400px) 870px, 100vw"
                      aria-hidden={!on}
                      className={cn(
                        'absolute inset-0 h-full w-full object-cover object-left-top transition-opacity duration-500 ease-out',
                        on ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                  );
                })}

                {/* Numbered anchors on the image */}
                <div
                  aria-hidden="true"
                  className={cn('transition-opacity duration-500', showCallouts ? 'opacity-100' : 'pointer-events-none opacity-0')}
                >
                  {callouts.map((c) => (
                    <span
                      key={c.n}
                      className="absolute transition-transform duration-300"
                      style={{
                        left: `${c.x}%`,
                        top: `${c.y}%`,
                        transform: `translate(-50%,-50%) scale(${hot === c.n ? 1.28 : 1})`,
                      }}
                    >
                      <span
                        className="callout-dot block h-[12px] w-[12px] rounded-full bg-signal ring-[3px] ring-paper-2 max-sm:h-[10px] max-sm:w-[10px]"
                        style={{ '--d': `${1500 + c.n * 140}ms` } as CSSProperties}
                      />
                    </span>
                  ))}
                </div>
              </div>
            </Plate>
          </div>

          {/* Desktop margin leaders and labels */}
          <div
            className={cn(
              'pointer-events-none absolute inset-0 hidden transition-opacity duration-500 xl:block',
              showCallouts ? 'opacity-100' : 'opacity-0',
            )}
            aria-hidden={!showCallouts}
          >
            {callouts.map((c) => {
              const dotX = PLATE_L + (PLATE_W * c.x) / 100;
              const left = c.side === 'left';
              const from = left ? LEFT_EDGE : dotX;
              const width = left ? dotX - LEFT_EDGE : RIGHT_EDGE - dotX;
              const lit = hot === c.n;
              return (
                <div key={c.n}>
                  <svg
                    className="absolute overflow-visible"
                    style={{ left: `${from}%`, top: `${c.y}%`, width: `${width}%`, height: 2, marginTop: -1 }}
                    viewBox="0 0 100 2"
                    preserveAspectRatio="none"
                  >
                    <line
                      className="leader"
                      x1={left ? 100 : 0}
                      y1={1}
                      x2={left ? 0 : 100}
                      y2={1}
                      pathLength={1}
                      strokeWidth={1}
                      stroke={lit ? 'var(--color-ink)' : 'var(--color-ink-2)'}
                      style={{ '--d': `${1500 + c.n * 140}ms`, transition: 'stroke 0.25s' } as CSSProperties}
                    />
                  </svg>
                  <div
                    className={cn(
                      'h-fade pointer-events-auto absolute -translate-y-[11px] rounded-md outline-offset-4',
                      left ? 'text-right' : 'text-left',
                    )}
                    style={
                      {
                        top: `${c.y}%`,
                        '--d': `${1900 + c.n * 140}ms`,
                        ...(left ? { left: 0, width: `${LEFT_EDGE - 1.2}%` } : { left: `${RIGHT_EDGE + 1.2}%`, width: `${100 - RIGHT_EDGE - 1.2}%` }),
                      } as unknown as CSSProperties
                    }
                    tabIndex={0}
                    onMouseEnter={() => setHot(c.n)}
                    onMouseLeave={() => setHot(null)}
                    onFocus={() => setHot(c.n)}
                    onBlur={() => setHot(null)}
                  >
                    <p className="mono text-[11.5px] font-medium leading-[22px] tracking-[0.04em] text-ink">
                      {c.title}
                    </p>
                    <p className="mt-1 text-[14px] leading-[1.45] text-ink-2">{c.body}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Legend for smaller screens */}
        <ul
          className={cn(
            'mt-10 grid gap-x-10 gap-y-5 transition-opacity duration-300 sm:grid-cols-2 xl:hidden',
            showCallouts ? 'opacity-100' : 'hidden',
          )}
        >
          {callouts.map((c) => (
            <li key={c.n} className="flex gap-4">
              <span aria-hidden="true" className="mt-[7px] block h-[10px] w-[10px] shrink-0 rounded-full bg-signal" />
              <p className="text-[15px] leading-[1.5] text-ink-2">
                <span className="font-semibold text-ink">{c.title}.</span> {c.body}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
