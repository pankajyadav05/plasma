'use client';

import { useEffect, useRef, useState } from 'react';
import { InstrumentFrame } from '@/components/instrument-frame';
import { Reveal } from '@/components/reveal';
import { LICENSE, SIZE_LABEL, VERSION } from '@/lib/version';

/**
 * Datasheet section. A single instrument card with a left dataset of
 * mono key:value rows + a right column of three big animated counters.
 * Reads like a published spec sheet for a measuring instrument.
 */
export function Specs() {
  const ref = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setArmed(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const SPEC_ROWS: Array<[string, string, string?]> = [
    ['ENGINES', 'postgres · redis · opensearch', 'first-class'],
    ['SQL DIALECT', 'postgres 13 → 17', 'schema-aware'],
    ['EDITOR', 'monaco · multi-tab · pinned', 'unsaved-safe'],
    ['AI', 'tool use · engine-aware', 'opt-in'],
    ['EXPLAIN', 'tree · cost · hot-nodes', 'inline'],
    ['STATE', 'per-connection / forever', 'tabs · filters · pins'],
    ['THEMES', '9 editorial · live retint', 'tunable'],
    ['TELEMETRY', 'opt-in · anonymous', 'no requirements'],
    ['UPDATE', 'in-app · signed', 'reversible'],
    ['LICENSE', LICENSE.toLowerCase(), 'no asterisks'],
  ];

  return (
    <section id="specs" ref={ref} className="relative px-4 md:px-8 py-[14vh] border-b border-line-strong">
      <div className="mx-auto max-w-[1440px]">
        <Reveal>
          <div className="grid grid-cols-12 gap-6 mb-12 items-end">
            <div className="col-span-12 md:col-span-9">
              <div className="sec-no mb-5">¶ 02 — Datasheet</div>
              <h2
                className="font-display leading-[0.92] tracking-[-0.04em] text-fg"
                style={{
                  fontSize: 'clamp(40px, 7vw, 120px)',
                  fontVariationSettings: '"opsz" 96, "wdth" 100, "wght" 700',
                }}
              >
                One binary.{' '}
                <span className="text-plasma glow-plasma">Three engines.</span>{' '}
                <span className="text-dim">Zero subscriptions.</span>
              </h2>
            </div>
            <div className="col-span-12 md:col-span-3 self-end label">
              MODEL · plsm-{VERSION} <br />
              MFR · pankaj yadav · 2026
            </div>
          </div>
        </Reveal>

        <InstrumentFrame
          index="02·SPEC"
          title="device characteristics"
          meta={`SHA-256 · a7d1…b88e / ${SIZE_LABEL}`}
          accent="plasma"
        >
          <div className="grid grid-cols-12 gap-0 bg-bg-2">
            {/* Spec rows */}
            <div className="col-span-12 md:col-span-7 lg:col-span-8 p-6 md:p-8 border-r border-line">
              <div className="label mb-4 flex items-center justify-between">
                <span>parameter</span>
                <span>value · note</span>
              </div>
              <div className="space-y-0">
                {SPEC_ROWS.map(([k, v, note], i) => (
                  <div
                    key={k}
                    className="grid grid-cols-12 gap-3 py-3 border-t border-line items-baseline group"
                    style={{ transitionDelay: `${i * 30}ms` }}
                  >
                    <div className="col-span-4 md:col-span-3 label label-strong">
                      {k}
                    </div>
                    <div className="col-span-12 md:col-span-6 font-mono text-[14px] text-fg group-hover:text-plasma transition-colors">
                      {v}
                    </div>
                    <div className="col-span-12 md:col-span-3 label">
                      {note ?? '—'}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Counters column */}
            <div className="col-span-12 md:col-span-5 lg:col-span-4 p-6 md:p-8 grid grid-rows-3 gap-px bg-line-strong">
              <Counter
                armed={armed}
                value={86}
                suffix="MB"
                label="installer · macOS / windows"
                color="text-plasma"
                glow="glow-plasma"
              />
              <Counter
                armed={armed}
                value={9}
                suffix=""
                label="editorial themes shipped"
                color="text-volt"
              />
              <Counter
                armed={armed}
                value={0}
                suffix=""
                label="usd / month / forever"
                color="text-ox"
                glow="glow-ox"
              />
            </div>
          </div>
        </InstrumentFrame>
      </div>
    </section>
  );
}

function Counter({
  armed,
  value,
  suffix,
  label,
  color,
  glow,
}: {
  armed: boolean;
  value: number;
  suffix?: string;
  label: string;
  color: string;
  glow?: string;
}) {
  const [n, setN] = useState(0);

  useEffect(() => {
    if (!armed) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setN(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const dur = 1400;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(Math.round(value * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [armed, value]);

  return (
    <div className="bg-bg p-6 flex flex-col justify-between">
      <div className="label">{label}</div>
      <div
        className={`font-display ${color} ${glow ?? ''} mt-4`}
        style={{
          fontSize: 'clamp(56px, 6vw, 96px)',
          fontVariationSettings: '"opsz" 96, "wdth" 100, "wght" 800',
          letterSpacing: '-0.04em',
          lineHeight: 0.9,
        }}
      >
        {n}
        {suffix && <span className="text-dim text-[0.5em] ml-1">{suffix}</span>}
      </div>
    </div>
  );
}
