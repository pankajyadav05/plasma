'use client';

import { ArrowDown, ArrowUpRight } from 'lucide-react';
import { Magnetic } from '@/components/magnetic';
import { Oscilloscope } from '@/components/oscilloscope';
import { DOWNLOAD_URL, SIZE_LABEL, VERSION } from '@/lib/version';

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

      {/* Top rail — instrument tag */}
      <div className="absolute z-10 left-4 right-4 md:left-8 md:right-8 top-[88px] flex items-center justify-between label">
        <span className="flex items-center gap-3">
          <span className="block h-1.5 w-1.5 rounded-full bg-plasma shadow-[0_0_10px_var(--plasma)]" />
          <span className="label-strong">CH·01</span>
          <span>/ TRACE</span>
          <span className="text-plasma hidden sm:inline">2.4 GHz</span>
        </span>
        <span className="hidden md:flex gap-3">
          <span>POSTGRES 13–17</span>
          <span>·</span>
          <span>REDIS 6+</span>
          <span>·</span>
          <span>OPENSEARCH 2+</span>
        </span>
      </div>

      {/* Centerpiece */}
      <div className="relative z-10 h-full grid place-items-center px-4 md:px-8">
        <div className="text-center max-w-[1280px]">
          <div className="mb-6 inline-flex items-center gap-3 px-3 py-1.5 border border-line-strong label">
            <span className="block h-1.5 w-1.5 rounded-full bg-plasma animate-pulse" />
            <span className="label-strong">v{VERSION}</span>
            <span>/ live build</span>
            <span className="label-plasma">/ apache-2.0</span>
          </div>

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

          <div className="mt-12 flex justify-center flex-wrap gap-3">
            <Magnetic strength={0.18}>
              <a
                href={DOWNLOAD_URL}
                data-cursor={`win·x64 · ${SIZE_LABEL}`}
                className="group inline-flex items-center gap-3 px-7 py-4 bg-plasma text-bg font-mono text-[11px] uppercase tracking-[0.3em] hover:bg-volt transition-colors"
              >
                <ArrowDown className="h-3.5 w-3.5" />
                Download v{VERSION}
                <span className="text-bg/55">/ {SIZE_LABEL}</span>
              </a>
            </Magnetic>
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

          {/* Stat ribbon */}
          <div className="mt-14 grid grid-cols-2 md:grid-cols-4 gap-px bg-line-strong border border-line-strong max-w-[860px] mx-auto">
            {[
              ['3', 'engines'],
              ['9', 'themes'],
              ['1', 'binary'],
              ['0', 'subscriptions'],
            ].map(([n, l]) => (
              <div key={l} className="bg-bg p-4">
                <div
                  className="font-display text-fg leading-none"
                  style={{
                    fontSize: 'clamp(36px, 4vw, 56px)',
                    fontVariationSettings:
                      '"opsz" 96, "wdth" 100, "wght" 700',
                  }}
                >
                  {n}
                </div>
                <div className="label mt-2">{l}</div>
              </div>
            ))}
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
