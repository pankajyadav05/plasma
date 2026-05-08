'use client';

import { ArrowDown, ArrowUpRight } from 'lucide-react';
import { Magnetic } from '@/components/magnetic';
import { PlasmaBlob } from '@/components/plasma-blob';
import { DOWNLOAD_URL, LICENSE, SIZE_LABEL, VERSION } from '@/lib/version';

/**
 * Final CTA. Reuses the plasma blob behind a single OPEN word — the
 * whole page closes the loop visually with the same fluid motif it
 * opened on. ONE tag, ONE row of CTAs, one whisper line of metadata.
 */
export function Open() {
  return (
    <section
      id="open"
      className="relative h-screen min-h-[820px] overflow-hidden border-b border-line"
    >
      <PlasmaBlob />

      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(60% 60% at 50% 50%, transparent 0%, color-mix(in srgb, var(--bg) 30%, transparent) 50%, var(--bg) 100%)',
        }}
      />

      <div className="absolute z-10 left-6 right-6 md:left-10 md:right-10 top-24 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
        <span>¶ 05 — Open it</span>
        <span className="hidden md:inline">free · {LICENSE} · {SIZE_LABEL}</span>
      </div>

      <div className="relative z-10 h-full grid place-items-center px-6 md:px-10">
        <div className="text-center">
          <h2
            className="font-display italic text-fg glow-fg"
            style={{
              fontSize: 'clamp(140px, 28vw, 480px)',
              lineHeight: 0.84,
              letterSpacing: '-0.045em',
              fontVariationSettings: '"opsz" 144, "SOFT" 100, "WONK" 1',
            }}
          >
            Open<span className="text-ox">.</span>
          </h2>
          <p
            className="mt-10 mx-auto text-fg/85 font-display italic max-w-[28ch]"
            style={{
              fontSize: 'clamp(20px, 2.2vw, 32px)',
              fontVariationSettings: '"opsz" 36, "SOFT" 100, "WONK" 1',
            }}
          >
            Free. Made in a quiet room.
          </p>
          <div className="mt-12 flex justify-center flex-wrap gap-3">
            <Magnetic strength={0.18}>
              <a
                href={DOWNLOAD_URL}
                data-cursor="windows · 86 mb"
                className="inline-flex items-center gap-3 px-7 py-4 bg-ox text-bg font-mono text-[11px] uppercase tracking-[0.3em] hover:bg-accent"
              >
                <ArrowDown className="h-3.5 w-3.5" />
                Download v{VERSION}
              </a>
            </Magnetic>
            <Magnetic strength={0.18}>
              <a
                href="https://github.com/pankajyadav05/plasma/releases"
                data-cursor="all releases"
                className="inline-flex items-center gap-3 px-7 py-4 border border-line text-fg/85 font-mono text-[11px] uppercase tracking-[0.3em] hover:border-fg hover:text-fg"
              >
                All releases
                <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            </Magnetic>
          </div>
        </div>
      </div>

      <div className="absolute z-10 left-6 right-6 md:left-10 md:right-10 bottom-8 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
        <span>plasma-setup-{VERSION}-x64.exe</span>
        <span>sha-256 a7d1…b88e</span>
      </div>
    </section>
  );
}
