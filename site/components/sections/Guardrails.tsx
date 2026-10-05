'use client';

import { Lock } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { Plate, SectionHead } from '@/components/plate';
import { Reveal } from '@/components/reveal';
import { cn } from '@/lib/cn';

const LEVELS = [
  {
    id: 'off',
    name: 'Off',
    tag: 'Runs',
    outcome: 'The statement runs immediately.',
    detail: null,
    angle: -66,
  },
  {
    id: 'dangerous',
    name: 'Confirm dangerous',
    tag: 'Asks first',
    outcome: 'Plasma asks before DROP, TRUNCATE, and DELETE or UPDATE without WHERE.',
    detail: 'Default',
    angle: -22,
  },
  {
    id: 'all',
    name: 'Confirm all',
    tag: 'Asks first',
    outcome: 'Plasma asks before each statement.',
    detail: null,
    angle: 22,
  },
  {
    id: 'readonly',
    name: 'Read-only',
    tag: 'Refused',
    outcome: 'Plasma blocks all writes on this connection.',
    detail: null,
    angle: 66,
  },
] as const;

const CELLS = [
  ['Safe Run', 'Do a dry run of a change. Examine the changed rows, then commit or roll back.'],
  ['Production tag', 'Connections with the Prod tag ask for one more confirmation.'],
  ['Read-only connections', 'The main process blocks writes. The UI cannot bypass this block.'],
  ['Migration check', 'Plasma finds unsafe DDL and shows the locks that it takes.'],
  ['Audit log', 'Plasma records each statement on Prod connections. Changes to the log are visible.'],
  ['Presentation mode', 'Plasma hides personal data when you share your screen.'],
] as const;

const CX = 130;
const CY = 136;

function Gauge({ index }: { index: number }) {
  const ticks = Array.from({ length: 23 }, (_, i) => -66 + i * 6);
  const rad = (d: number) => ((d - 90) * Math.PI) / 180;
  const pt = (d: number, r: number) => [CX + r * Math.cos(rad(d)), CY + r * Math.sin(rad(d))];
  return (
    <svg viewBox="0 0 260 160" className="h-auto w-full max-w-[300px]" aria-hidden="true">
      <path
        d={`M ${pt(-72, 112).join(' ')} A 112 112 0 0 1 ${pt(72, 112).join(' ')}`}
        fill="none"
        stroke="var(--color-rule)"
        strokeWidth="1"
      />
      {ticks.map((a) => {
        const major = LEVELS.some((l) => l.angle === a);
        const idx = LEVELS.findIndex((l) => l.angle === a);
        const [x1, y1] = pt(a, major ? 92 : 100);
        const [x2, y2] = pt(a, 108);
        const on = idx === index;
        return (
          <line
            key={a}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={on ? 'var(--color-signal)' : major ? 'var(--color-ink)' : 'var(--color-ink-3)'}
            strokeWidth={major ? (on ? 2.5 : 1.5) : 1}
            strokeLinecap="round"
            style={{ transition: 'stroke 0.3s' }}
          />
        );
      })}
      <g
        style={{
          transform: `rotate(${LEVELS[index].angle}deg)`,
          transformOrigin: `${CX}px ${CY}px`,
          transition: 'transform 0.6s cubic-bezier(0.34, 1.4, 0.5, 1)',
        }}
      >
        <line x1={CX} y1={CY} x2={CX} y2={CY - 84} stroke="var(--color-ink)" strokeWidth="2" strokeLinecap="round" />
        <circle cx={CX} cy={CY - 84} r="4" fill="var(--color-signal)" />
      </g>
      <circle cx={CX} cy={CY} r="9" fill="var(--color-paper-2)" stroke="var(--color-ink)" strokeWidth="1.5" />
      <circle cx={CX} cy={CY} r="2.5" fill="var(--color-ink)" />
    </svg>
  );
}

export function Guardrails() {
  const [i, setI] = useState(1);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const lvl = LEVELS[i];

  const onKey = (e: KeyboardEvent, idx: number) => {
    let n = idx;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = Math.min(LEVELS.length - 1, idx + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = Math.max(0, idx - 1);
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = LEVELS.length - 1;
    else return;
    e.preventDefault();
    setI(n);
    refs.current[n]?.focus();
  };

  return (
    <section id="guardrails" aria-labelledby="guardrails-title" className="py-24 md:py-32">
      <div className="wrap">
        <SectionHead plate="Plate 03" name="Guardrails" />

        <div className="mt-14 grid gap-8 lg:grid-cols-12">
          <Reveal className="lg:col-span-8">
            <h2 id="guardrails-title" className="display t-h2">
              Careful with production, by design.
            </h2>
          </Reveal>
          <Reveal className="lg:col-span-4 lg:self-end" delay={100}>
            <p className="lede">Plasma stops dangerous statements before they run.</p>
          </Reveal>
        </div>

        <Reveal className="mt-16 grid gap-8 lg:grid-cols-12" delay={60}>
          {/* The dial */}
          <Plate className="h-full lg:col-span-6" frameClassName="h-full">
            <div className="flex h-full flex-col p-6 sm:p-9">
              <p className="label">Safe mode · Setting</p>
              <div className="mt-6 flex flex-col items-center gap-8 sm:flex-row sm:items-center sm:gap-10">
                <div className="flex w-full max-w-[280px] shrink-0 justify-center">
                  <Gauge index={i} />
                </div>
                <div
                  role="radiogroup"
                  aria-label="Safe mode level"
                  className="relative w-full"
                >
                  <span aria-hidden="true" className="absolute bottom-5 left-[11px] top-5 w-px bg-rule" />
                  {LEVELS.map((l, idx) => {
                    const on = idx === i;
                    return (
                      <button
                        key={l.id}
                        ref={(el) => {
                          refs.current[idx] = el;
                        }}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        tabIndex={on ? 0 : -1}
                        onClick={() => setI(idx)}
                        onKeyDown={(e) => onKey(e, idx)}
                        className="group relative flex w-full items-center gap-5 rounded-md py-3 text-left"
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'relative z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full border bg-paper-2 transition-colors duration-300',
                            on ? 'border-signal' : 'border-ink-3 group-hover:border-ink',
                          )}
                        >
                          <span
                            className={cn(
                              'h-2.5 w-2.5 rounded-full transition-[transform,background-color] duration-300',
                              on ? 'scale-100 bg-signal' : 'scale-0 bg-ink group-hover:scale-50',
                            )}
                          />
                        </span>
                        <span
                          className={cn(
                            'text-[19px] font-bold tracking-[-0.01em] transition-colors duration-200',
                            on ? 'text-ink' : 'text-ink-2 group-hover:text-ink',
                          )}
                          style={{ fontVariationSettings: "'wdth' 108" }}
                        >
                          {l.name}
                        </span>
                        {l.detail && (
                          <span className="label rounded-full border border-rule px-2 py-0.5 text-[10px]">{l.detail}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
              <p className="label mt-auto pt-8 normal-case tracking-normal text-ink-2">
                Use the arrow keys to change the level.
              </p>
            </div>
          </Plate>

          {/* The terminal */}
          <Plate className="h-full lg:col-span-6" frameClassName="h-full">
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-rule px-6 py-3.5 sm:px-8">
                <p className="mono text-[11.5px] tracking-[0.03em] text-ink-2">
                  commerce <span className="text-ink-3">/</span> public
                </p>
                <span className="label rounded-full border border-ink px-2.5 py-0.5 text-[10px] text-ink">Prod</span>
              </div>
              <div className="flex flex-1 flex-col px-6 py-8 sm:px-8">
                <p className="label text-ink-3" style={{ color: 'var(--color-ink-2)' }}>
                  Statement
                </p>
                <pre
                  className={cn(
                    'mono mt-3 whitespace-pre-wrap text-[22px] leading-[1.4] text-ink transition-opacity duration-300 sm:text-[26px]',
                    lvl.id === 'readonly' && 'opacity-60',
                  )}
                >
                  <span className="text-ink-3">› </span>
                  <span className={cn(lvl.id === 'readonly' && 'line-through decoration-1')}>DROP TABLE orders;</span>
                </pre>

                <div className="mt-8 border-t border-rule pt-6" aria-live="polite" role="status">
                  <p className="label">
                    Outcome <span className="text-ink-3">·</span> <span className="text-ink">{lvl.tag}</span>
                  </p>
                  <div key={lvl.id} className="outcome mt-4 min-h-[148px]">
                    {lvl.id === 'off' && (
                      <p className="text-[24px] font-bold leading-tight tracking-[-0.01em] text-ink" style={{ fontVariationSettings: "'wdth' 108" }}>
                        {lvl.outcome}
                      </p>
                    )}
                    {(lvl.id === 'dangerous' || lvl.id === 'all') && (
                      <>
                        <p className="text-[24px] font-bold leading-tight tracking-[-0.01em] text-ink" style={{ fontVariationSettings: "'wdth' 108" }}>
                          {lvl.outcome}
                        </p>
                        <div aria-hidden="true" className="mt-5 flex gap-2">
                          <span className="mono rounded-full border border-ink-3 px-4 py-1.5 text-[11.5px] text-ink-2">Cancel</span>
                          <span className="mono rounded-full bg-ink px-4 py-1.5 text-[11.5px] text-paper">Run anyway</span>
                        </div>
                      </>
                    )}
                    {lvl.id === 'readonly' && (
                      <div className="flex items-start gap-4">
                        <Lock className="mt-1 h-6 w-6 shrink-0 text-ink" strokeWidth={1.75} aria-hidden="true" />
                        <p className="text-[24px] font-bold leading-tight tracking-[-0.01em] text-ink" style={{ fontVariationSettings: "'wdth' 108" }}>
                          {lvl.outcome}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </Plate>
        </Reveal>

        <dl className="mt-16 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {CELLS.map(([t, d], n) => (
            <Reveal key={t} delay={n * 70} className="border-t border-ink pt-4">
              <dt className="label text-ink">
                <span className="mr-3 text-ink-3">03.{n + 1}</span>
                {t}
              </dt>
              <dd className="mt-3 text-[16px] leading-[1.5] text-ink-2">{d}</dd>
            </Reveal>
          ))}
        </dl>
      </div>
    </section>
  );
}
