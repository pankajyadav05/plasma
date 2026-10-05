import { HeroPlate } from '@/components/hero-plate';
import type { Captures } from '@/lib/captures';
import { ENGINE_LIST } from '@/lib/engines';

const LINES = ['One workbench', 'for all your', 'databases.'];

export function Hero({ captures }: { captures: Captures }) {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative pt-10 pb-24 md:pt-16 md:pb-32">
      <div className="wrap">
        <p className="label h-fade flex flex-wrap gap-x-3" style={{ '--d': '0ms' } as React.CSSProperties}>
          <span>Plate 00</span>
          <span className="text-ink-3">·</span>
          <span>Desktop client for SQL, Redis and OpenSearch</span>
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
            Plasma is a free, open-source desktop client. It connects to seven database engines. It stops
            dangerous changes before they run.
          </p>
          <div className="lg:col-span-5 lg:col-start-8">
            <p className="label">Engines</p>
            <ul className="mt-4 flex flex-wrap gap-2" aria-label="Supported engines">
              {ENGINE_LIST.map((e) => (
                <li
                  key={e.name}
                  className="mono inline-flex items-center gap-2 rounded-full border border-rule bg-paper-2/70 py-1.5 pl-2.5 pr-3.5 text-[12px] font-medium tracking-[0.02em] text-ink"
                >
                  <span className={`h-2 w-2 rounded-full ${e.chip}`} aria-hidden="true" />
                  {e.name}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <HeroPlate captures={captures} />
    </section>
  );
}
