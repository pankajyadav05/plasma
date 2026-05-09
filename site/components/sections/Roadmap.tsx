'use client';

import { Reveal } from '@/components/reveal';

type Status = 'now' | 'next' | 'maybe' | 'done';

interface Item {
  status: Status;
  title: string;
  body: string;
  ref?: string; // GH issue
  eta?: string;
  pulse?: boolean;
}

const ITEMS: Item[] = [
  // NOW
  {
    status: 'now',
    title: 'macOS build',
    body: 'Universal2 dmg, signed + notarized. Same Tauri shell, same theme files.',
    ref: '#42',
    eta: 'q3·2026',
    pulse: true,
  },
  {
    status: 'now',
    title: 'EXPLAIN tree polish',
    body: 'Hot-path heatmap, copy-as-text, share-as-link.',
    ref: '#58',
    eta: 'q3·2026',
    pulse: true,
  },
  {
    status: 'now',
    title: 'Multi-tab pin sync',
    body: 'Per-connection pinned tabs sync across machines via local file or your own gist.',
    ref: '#67',
    eta: 'q3·2026',
  },

  // NEXT
  {
    status: 'next',
    title: 'Linux build',
    body: 'AppImage + deb + rpm. AUR maintained by community.',
    ref: '#43',
    eta: 'q4·2026',
  },
  {
    status: 'next',
    title: 'Vector schema-aware AI',
    body: 'pgvector + chroma + lance — AI that understands your embeddings, not just your tables.',
    ref: '#71',
    eta: 'q4·2026',
  },
  {
    status: 'next',
    title: 'Saved query library',
    body: 'Per-connection scratchpad of queries with notes. Optional sync.',
    ref: '#73',
  },

  // MAYBE
  {
    status: 'maybe',
    title: 'MongoDB · MySQL · Clickhouse',
    body: 'Each adds a test matrix and a parser. Will follow real demand.',
    ref: '#80',
  },
  {
    status: 'maybe',
    title: 'Web build (read-only)',
    body: 'Browser-based viewer for shared queries / EXPLAIN snapshots. Read-only by design.',
    ref: '#82',
  },
  {
    status: 'maybe',
    title: 'Local agent (loopback only)',
    body: 'Background watcher for slow queries. Off by default; runs only on localhost.',
    ref: '#85',
  },

  // DONE
  {
    status: 'done',
    title: 'Postgres + Redis + OpenSearch',
    body: 'Three engines, one binary. Schema-aware autocomplete, EXPLAIN, AI tool use.',
    ref: 'v0.0.10',
  },
  {
    status: 'done',
    title: 'Nine editorial themes',
    body: 'Paper, Ink, Rosewood, Glacier, Meadow, Amber, Plum, Newsprint, Bone.',
    ref: 'v0.0.12',
  },
  {
    status: 'done',
    title: 'Create + delete index from UI',
    body: 'OpenSearch admin actions surfaced with safe confirmations.',
    ref: 'v0.0.14',
  },
];

const COLUMNS: { id: Status; label: string; color: string; dot: string }[] = [
  {
    id: 'now',
    label: 'NOW',
    color: 'text-plasma',
    dot: 'bg-plasma shadow-[0_0_10px_var(--plasma)]',
  },
  {
    id: 'next',
    label: 'NEXT',
    color: 'text-volt',
    dot: 'bg-volt shadow-[0_0_10px_var(--volt)]',
  },
  { id: 'maybe', label: 'MAYBE', color: 'text-fg', dot: 'bg-fg' },
  { id: 'done', label: 'DONE', color: 'text-dim', dot: 'bg-faint' },
];

/**
 * Roadmap Lighthouse — four columns, real items, GitHub-linked.
 * Asymmetric stagger; pulse dot on NOW items. No marketing speak.
 */
export function Roadmap() {
  return (
    <section
      id="roadmap"
      className="relative px-4 md:px-8 py-[14vh] border-b border-line-strong"
    >
      <div className="mx-auto max-w-[1440px]">
        <Reveal>
          <div className="grid grid-cols-12 gap-6 mb-12 items-end">
            <div className="col-span-12 md:col-span-9">
              <div className="sec-no mb-5">¶ 11 — Roadmap lighthouse</div>
              <h2
                className="font-display leading-[0.92] tracking-[-0.04em]"
                style={{
                  fontSize: 'clamp(40px, 7vw, 120px)',
                  fontVariationSettings: '"opsz" 96, "wdth" 100, "wght" 700',
                }}
              >
                What&apos;s on the bench{' '}
                <span className="text-plasma">right now</span>.
              </h2>
              <p className="mt-4 text-fg/70 max-w-[60ch] font-sans text-[16px] leading-relaxed">
                A real roadmap, not a wishlist. Tap an item to read the issue
                that scoped it. Anything in <span className="text-fg">Maybe</span>{' '}
                will move only if you tell us it should.
              </p>
            </div>
            <div className="col-span-12 md:col-span-3 self-end label">
              source · github / plasma <br />
              cadence · two-week ships <br />
              snapshot · 2026·05·09
            </div>
          </div>
        </Reveal>

        {/* Header rail */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-px border-y border-line-strong">
          {COLUMNS.map((c) => {
            const count = ITEMS.filter((i) => i.status === c.id).length;
            return (
              <div
                key={c.id}
                className="bg-bg p-5 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <span className={`block h-2 w-2 rounded-full ${c.dot}`} />
                  <span className={`label label-strong ${c.color}`}>
                    {c.label}
                  </span>
                </div>
                <span className="label tabular-nums">
                  {String(count).padStart(2, '0')}
                </span>
              </div>
            );
          })}
        </div>

        {/* Columns */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-px bg-line-strong border-x border-b border-line-strong">
          {COLUMNS.map((c) => {
            const items = ITEMS.filter((i) => i.status === c.id);
            return (
              <div key={c.id} className="bg-bg p-5 space-y-3">
                {items.map((item, i) => (
                  <Reveal
                    key={item.title}
                    delay={i * 80}
                    as="article"
                    className={`p-4 border transition-all hover:bg-bg-2 group ${
                      c.id === 'now'
                        ? 'border-plasma/30 hover:border-plasma'
                        : c.id === 'done'
                          ? 'border-line opacity-65 hover:opacity-100'
                          : 'border-line hover:border-line-strong'
                    } ${i % 3 === 1 ? 'md:translate-y-2' : i % 3 === 2 ? 'md:translate-y-4' : ''}`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`block h-1.5 w-1.5 rounded-full ${c.dot} ${
                            item.pulse ? 'animate-pulse' : ''
                          }`}
                        />
                        <span className={`label ${c.color}`}>{c.label}</span>
                      </div>
                      {item.ref && (
                        <span className="label tabular-nums text-faint group-hover:text-fg transition-colors">
                          {item.ref}
                        </span>
                      )}
                    </div>
                    <h3
                      className={`font-display leading-tight tracking-[-0.025em] ${
                        c.id === 'done' ? 'text-fg/80' : 'text-fg'
                      }`}
                      style={{
                        fontSize: 'clamp(17px, 1.6vw, 22px)',
                        fontVariationSettings:
                          '"opsz" 36, "wdth" 100, "wght" 600',
                      }}
                    >
                      {item.title}
                    </h3>
                    <p className="mt-2 text-fg/65 font-sans text-[13px] leading-[1.55]">
                      {item.body}
                    </p>
                    {item.eta && (
                      <div className="mt-3 label tabular-nums">
                        eta · {item.eta}
                      </div>
                    )}
                  </Reveal>
                ))}
              </div>
            );
          })}
        </div>

        <Reveal as="div" className="mt-8 flex items-baseline justify-between label">
          <span>
            <span className="label-plasma">↗ </span>
            push an idea · github.com/plasma/discussions
          </span>
          <span>{ITEMS.length} items tracked</span>
        </Reveal>
      </div>
    </section>
  );
}
