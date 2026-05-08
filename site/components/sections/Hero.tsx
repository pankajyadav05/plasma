'use client';

import { ArrowDown, ArrowUpRight } from 'lucide-react';
import { Magnetic } from '@/components/magnetic';
import { PlasmaBlob } from '@/components/plasma-blob';
import { DOWNLOAD_URL, VERSION } from '@/lib/version';

/**
 * The hero is one room: a live plasma blob (six metaballs merged via an
 * SVG goo filter) rolling around behind the title, with one ball
 * tracking the pointer. The Plasma word sits over it in display italic.
 *
 * One signature move: the blob _is_ the brand. Move your mouse and the
 * fluid follows. Below the title, a single tagline + two CTAs. Top and
 * bottom rails are mono whisper labels — no dossier, no marquee, no
 * vertical type.
 */
export function Hero() {
  return (
    <section
      id="top"
      className="relative h-screen min-h-[820px] overflow-hidden border-b border-line"
    >
      {/* Plasma blob behind everything */}
      <PlasmaBlob />

      {/* Soft vignette that pulls focus to the title */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(60% 60% at 50% 50%, transparent 0%, color-mix(in srgb, var(--bg) 30%, transparent) 50%, var(--bg) 100%)',
        }}
      />

      {/* Top rail */}
      <div className="absolute z-10 left-6 right-6 md:left-10 md:right-10 top-24 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
        <span className="flex items-center gap-3">
          <span className="block h-1.5 w-1.5 rounded-full bg-ox shadow-[0_0_12px_var(--ox)]" />
          v{VERSION} · live now
        </span>
        <span className="hidden md:inline">postgres · redis · opensearch</span>
      </div>

      {/* Centerpiece */}
      <div className="relative z-10 h-full grid place-items-center px-6 md:px-10">
        <div className="text-center max-w-[1240px]">
          <h1
            className="font-display italic text-fg glow-fg"
            style={{
              fontSize: 'clamp(120px, 26vw, 420px)',
              lineHeight: 0.86,
              letterSpacing: '-0.045em',
              fontVariationSettings: '"opsz" 144, "SOFT" 100, "WONK" 1',
            }}
          >
            Plasma<span className="text-ox">.</span>
          </h1>
          <p
            className="mt-10 mx-auto text-fg/85 font-display italic max-w-[28ch]"
            style={{
              fontSize: 'clamp(22px, 2.4vw, 36px)',
              fontVariationSettings: '"opsz" 36, "SOFT" 100, "WONK" 1',
            }}
          >
            Postgres, Redis &amp; OpenSearch — in one editorial client.
          </p>

          <div className="mt-14 flex justify-center flex-wrap gap-3">
            <Magnetic strength={0.18}>
              <a
                href={DOWNLOAD_URL}
                data-cursor="windows · 86 mb"
                className="inline-flex items-center gap-3 px-7 py-4 bg-fg text-bg font-mono text-[11px] uppercase tracking-[0.3em] hover:bg-ox hover:text-bg"
              >
                <ArrowDown className="h-3.5 w-3.5" />
                Download v{VERSION}
              </a>
            </Magnetic>
            <Magnetic strength={0.18}>
              <a
                href="https://github.com/pankajyadav05/plasma"
                data-cursor="source"
                className="inline-flex items-center gap-3 px-7 py-4 border border-line text-fg/85 font-mono text-[11px] uppercase tracking-[0.3em] hover:border-fg hover:text-fg"
              >
                GitHub
                <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            </Magnetic>
          </div>
        </div>
      </div>

      {/* Bottom rail */}
      <div className="absolute z-10 left-6 right-6 md:left-10 md:right-10 bottom-8 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
        <span>scroll to read</span>
        <span className="hidden md:inline">type EXPLAIN to peek inside ↗</span>
      </div>
    </section>
  );
}
