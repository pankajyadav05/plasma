'use client';

import { useState } from 'react';
import { Reveal } from '@/components/reveal';

const QUESTIONS: { q: string; a: string }[] = [
  {
    q: 'Why Windows only — for now?',
    a: 'I shipped on the OS I use every day, so the polish is real instead of theoretical. macOS and Linux builds are in flight. The codebase is portable; the gating is signing, packaging, and the time to do them properly.',
  },
  {
    q: 'Where does the AI run? What does it see?',
    a: 'The AI runs against your chosen provider (you pick the model and key). Plasma never sends your queries through a proxy. Tool use is engine-aware: schema reads, sample rows, EXPLAIN — and only after you opt in for that connection.',
  },
  {
    q: 'Telemetry?',
    a: 'Off by default. If you turn it on, you get a single anonymous ping on launch with the version and a UUID. No queries, no schema, no row counts. The full event list lives in the Settings panel and on the GitHub repo.',
  },
  {
    q: 'Why three engines instead of just Postgres?',
    a: 'Most teams I know run all three. Carrying three apps, three keychains, three theme settings — it adds up. Plasma keeps the editor identity constant and rewires the linter, autocomplete, and AI tools per engine.',
  },
  {
    q: 'Apache 2.0 — really?',
    a: 'Really. Fork it, extend it, ship a paid product on top. The only ask is that you keep attribution. There is no enterprise edition, no commercial-license trapdoor, no "core" with a thinner outer ring.',
  },
  {
    q: 'How do you make money?',
    a: 'By design, nothing today — Plasma is funded by my day job, which keeps it free of investor timelines. The next chapter, when teams ask for it, will be optional paid hosted-AI plans for orgs that want managed model + key rotation. The editor, all three engines, and the themes stay free forever.',
  },
];

/**
 * Six common objections with confident answers. Custom accordion — no
 * shadcn dependency — with a smooth height transition and a +/× icon
 * that rotates. Two-column on desktop.
 */
export function FAQ() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section
      id="faq"
      className="relative px-4 md:px-8 py-[14vh] border-b border-line-strong"
    >
      <div className="mx-auto max-w-[1440px]">
        <Reveal>
          <div className="grid grid-cols-12 gap-6 mb-14 items-end">
            <div className="col-span-12 md:col-span-9">
              <div className="sec-no mb-5">¶ 12 — Common questions</div>
              <h2
                className="font-display leading-[0.92] tracking-[-0.04em]"
                style={{
                  fontSize: 'clamp(40px, 7vw, 120px)',
                  fontVariationSettings: '"opsz" 96, "wdth" 100, "wght" 700',
                }}
              >
                Read this{' '}
                <span className="text-plasma">before you ask</span>.
              </h2>
            </div>
            <div className="col-span-12 md:col-span-3 self-end label">
              tap a row to expand <br />
              esc to collapse
            </div>
          </div>
        </Reveal>

        <div className="border-y border-line-strong">
          {QUESTIONS.map((item, i) => {
            const isOpen = i === open;
            return (
              <Reveal
                key={item.q}
                delay={i * 40}
                as="div"
                className="border-b border-line last:border-b-0"
              >
                <button
                  type="button"
                  data-cursor={isOpen ? 'collapse' : 'expand'}
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="w-full text-left grid grid-cols-12 gap-4 items-baseline py-7 group hover:bg-bg-2/40 transition-colors px-4 md:px-6"
                  aria-expanded={isOpen}
                  aria-controls={`faq-panel-${i}`}
                  id={`faq-trigger-${i}`}
                >
                  <div className="col-span-2 md:col-span-1 label label-plasma font-mono">
                    Q·{String(i + 1).padStart(2, '0')}
                  </div>
                  <div
                    className="col-span-9 md:col-span-10 font-display text-fg leading-snug"
                    style={{
                      fontSize: 'clamp(20px, 2.2vw, 30px)',
                      fontVariationSettings:
                        '"opsz" 36, "wdth" 100, "wght" 600',
                    }}
                  >
                    {item.q}
                  </div>
                  <div
                    className={`col-span-1 text-right label transition-transform duration-300 ${
                      isOpen ? 'rotate-45 text-plasma' : ''
                    }`}
                  >
                    <span className="text-2xl">+</span>
                  </div>
                </button>
                <div
                  id={`faq-panel-${i}`}
                  role="region"
                  aria-labelledby={`faq-trigger-${i}`}
                  aria-hidden={!isOpen}
                  className={`grid transition-[grid-template-rows] duration-500 ease-out ${
                    isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                  }`}
                >
                  <div className="overflow-hidden">
                    <div className="grid grid-cols-12 gap-4 pb-8 px-4 md:px-6">
                      <div className="col-span-2 md:col-span-1 label">A</div>
                      <p className="col-span-10 md:col-span-9 font-sans text-fg/75 text-[16px] leading-[1.65] max-w-[68ch]">
                        {item.a}
                      </p>
                    </div>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>

        <Reveal as="div" className="mt-8 flex items-center justify-between label">
          <span>
            <span className="label-plasma">↗ </span>
            still curious? open an issue on github
          </span>
          <span>{QUESTIONS.length} / {QUESTIONS.length} answered</span>
        </Reveal>
      </div>
    </section>
  );
}
