'use client';

import { Reveal } from '@/components/reveal';

interface Anti {
  no: string;
  why: string;
  detail: string;
}

const ANTIS: Anti[] = [
  {
    no: 'No telemetry by default',
    why: 'Privacy is the default state, not a setting you remember to flip.',
    detail: 'Off · until you turn it on · single anonymous launch ping if you do',
  },
  {
    no: 'No paywalled engines',
    why: 'Postgres, Redis, OpenSearch — all three, all the time, no upsell.',
    detail: 'No CE / Pro / Team. The product you download is the whole product.',
  },
  {
    no: 'No silent writes',
    why: "The AI can suggest. The AI cannot ship. Your hand is on every commit.",
    detail: 'Apply suggestion → preview pane → you press Enter. Always.',
  },
  {
    no: 'No enterprise tier',
    why: 'No 5-seat minimum, no annual contract, no SSO behind a salesperson.',
    detail: 'Apache 2.0 — fork it, host it, ship it. Same binary for everyone.',
  },
  {
    no: 'No usage tracking',
    why: 'Your queries are your business. We do not log them, sample them, or send them anywhere.',
    detail: 'No tab events · no schema pings · no query corpus building',
  },
  {
    no: 'No format lock-in',
    why: 'Connections export as JSON. Themes are .toml files. Plain text in, plain text out.',
    detail: 'Tabs · pins · filters all human-editable on disk',
  },
  {
    no: 'No requirements server',
    why: "You can run Plasma on a plane, in a SCIF, behind a firewall. Nothing phones home for a license check.",
    detail: 'Offline · always · forever · check the network log',
  },
];

/**
 * The Vault — anti-feature manifesto. Seven hard NOs in a heavy
 * scanline frame. Inverts the usual "feature grid" by listing what
 * Plasma will refuse to do, with the reason for each refusal.
 */
export function Vault() {
  return (
    <section
      id="vault"
      className="relative px-4 md:px-8 py-[14vh] border-b border-line-strong overflow-hidden"
      style={{
        background:
          'linear-gradient(180deg, var(--bg) 0%, var(--bg-2) 50%, var(--bg) 100%)',
      }}
    >
      {/* Scan grain overlay */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none opacity-[0.06]"
        style={{
          background:
            'repeating-linear-gradient(0deg, transparent 0, transparent 3px, var(--ox) 3px, var(--ox) 4px)',
        }}
      />

      <div className="relative mx-auto max-w-[1440px]">
        <Reveal>
          <div className="grid grid-cols-12 gap-6 mb-12 items-end">
            <div className="col-span-12 md:col-span-9">
              <div className="sec-no mb-5">¶ 07 — The Vault</div>
              {/* Stacked manifesto — first line dim, second line declarative */}
              <h2
                className="font-display leading-[0.88] tracking-[-0.04em]"
                style={{
                  fontSize: 'clamp(40px, 7vw, 120px)',
                  fontVariationSettings: '"opsz" 96, "wdth" 100, "wght" 700',
                }}
              >
                <span className="block text-dim font-sans text-[0.4em] uppercase tracking-[0.32em] mb-3">
                  Manifesto, sealed
                </span>
                <span className="block text-fg">
                  Seven things Plasma
                </span>
                <span className="block">
                  <span className="text-ox glow-ox italic">will not</span>{' '}
                  <span className="text-fg">do.</span>
                </span>
              </h2>
              <p className="mt-5 text-fg/70 max-w-[60ch] font-sans text-[16px] leading-relaxed">
                A landing page is full of yes. This one is the no — sealed and
                printed. Anti-features that we lock in, so the next person to
                touch the codebase has to argue past them.
              </p>
            </div>
            <div className="col-span-12 md:col-span-3 self-end label">
              <div className="border border-line-strong px-3 py-2 inline-block">
                <div className="label label-strong">SEAL · 0×7F</div>
                <div>{ANTIS.length} hard NOs</div>
                <div className="label-ox">authorized · pankaj y.</div>
              </div>
            </div>
          </div>
        </Reveal>

        {/* Vault cards grid — first row is feature, others stack */}
        <div className="grid grid-cols-12 gap-px bg-line-strong border-2 border-ox/40">
          {ANTIS.map((a, i) => {
            const featured = i === 0;
            const span = featured
              ? 'col-span-12 md:col-span-12'
              : 'col-span-12 md:col-span-6';
            return (
              <Reveal
                key={a.no}
                delay={i * 60}
                as="article"
                className={`bg-bg p-7 md:p-10 group relative overflow-hidden ${span}`}
              >
                {/* Diagonal NO stamp */}
                <div
                  aria-hidden
                  className="absolute -right-6 -top-3 select-none pointer-events-none opacity-[0.07] font-display text-ox"
                  style={{
                    fontSize: 'clamp(120px, 16vw, 220px)',
                    fontVariationSettings:
                      '"opsz" 96, "wdth" 200, "wght" 800',
                    transform: 'rotate(-8deg)',
                    letterSpacing: '-0.05em',
                  }}
                >
                  NO
                </div>

                <div className="relative">
                  <div className="flex items-center gap-3 mb-5">
                    <span
                      className="block h-2.5 w-2.5 rounded-full bg-ox"
                      style={{ boxShadow: '0 0 12px var(--ox)' }}
                    />
                    <span className="label label-ox tabular-nums">
                      RULE · {String(i + 1).padStart(2, '0')} / 07
                    </span>
                    <span className="label">SEALED</span>
                  </div>

                  <h3
                    className={`font-display text-fg leading-[0.98] tracking-[-0.035em] ${
                      featured ? 'mb-5' : 'mb-4'
                    }`}
                    style={{
                      fontSize: featured
                        ? 'clamp(34px, 4.5vw, 64px)'
                        : 'clamp(24px, 2.4vw, 36px)',
                      fontVariationSettings:
                        '"opsz" 96, "wdth" 100, "wght" 700',
                    }}
                  >
                    {a.no}.
                  </h3>

                  <p
                    className={`text-fg/80 font-sans leading-[1.55] max-w-[60ch] ${
                      featured ? 'text-[18px] mb-5' : 'text-[15px] mb-4'
                    }`}
                  >
                    {a.why}
                  </p>

                  <div
                    className="pl-4 border-l-2 border-ox font-mono text-[12.5px] text-fg/65 leading-relaxed"
                  >
                    {a.detail}
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>

        <Reveal as="div" className="mt-8 flex items-baseline justify-between label">
          <span>
            <span className="label-ox">⊗ </span>
            non-negotiable · authored 2026 · enforced in code
          </span>
          <span>{ANTIS.length} / {ANTIS.length} sealed</span>
        </Reveal>
      </div>
    </section>
  );
}
