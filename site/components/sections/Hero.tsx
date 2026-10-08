import { HeroPlate } from '@/components/hero-plate';
import type { Captures } from '@/lib/captures';
import { EngineRow } from '@/components/engine-row';

const LINES = ['One workbench', 'for all your', 'databases.'];

export function Hero({ captures }: { captures: Captures }) {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative pt-10 pb-24 md:pt-16 md:pb-32">
      <div className="wrap">
        <h1 id="hero-title" className="display t-hero mt-6 md:mt-8">
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

        <EngineRow />

        <p className="lede h-fade mt-8 max-w-[38ch] md:mt-10" style={{ '--d': '760ms' } as React.CSSProperties}>
          Plasma is a free, open-source desktop client. It connects to seven database engines. It stops dangerous
          changes before they run.
        </p>
      </div>

      <HeroPlate captures={captures} />
    </section>
  );
}
