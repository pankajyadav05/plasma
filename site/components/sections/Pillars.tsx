'use client';

import { Reveal } from '@/components/reveal';

const PILLARS = [
  {
    n: '01',
    name: 'Sovereign',
    line: 'Your database is your business. Plasma never phones home with your queries, schema, or rows.',
    fact: 'AI calls are local-prompted, opt-in, and visible. You control which engine the model can read.',
    accent: 'plasma' as const,
  },
  {
    n: '02',
    name: 'Quiet',
    line: "No upsells. No 'pro tier' nag. No telemetry until you turn it on. The app loads, then gets out of your way.",
    fact: 'Cold start under 600 ms. Empty editor. Empty status bar. You bring the noise.',
    accent: 'volt' as const,
  },
  {
    n: '03',
    name: 'Editorial',
    line: 'Typography is a tool, not a decoration. Plasma reads like a printed page so your eyes hold focus through long sessions.',
    fact: 'Bricolage Grotesque · Geist · JetBrains Mono. Spacing tuned per density mode.',
    accent: 'ox' as const,
  },
  {
    n: '04',
    name: 'Honest',
    line: "Apache 2.0. The whole source on GitHub. If we ship a bug, you can read it. If we ship a feature, you can fork it.",
    fact: 'No closed-source agent. No paywalled engine. No requirements server in the loop.',
    accent: 'plasma' as const,
  },
];

const ACCENT_CLASSES = {
  plasma: {
    text: 'text-plasma',
    glow: 'glow-plasma',
    bracket: 'bracket-plasma',
    dot: 'bg-plasma shadow-[0_0_10px_var(--plasma)]',
  },
  volt: {
    text: 'text-volt',
    glow: '',
    bracket: '',
    dot: 'bg-volt shadow-[0_0_10px_var(--volt)]',
  },
  ox: {
    text: 'text-ox',
    glow: 'glow-ox',
    bracket: 'bracket-ox',
    dot: 'bg-ox shadow-[0_0_10px_var(--ox)]',
  },
};

/**
 * Pillars: four operating principles. Replaces fabricated testimonials.
 * Honest stance, magazine-spread layout — index numeral + manifesto +
 * supporting fact. The set acts as social proof through credibility.
 */
export function Pillars() {
  return (
    <section
      id="pillars"
      className="relative px-4 md:px-8 py-[14vh] border-b border-line-strong"
    >
      <div className="mx-auto max-w-[1440px]">
        <Reveal>
          <div className="grid grid-cols-12 gap-6 mb-16 items-end">
            <div className="col-span-12 md:col-span-9">
              <div className="sec-no mb-5">¶ 06 — Operating principles</div>
              <h2
                className="font-display leading-[0.92] tracking-[-0.04em]"
                style={{
                  fontSize: 'clamp(40px, 7vw, 120px)',
                  fontVariationSettings: '"opsz" 96, "wdth" 100, "wght" 700',
                }}
              >
                Four pillars.{' '}
                <span className="text-plasma">No marketing.</span>
              </h2>
            </div>
            <div className="col-span-12 md:col-span-3 self-end label">
              the rules <br />
              we hold ourselves to <br />
              before we ship
            </div>
          </div>
        </Reveal>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-line-strong border border-line-strong">
          {PILLARS.map((p, i) => {
            const a = ACCENT_CLASSES[p.accent];
            return (
              <Reveal
                key={p.n}
                delay={i * 80}
                as="article"
                className="bg-bg p-8 md:p-12 group hover:bg-bg-2 transition-colors"
              >
                <div className="flex items-start justify-between mb-6">
                  <div
                    className={`font-display ${a.text} ${a.glow} leading-none`}
                    style={{
                      fontSize: 'clamp(80px, 9vw, 144px)',
                      fontVariationSettings:
                        '"opsz" 96, "wdth" 200, "wght" 800',
                      letterSpacing: '-0.05em',
                    }}
                  >
                    {p.n}
                  </div>
                  <div className="flex items-center gap-2 label">
                    <span className={`block h-1.5 w-1.5 rounded-full ${a.dot}`} />
                    <span className="label-strong">{p.name}</span>
                  </div>
                </div>

                <p
                  className="font-display text-fg leading-[1.05] tracking-[-0.025em] mb-6"
                  style={{
                    fontSize: 'clamp(22px, 2.4vw, 32px)',
                    fontVariationSettings:
                      '"opsz" 36, "wdth" 100, "wght" 500',
                  }}
                >
                  {p.line}
                </p>

                <div
                  className={`pl-4 border-l-2 ${
                    p.accent === 'plasma'
                      ? 'border-plasma'
                      : p.accent === 'volt'
                        ? 'border-volt'
                        : 'border-ox'
                  } text-fg/65 font-mono text-[13px] leading-relaxed`}
                >
                  {p.fact}
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
