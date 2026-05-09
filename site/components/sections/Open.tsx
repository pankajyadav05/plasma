'use client';

import { ArrowUpRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DownloadCTA } from '@/components/DownloadCTA';
import { InstrumentFrame } from '@/components/instrument-frame';
import { Magnetic } from '@/components/magnetic';
import { Oscilloscope } from '@/components/oscilloscope';
import { usePlatform } from '@/lib/platform';
import { LICENSE, VERSION } from '@/lib/version';

const PROMPT_LINES = [
  '$ plasma --check signature',
  'verifying plasma-setup-' + VERSION + '-x64.exe …',
  'sha-256 a7d1…b88e  OK',
  'authenticode  OK · pankaj yadav · ev cert',
  '',
  '$ plasma --connect prod-replica',
  'reading schema · public.* analytics.* stripe.*',
  'cached · 142 tables · 38 views · 12 enums',
  '',
  '$ plasma --ready',
  'editor: monaco / 4 tabs restored',
  'ai:     opt-in / engine-aware tool use',
  'theme:  paper / 9 available',
  '',
  '↳ launching at 60fps · cold-start 583 ms',
];

/**
 * Final CTA — the typed terminal closes the loop. A second oscilloscope
 * trace sits behind a giant OPEN. wordmark. Type-by-type animation of a
 * verification + ready handshake. Two CTAs land below.
 */
export function Open() {
  const [typed, setTyped] = useState<string[]>([]);
  const { primary } = usePlatform();

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setTyped(PROMPT_LINES);
      return;
    }
    let cancelled = false;
    let id: ReturnType<typeof setTimeout> | undefined;
    const step = (i: number) => {
      if (cancelled || i >= PROMPT_LINES.length) return;
      const next = PROMPT_LINES[i];
      setTyped((t) => [...t, next]);
      id = setTimeout(() => step(i + 1), 220 + Math.random() * 220);
    };
    id = setTimeout(() => step(0), 600);
    return () => {
      cancelled = true;
      if (id) clearTimeout(id);
    };
  }, []);

  return (
    <section
      id="open"
      className="relative min-h-screen overflow-hidden border-b border-line-strong"
    >
      <Oscilloscope variant="hero" />
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none z-[1]"
        style={{
          background:
            'radial-gradient(70% 70% at 50% 55%, transparent 0%, color-mix(in srgb, var(--bg) 35%, transparent) 50%, var(--bg) 100%)',
        }}
      />

      {/* Top rail */}
      <div className="absolute z-10 left-4 right-4 md:left-8 md:right-8 top-[88px] flex items-center justify-between label">
        <span>¶ 13 — Open it</span>
        <span className="hidden md:inline">
          free · {LICENSE.toLowerCase()} · {primary.sizeLabel}
        </span>
      </div>

      <div className="relative z-10 px-4 md:px-8 pt-[20vh] pb-[12vh] grid place-items-center">
        <div className="text-center max-w-[1240px] w-full">
          <h2
            className="font-display text-fg glow-plasma"
            style={{
              fontSize: 'clamp(120px, 24vw, 420px)',
              fontVariationSettings: '"opsz" 96, "wdth" 200, "wght" 800',
              letterSpacing: '-0.055em',
              lineHeight: 0.86,
            }}
          >
            open<span className="text-plasma">.</span>
          </h2>
          <p
            className="mt-8 mx-auto text-fg/85 max-w-[44ch] font-sans"
            style={{ fontSize: 'clamp(18px, 1.8vw, 24px)', lineHeight: 1.4 }}
          >
            Free. Forever. Made in a quiet room.
          </p>

          <div className="mt-10 flex flex-col items-center gap-5">
            <div className="flex justify-center flex-wrap gap-3 items-start">
              <DownloadCTA size="lg" alternates />
              <Magnetic strength={0.18}>
                <a
                  href="https://github.com/pankajyadav05/plasma/releases"
                  data-cursor="all releases"
                  className="inline-flex items-center gap-3 px-8 py-5 border border-line-strong text-fg/85 font-mono text-[12px] uppercase tracking-[0.3em] hover:border-plasma hover:text-plasma transition-colors"
                >
                  All releases
                  <ArrowUpRight className="h-4 w-4" />
                </a>
              </Magnetic>
            </div>
          </div>

          {/* Terminal handshake */}
          <div className="mt-16 mx-auto max-w-[820px] text-left">
            <InstrumentFrame
              index="08·HANDSHAKE"
              title="cold start trace"
              meta="local · no network"
              accent="plasma"
            >
              <div className="bg-bg-2/95 backdrop-blur-sm p-6 font-mono text-[12.5px] leading-[1.85] min-h-[360px]">
                {typed.map((raw, i) => {
                  const l = raw ?? '';
                  return (
                  <div
                    key={i}
                    className={
                      l.startsWith('$')
                        ? 'text-plasma'
                        : l === ''
                          ? 'h-[1em]'
                          : l.includes('OK')
                            ? 'text-volt'
                            : 'text-fg/70'
                    }
                  >
                    {l || ' '}
                  </div>
                  );
                })}
                {typed.length < PROMPT_LINES.length && (
                  <span className="caret" />
                )}
              </div>
            </InstrumentFrame>
          </div>
        </div>
      </div>

      {/* Bottom rail */}
      <div className="absolute z-10 left-4 right-4 md:left-8 md:right-8 bottom-6 flex items-center justify-between label">
        <span>{primary.basename.toLowerCase()}</span>
        <span className="label-plasma">sha-256 a7d1…b88e</span>
      </div>
    </section>
  );
}
