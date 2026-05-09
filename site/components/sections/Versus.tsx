'use client';

import { Reveal } from '@/components/reveal';

interface SchemRow {
  crit: string;
  mineLabel: string;
  mineFill: number; // 0-100
  theirsLabel: string;
  theirsFill: number;
  unit: string;
}

const ROWS: SchemRow[] = [
  {
    crit: 'AI · schema awareness',
    mineLabel: 'reads schema first · tool use',
    mineFill: 96,
    theirsLabel: 'hallucinates columns',
    theirsFill: 22,
    unit: 'accuracy',
  },
  {
    crit: 'Engines · supported',
    mineLabel: 'postgres · redis · opensearch',
    mineFill: 100,
    theirsLabel: 'three different apps',
    theirsFill: 33,
    unit: 'first-class',
  },
  {
    crit: 'EXPLAIN · viewer',
    mineLabel: 'tree · cost · hot-nodes',
    mineFill: 92,
    theirsLabel: 'json dump or skip',
    theirsFill: 18,
    unit: 'readability',
  },
  {
    crit: 'State · per connection',
    mineLabel: 'tabs · filters · pins · forever',
    mineFill: 95,
    theirsLabel: 'reopen · lose your seat',
    theirsFill: 28,
    unit: 'durability',
  },
  {
    crit: 'Typography',
    mineLabel: 'bricolage · geist · jetbrains',
    mineFill: 100,
    theirsLabel: 'system helvetica',
    theirsFill: 35,
    unit: 'crafted',
  },
  {
    crit: 'Price · forever',
    mineLabel: 'free · apache 2.0',
    mineFill: 100,
    theirsLabel: 'free CE / $89 / $229·yr',
    theirsFill: 40,
    unit: 'no asterisks',
  },
];

const BLOCKS = '█████████████████████████';
function bar(fill: number, width = 24) {
  const filled = Math.round((fill / 100) * width);
  return BLOCKS.slice(0, filled) + '·'.repeat(Math.max(0, width - filled));
}

/**
 * Schematic: replaces side-by-side compare table with a vertical
 * stack of measurement rows. Each row reads like a spec-sheet line
 * with a unicode block-bar for plasma vs others.
 */
export function Versus() {
  return (
    <section
      id="schematic"
      className="relative px-4 md:px-8 py-[14vh] border-b border-line-strong"
    >
      <div className="mx-auto max-w-[1440px]">
        <Reveal>
          <div className="grid grid-cols-12 gap-6 mb-16 items-end">
            <div className="col-span-12 md:col-span-9">
              <div className="sec-no mb-5">¶ 10 — Schematic</div>
              <h2
                className="font-display leading-[0.92] tracking-[-0.04em]"
                style={{
                  fontSize: 'clamp(40px, 7vw, 120px)',
                  fontVariationSettings: '"opsz" 96, "wdth" 100, "wght" 700',
                }}
              >
                A different{' '}
                <span className="text-plasma">shape</span>.
              </h2>
            </div>
            <div className="col-span-12 md:col-span-3 self-end label">
              vs · DBeaver / DataGrip / TablePlus
              <br />
              measurement · subjective · 2026
            </div>
          </div>
        </Reveal>

        {/* Header row */}
        <Reveal as="div">
          <div className="grid grid-cols-12 gap-4 py-3 border-y border-line-strong label">
            <div className="col-span-12 md:col-span-3">parameter</div>
            <div className="col-span-12 md:col-span-1 hidden md:block">unit</div>
            <div className="col-span-12 md:col-span-4 label-plasma">
              plasma · subject
            </div>
            <div className="col-span-12 md:col-span-4">the others · control</div>
          </div>
        </Reveal>

        {ROWS.map((r, i) => (
          <Reveal
            key={r.crit}
            delay={i * 60}
            as="div"
            className="grid grid-cols-12 gap-4 py-7 border-b border-line items-baseline group"
          >
            <div className="col-span-12 md:col-span-3">
              <div
                className="font-display text-fg leading-tight"
                style={{
                  fontSize: 'clamp(20px, 2vw, 28px)',
                  fontVariationSettings:
                    '"opsz" 36, "wdth" 100, "wght" 600',
                }}
              >
                {r.crit}
              </div>
            </div>
            <div className="col-span-12 md:col-span-1 hidden md:block label">
              {r.unit}
            </div>

            <div className="col-span-12 md:col-span-4">
              <div className="ascii-bar text-plasma text-[15px] glow-plasma">
                {bar(r.mineFill)}
                <span className="ml-2 label label-plasma">
                  {String(r.mineFill).padStart(3, '0')}
                </span>
              </div>
              <div className="text-fg/85 font-mono text-[13px] mt-1">
                {r.mineLabel}
              </div>
            </div>

            <div className="col-span-12 md:col-span-4">
              <div className="ascii-bar text-faint text-[15px]">
                {bar(r.theirsFill)}
                <span className="ml-2 label">
                  {String(r.theirsFill).padStart(3, '0')}
                </span>
              </div>
              <div className="text-dim font-mono text-[13px] mt-1 line-through decoration-line decoration-[1px]">
                {r.theirsLabel}
              </div>
            </div>
          </Reveal>
        ))}

        <Reveal as="div" className="mt-8 flex items-center justify-between label">
          <span>
            <span className="label-plasma">σ · </span>
            scale 0 → 100 · subjective · author-rated
          </span>
          <span>06 / 06 rows</span>
        </Reveal>
      </div>
    </section>
  );
}
