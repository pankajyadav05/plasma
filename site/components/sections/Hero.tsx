import { HeroCta } from '@/components/hero-cta';
import { HeroPlate } from '@/components/hero-plate';
import type { Captures } from '@/lib/captures';

const LINES = ['One calm', 'workbench', 'for your data.'];

export function Hero({ captures }: { captures: Captures }) {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative pt-10 pb-28 md:pt-16 md:pb-40">
      <div className="wrap">
        <p className="label h-fade flex flex-wrap gap-x-3" style={{ '--d': '0ms' } as React.CSSProperties}>
          <span>Plate 00</span>
          <span className="text-ink-3">·</span>
          <span>Desktop client for Postgres, Redis &amp; OpenSearch</span>
        </p>

        <h1 id="hero-title" className="display t-hero mt-8 md:mt-10">
          {LINES.map((l, i) => (
            <span key={l} className="h-line">
              <span style={{ '--i': i } as React.CSSProperties}>
                {l.endsWith('.') ? (
                  <>
                    {l.slice(0, -1)}
                    <span className="text-signal">.</span>
                  </>
                ) : (
                  l
                )}
              </span>
            </span>
          ))}
        </h1>

        <div
          className="h-fade mt-12 grid gap-10 border-t border-rule pt-8 md:mt-16 lg:grid-cols-12 lg:gap-8"
          style={{ '--d': '520ms' } as React.CSSProperties}
        >
          <p className="lede lg:col-span-6">
            Plasma is an open-source desktop client for Postgres, Redis and OpenSearch. Native-feeling,
            keyboard-first, and careful with production.
          </p>
          <div className="lg:col-span-5 lg:col-start-8">
            <HeroCta />
            <p className="label mt-8 normal-case tracking-[0.02em] text-ink-2">
              Apache-2.0 · macOS (Apple Silicon &amp; Intel) · Windows x64
            </p>
          </div>
        </div>
      </div>

      <HeroPlate captures={captures} />
    </section>
  );
}
