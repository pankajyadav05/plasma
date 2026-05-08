'use client';

import { Reveal } from '@/components/reveal';

const ROWS = [
  ['Schema-aware AI tool use', 'reads schema first', 'hallucinates columns'],
  ['Postgres + Redis + OpenSearch', 'one client', 'three different tools'],
  ['EXPLAIN tree viewer', 'plan + cost + hot nodes', 'JSON dump or skip'],
  ['State per connection', 'tabs · filters · pins · forever', 'reopen, lose your seat'],
  ['Editorial typography', 'Fraunces · Geist · JetBrains', 'system Helvetica'],
  ['Price', 'free · Apache 2.0', 'free CE / $89 / $229·yr'],
];

/**
 * Sharp diff. A single 3-column grid: criterion / Plasma / the others.
 * No table chrome, no checkmarks, no decoration. The Plasma column is
 * lit accent; the others column is dim.
 */
export function Versus() {
  return (
    <section id="versus" className="relative px-6 md:px-10 py-[14vh] border-b border-line">
      <div className="mx-auto max-w-[1440px]">
        <Reveal>
          <div className="grid grid-cols-12 gap-6 mb-16 items-end">
            <div className="col-span-12 md:col-span-9">
              <div className="sec-no mb-6">¶ 04 — Versus</div>
              <h2
                className="font-display italic leading-[0.95] tracking-[-0.03em]"
                style={{
                  fontSize: 'clamp(48px, 8vw, 144px)',
                  fontVariationSettings: '"opsz" 144, "SOFT" 100, "WONK" 1',
                }}
              >
                A different <span className="not-italic text-ox">shape</span>.
              </h2>
            </div>
            <div className="col-span-12 md:col-span-3 self-end font-mono text-[11px] uppercase tracking-[0.3em] text-dim">
              vs · DBeaver · DataGrip · TablePlus
            </div>
          </div>
        </Reveal>

        <div role="table" className="border-y border-line">
          <Reveal as="div">
            <div role="row" className="grid grid-cols-12 gap-6 py-4 border-b border-line font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
              <div className="col-span-4">criterion</div>
              <div className="col-span-4 text-ox">plasma</div>
              <div className="col-span-4">the others</div>
            </div>
          </Reveal>
          {ROWS.map(([crit, mine, theirs], i) => (
            <Reveal
              key={crit}
              delay={i * 50}
              as="div"
              className="grid grid-cols-12 gap-6 py-8 border-b border-line items-baseline"
            >
              <div className="col-span-4 font-display italic text-2xl md:text-3xl text-fg/85"
                style={{ fontVariationSettings: '"opsz" 36, "SOFT" 100, "WONK" 1' }}
              >
                {crit}
              </div>
              <div className="col-span-4 font-display italic text-2xl md:text-3xl text-ox glow-fg"
                style={{ fontVariationSettings: '"opsz" 36, "SOFT" 100, "WONK" 1' }}
              >
                {mine}
              </div>
              <div className="col-span-4 font-display italic text-2xl md:text-3xl text-dim line-through decoration-line decoration-[1px]"
                style={{ fontVariationSettings: '"opsz" 36, "SOFT" 0, "WONK" 0' }}
              >
                {theirs}
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
