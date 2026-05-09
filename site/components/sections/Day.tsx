'use client';

import { useRef } from 'react';
import { Reveal } from '@/components/reveal';
import { gsap, ScrollTrigger, useGSAP } from '@/lib/gsap';

interface Beat {
  time: string;
  title: string;
  body: string;
  snippet: { kind: 'shell' | 'sql' | 'ai' | 'done'; lines: string[] };
}

const BEATS: Beat[] = [
  {
    time: '08:30',
    title: 'open laptop',
    body: 'Plasma was where you left it. Four pinned tabs. Last query still highlighted. No splash screen, no signup, no banner.',
    snippet: {
      kind: 'shell',
      lines: [
        '$ plasma --restore',
        'restored 4 tabs · 2 unsaved drafts',
        'connection · prod-replica · 2.1 ms',
      ],
    },
  },
  {
    time: '08:32',
    title: '⌘1 — connect',
    body: 'One keystroke, the right replica. Schema cache is already warm — autocomplete works on table 142 of 142.',
    snippet: {
      kind: 'shell',
      lines: [
        '⌘1 → prod-replica',
        'schema · 142 tables · 38 views · cached',
        'idle · ready · cold-start 583 ms',
      ],
    },
  },
  {
    time: '08:33',
    title: 'type — find slow',
    body: "Plain English. Plasma's AI reads pg_stat_statements, picks the worst offender, and writes a real query — not a guess.",
    snippet: {
      kind: 'ai',
      lines: [
        '> find slow queries last 24h',
        '── reading pg_stat_statements ──',
        'top: GroupAggregate · events · 1.24 s mean',
        'reason: Bitmap Heap Scan · cold pages',
      ],
    },
  },
  {
    time: '08:34',
    title: 'EXPLAIN — read the plan',
    body: 'Tree view, hot path lit in orange. Two scans drinking the budget. The AI is already drafting a fix on the right rail.',
    snippet: {
      kind: 'sql',
      lines: [
        'EXPLAIN ANALYZE',
        'SELECT date_trunc(\'week\', signup_at) …',
        '⤷ Bitmap Heap Scan · 540ms · HOT',
        '⤷ Bitmap Index Scan · 80ms',
      ],
    },
  },
  {
    time: '08:35',
    title: 'apply — index suggested',
    body: 'CREATE INDEX CONCURRENTLY arrives prefilled, in a preview pane. Nothing runs without your hand on the trigger.',
    snippet: {
      kind: 'sql',
      lines: [
        '-- preview · pending your approval',
        'CREATE INDEX CONCURRENTLY',
        '  events_signup_idx',
        '  ON events (signup_at) INCLUDE (user_id);',
      ],
    },
  },
  {
    time: '08:36',
    title: 'green — re-run',
    body: '1.24 s → 38 ms. The cohort dashboard your PM was waiting on is now warm. You close the laptop. Plasma stays warm too.',
    snippet: {
      kind: 'done',
      lines: [
        're-run · 38 ms · 32× faster',
        'index · live · 4.1 MB',
        'dashboard · responsive · ✓',
      ],
    },
  },
];

const SNIPPET_COLORS: Record<Beat['snippet']['kind'], string> = {
  shell: 'text-fg',
  sql: 'text-plasma',
  ai: 'text-volt',
  done: 'text-plasma',
};

const SNIPPET_LABELS: Record<Beat['snippet']['kind'], string> = {
  shell: '$ shell',
  sql: '◇ sql',
  ai: '☼ ai · tool use',
  done: '✓ done',
};

/**
 * Day In The Life — six pinned-scroll panels that snap through one
 * morning with Plasma. Left rail is the timeline; right column scrolls
 * a stack of timestamped scenes. The active beat lights up as you scroll.
 */
export function Day() {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const beats = root.current?.querySelectorAll<HTMLElement>('.beat-card');
      const dots = root.current?.querySelectorAll<HTMLElement>('.beat-dot');
      if (!beats || !dots) return;

      beats.forEach((b, i) => {
        ScrollTrigger.create({
          trigger: b,
          start: 'top 60%',
          end: 'bottom 40%',
          onEnter: () => dots[i]?.classList.add('on'),
          onLeave: () => dots[i]?.classList.remove('on'),
          onEnterBack: () => dots[i]?.classList.add('on'),
          onLeaveBack: () => dots[i]?.classList.remove('on'),
        });
      });

      return () => ScrollTrigger.getAll().forEach((s) => s.kill());
    },
    { scope: root },
  );

  return (
    <section
      id="day"
      ref={root}
      className="relative px-4 md:px-8 py-[14vh] border-b border-line-strong"
    >
      <style>{`
        .beat-dot { transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
        .beat-dot.on {
          background: var(--plasma);
          box-shadow: 0 0 16px var(--plasma);
          transform: scale(1.6);
        }
        .beat-dot.on + .beat-time { color: var(--fg); }
      `}</style>

      <div className="mx-auto max-w-[1440px]">
        <Reveal>
          <div className="grid grid-cols-12 gap-6 mb-16 items-end">
            <div className="col-span-12 md:col-span-9">
              <div className="sec-no mb-5">¶ 05 — A morning</div>
              <div
                className="font-display flex items-baseline gap-3 md:gap-6 leading-[0.86] tracking-[-0.055em] tabular-nums"
                style={{
                  fontSize: 'clamp(64px, 11vw, 200px)',
                  fontVariationSettings: '"opsz" 96, "wdth" 200, "wght" 800',
                }}
              >
                <span className="text-fg">08:30</span>
                <span className="text-plasma glow-plasma">→</span>
                <span className="text-fg">08:36</span>
              </div>
              <h2
                className="mt-4 font-display text-fg/85 leading-[1.1] tracking-[-0.02em]"
                style={{
                  fontSize: 'clamp(20px, 2.4vw, 32px)',
                  fontVariationSettings: '"opsz" 36, "wdth" 100, "wght" 500',
                }}
              >
                One Tuesday. One real bug.{' '}
                <span className="text-plasma">Six minutes.</span>
              </h2>
              <p className="mt-4 text-fg/70 max-w-[60ch] font-sans text-[16px] leading-relaxed">
                Not a feature tour — a Tuesday. Scroll through one engineer&apos;s
                first six minutes with Plasma, in the time it takes to open
                a coffee.
              </p>
            </div>
            <div className="col-span-12 md:col-span-3 self-end label">
              ↓ scroll · 6 beats <br />
              real keystrokes <br />
              real wall-clock time
            </div>
          </div>
        </Reveal>

        <div className="grid grid-cols-12 gap-6">
          {/* Sticky timeline rail */}
          <aside className="hidden md:block md:col-span-2 lg:col-span-2">
            <div className="sticky top-32 space-y-7 pl-2">
              <div className="label mb-4">timeline</div>
              {BEATS.map((b, i) => (
                <div
                  key={b.time}
                  className="flex items-center gap-3 relative"
                >
                  <span
                    className="beat-dot block h-1.5 w-1.5 rounded-full bg-faint"
                    aria-hidden
                  />
                  <span className="beat-time label tabular-nums transition-colors">
                    {b.time}
                  </span>
                </div>
              ))}
            </div>
          </aside>

          {/* Beat cards */}
          <div className="col-span-12 md:col-span-10 space-y-10 md:space-y-16">
            {BEATS.map((b, i) => (
              <article
                key={b.time}
                className="beat-card grid grid-cols-12 gap-4 items-start"
              >
                <div className="col-span-2 md:col-span-1">
                  <div
                    className="font-display text-plasma label-plasma label tabular-nums"
                    style={{
                      fontSize: 'clamp(14px, 1.4vw, 18px)',
                      fontVariationSettings: '"wght" 600',
                    }}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </div>
                </div>
                <div className="col-span-10 md:col-span-5">
                  <div className="label mb-2 md:hidden">{b.time}</div>
                  <h3
                    className="font-display leading-[1.05] tracking-[-0.03em] text-fg"
                    style={{
                      fontSize: 'clamp(26px, 3vw, 44px)',
                      fontVariationSettings:
                        '"opsz" 36, "wdth" 100, "wght" 600',
                    }}
                  >
                    {b.title}
                  </h3>
                  <p className="mt-3 text-fg/70 font-sans text-[15px] leading-[1.65] max-w-[44ch]">
                    {b.body}
                  </p>
                </div>
                <div className="col-span-12 md:col-span-6">
                  <div className="bracket bracket-plasma bg-bg-2 border border-line">
                    <span className="bracket-bl" />
                    <span className="bracket-br" />
                    <div className="px-4 py-2 border-b border-line label flex items-center justify-between">
                      <span className="label-strong">
                        {SNIPPET_LABELS[b.snippet.kind]}
                      </span>
                      <span className="tabular-nums">{b.time}</span>
                    </div>
                    <pre
                      className={`px-5 py-4 font-mono text-[12.5px] leading-[1.85] whitespace-pre-wrap ${SNIPPET_COLORS[b.snippet.kind]}`}
                    >
                      {b.snippet.lines.join('\n')}
                    </pre>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>

        <Reveal as="div" className="mt-16 flex items-baseline justify-between label">
          <span>
            <span className="label-plasma">end · </span>
            same morning · still warm coffee
          </span>
          <span>06 / 06 beats</span>
        </Reveal>
      </div>
    </section>
  );
}
