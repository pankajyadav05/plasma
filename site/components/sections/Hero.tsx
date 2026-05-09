'use client';

import { ArrowUpRight } from 'lucide-react';
import { DownloadCTA } from '@/components/DownloadCTA';
import { Magnetic } from '@/components/magnetic';
import { Oscilloscope } from '@/components/oscilloscope';

/**
 * Hero is one screen: a live oscilloscope canvas behind the wordmark.
 * The signal warps when the cursor moves — proximity to the trace = more
 * amplitude + chromatic split. The wordmark sits over it in heavy display
 * Bricolage. Below: tagline + two CTAs. Top/bottom: instrument tags.
 */
export function Hero() {
  return (
    <section
      id="top"
      className="relative h-screen min-h-[820px] overflow-hidden border-b border-line-strong"
    >
      <Oscilloscope variant="hero" />

      {/* Subtle vignette so the wordmark holds against the trace */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none z-[1]"
        style={{
          background:
            'radial-gradient(60% 60% at 50% 55%, transparent 0%, color-mix(in srgb, var(--bg) 30%, transparent) 50%, var(--bg) 100%)',
        }}
      />

      {/* Centerpiece */}
      <div className="relative z-10 h-full grid place-items-center px-4 md:px-8">
        <div className="text-center max-w-[1280px]">
          <h1
            className="font-display text-fg leading-[0.86]"
            style={{
              fontSize: 'clamp(96px, 22vw, 380px)',
              fontVariationSettings: '"opsz" 96, "wdth" 200, "wght" 800',
              letterSpacing: '-0.055em',
            }}
          >
            plasma<span className="text-plasma glow-plasma">.</span>
          </h1>

          <p
            className="mt-8 mx-auto text-fg/85 max-w-[44ch] font-sans"
            style={{ fontSize: 'clamp(18px, 1.8vw, 24px)', lineHeight: 1.4 }}
          >
            A precision client for{' '}
            <span className="text-plasma">Postgres</span>,{' '}
            <span className="text-ox">Redis</span> &{' '}
            <span className="text-volt">OpenSearch</span>.
            <br className="hidden md:inline" />
            Built like a measurement instrument.
          </p>

          <div className="mt-12 flex flex-col items-center gap-5">
            <div className="flex justify-center flex-wrap gap-3 items-center">
              <DownloadCTA size="md" alternates />
              <Magnetic strength={0.18}>
                <a
                  href="https://github.com/pankajyadav05/plasma"
                  data-cursor="source · github"
                  className="inline-flex items-center gap-3 px-7 py-4 border border-line-strong text-fg/85 font-mono text-[11px] uppercase tracking-[0.3em] hover:border-plasma hover:text-plasma transition-colors"
                >
                  Read source
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
              </Magnetic>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom rail */}
      <div className="absolute z-10 left-4 right-4 md:left-8 md:right-8 bottom-6 flex items-center justify-between label">
        <span>SCROLL ↓ TO READ DATASHEET</span>
        <span className="hidden md:inline label-plasma">
          TYPE <span className="label-strong">EXPLAIN</span> ANYWHERE ↗
        </span>
      </div>
    </section>
  );
}
