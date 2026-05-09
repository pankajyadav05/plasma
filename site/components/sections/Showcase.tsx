'use client';

import { useRef, useState } from 'react';
import { InstrumentFrame } from '@/components/instrument-frame';
import { Reveal } from '@/components/reveal';
import { gsap, ScrollTrigger, useGSAP } from '@/lib/gsap';

type EngineId = 'postgres' | 'redis' | 'opensearch';

interface EngineSnap {
  id: EngineId;
  name: string;
  port: string;
  badge: string;
  prompt: string;
  lines: { tok?: string; text: string; cls?: string }[];
  result: string[][];
  resultHead: string[];
  ai: { tools: [string, string][]; quote: string; cta: string };
}

const ENGINES: EngineSnap[] = [
  {
    id: 'postgres',
    name: 'Postgres',
    port: ':5432',
    badge: 'prod-replica · pg-16',
    prompt: 'plasma › prod-replica › scratch.sql',
    lines: [
      { text: '-- weekly revenue · top customers', cls: 'text-dim' },
      {
        text: 'SELECT o.id, c.name,',
        cls: '',
      },
      { text: '       SUM(oi.qty * oi.unit_price) AS total', cls: '' },
      { text: 'FROM orders o', cls: '' },
      { text: 'JOIN customers c ON c.id = o.customer_id', cls: '' },
      { text: 'JOIN order_items oi ON oi.order_id = o.id', cls: '' },
      { text: "WHERE o.created_at > now() - interval '7 days'", cls: '' },
      { text: 'GROUP BY o.id, c.name', cls: '' },
      { text: 'ORDER BY total DESC LIMIT 25;', cls: '' },
    ],
    resultHead: ['id', 'customer', 'items', 'total'],
    result: [
      ['10241', 'Acme Co.', '8', '$ 12,480.00'],
      ['10240', 'Globex', '5', '$ 9,210.50'],
      ['10239', 'Initech', '3', '$ 5,780.00'],
      ['10238', 'Umbrella', '11', '$ 18,300.00'],
    ],
    ai: {
      tools: [
        ['list_tables', 'public · analytics'],
        ['describe', 'orders · customers · order_items'],
        ['suggest_index', 'btree(orders.created_at)'],
      ],
      quote:
        'Add an index on orders.created_at. Drops the 7-day query 525 ms → 38 ms.',
      cta: 'Apply suggestion',
    },
  },
  {
    id: 'redis',
    name: 'Redis',
    port: ':6379',
    badge: 'cache · redis-7',
    prompt: 'plasma › cache › ad-hoc.cli',
    lines: [
      { text: '> KEYS user:session:*', cls: '' },
      { text: '1) "user:session:7341"', cls: 'text-dim' },
      { text: '2) "user:session:8112"', cls: 'text-dim' },
      { text: '3) "user:session:9024"', cls: 'text-dim' },
      { text: '> TTL user:session:7341', cls: '' },
      { text: '(integer) 28800', cls: 'text-volt' },
      { text: '> HGETALL user:session:7341', cls: '' },
      { text: '"uid" "u_4421"  "ip" "10.0.4.18"', cls: 'text-dim' },
      { text: '"role" "admin"  "csrf" "8a…ce"', cls: 'text-dim' },
    ],
    resultHead: ['key', 'type', 'ttl', 'mem'],
    result: [
      ['user:session:7341', 'hash', '8h 0m', '312 B'],
      ['user:session:8112', 'hash', '7h 12m', '298 B'],
      ['cart:9024', 'list', '∞', '4.1 KB'],
      ['rate:limit:ip', 'string', '60 s', '12 B'],
    ],
    ai: {
      tools: [
        ['scan', 'pattern user:session:*'],
        ['type', 'hash · list · string'],
        ['memory_usage', 'p95 · 1.2 KB / key'],
      ],
      quote:
        'You have 4,210 sessions. Move ip + csrf to a hash subset; saves 38% memory.',
      cta: 'Refactor schema',
    },
  },
  {
    id: 'opensearch',
    name: 'OpenSearch',
    port: ':9200',
    badge: 'logs · os-2.13',
    prompt: 'plasma › logs › discover.dsl',
    lines: [
      { text: 'GET logs-app-*/_search', cls: '' },
      { text: '{ "query": {', cls: '' },
      {
        text: '  "bool": { "must": [',
        cls: '',
      },
      {
        text: '    { "match": { "level": "error" } },',
        cls: '',
      },
      {
        text: '    { "range": { "@timestamp":',
        cls: '',
      },
      {
        text: '      { "gte": "now-15m" } } }',
        cls: '',
      },
      {
        text: '  ] } }, "size": 50 }',
        cls: '',
      },
    ],
    resultHead: ['ts', 'svc', 'msg', 'lvl'],
    result: [
      ['12:42:01', 'auth', 'token verify failed', 'ERR'],
      ['12:42:00', 'pay', 'stripe 5xx · retried', 'WRN'],
      ['12:41:58', 'auth', 'token verify failed', 'ERR'],
      ['12:41:55', 'mail', 'queue depth high', 'WRN'],
    ],
    ai: {
      tools: [
        ['list_indices', 'logs-app-* · 18 GB'],
        ['mapping', 'level · @timestamp · svc'],
        ['agg', 'level by 1m'],
      ],
      quote:
        '17 errors in 15m, all from auth. Same trace_id. One token-issuer regression — 12:39 Z.',
      cta: 'Open trace',
    },
  },
];

/**
 * The Bench: single instrument with three engine tabs. The mock retints +
 * rewires per engine. Tilts up into focus on scroll like a watch advert.
 */
export function Showcase() {
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<EngineId>('postgres');
  const eng = ENGINES.find((e) => e.id === active) ?? ENGINES[0];

  useGSAP(
    () => {
      const card = root.current?.querySelector<HTMLElement>('.show-card');
      if (!card) return;
      gsap.fromTo(
        card,
        { rotateX: 18, rotateY: -6, scale: 0.9, y: 60 },
        {
          rotateX: 0,
          rotateY: 0,
          scale: 1,
          y: 0,
          ease: 'none',
          scrollTrigger: {
            trigger: card,
            start: 'top 78%',
            end: 'top 22%',
            scrub: 0.6,
          },
        },
      );
      return () => ScrollTrigger.getAll().forEach((s) => s.kill());
    },
    { scope: root },
  );

  return (
    <section
      id="bench"
      ref={root}
      className="relative px-4 md:px-8 py-[18vh] border-b border-line-strong overflow-hidden lab-grid"
    >
      <div className="mx-auto max-w-[1440px]">
        <Reveal>
          <div className="grid grid-cols-12 gap-6 mb-14 items-end">
            <div className="col-span-12 md:col-span-9">
              <div className="sec-no mb-5">¶ 03 — The Bench</div>
              <h2
                className="font-display leading-[0.92] tracking-[-0.04em]"
                style={{
                  fontSize: 'clamp(40px, 7vw, 120px)',
                  fontVariationSettings: '"opsz" 96, "wdth" 100, "wght" 700',
                }}
              >
                One panel.{' '}
                <span className="text-plasma">Three signals.</span>
              </h2>
              <p className="mt-4 text-fg/70 max-w-[60ch] font-sans text-[16px] leading-relaxed">
                Tab between Postgres, Redis &amp; OpenSearch — Plasma rewires
                its editor, lints, and the AI's tools to whichever engine you
                point it at. No mode switch. No second app.
              </p>
            </div>
            <div className="col-span-12 md:col-span-3 self-end label">
              schema-aware autocomplete <br />
              explain tree <br />
              ai with engine-aware tool use
            </div>
          </div>
        </Reveal>

        {/* Engine tab strip */}
        <div className="flex flex-wrap gap-px bg-line-strong border border-line-strong mb-px">
          {ENGINES.map((e) => {
            const isActive = e.id === active;
            return (
              <button
                key={e.id}
                type="button"
                data-cursor={`engine · ${e.name.toLowerCase()}`}
                onClick={() => setActive(e.id)}
                className={`flex-1 min-w-[200px] flex items-center justify-between gap-3 px-5 py-4 transition-colors ${
                  isActive
                    ? 'bg-bg-2 text-fg'
                    : 'bg-bg text-dim hover:text-fg'
                }`}
                aria-pressed={isActive}
              >
                <span className="flex items-center gap-3">
                  <span
                    className={`block h-2 w-2 rounded-full transition-shadow ${
                      isActive
                        ? 'bg-plasma shadow-[0_0_10px_var(--plasma)]'
                        : 'bg-faint'
                    }`}
                  />
                  <span
                    className="font-display text-[20px]"
                    style={{
                      fontVariationSettings:
                        '"opsz" 36, "wdth" 100, "wght" 700',
                    }}
                  >
                    {e.name.toLowerCase()}
                  </span>
                </span>
                <span className="label">{e.port}</span>
              </button>
            );
          })}
        </div>

        <div style={{ perspective: '1800px' }}>
          <div
            className="show-card relative bg-bg-2 border border-line-strong overflow-hidden will-change-transform"
            style={{
              boxShadow:
                '0 60px 120px -50px rgba(0, 240, 208, 0.25), 0 30px 60px -30px rgba(0,0,0,0.5)',
            }}
          >
            <Chrome eng={eng} />
            <div className="grid grid-cols-12">
              <Sidebar eng={eng} />
              <Editor eng={eng} />
              <AiRail eng={eng} />
            </div>
            <Statusbar eng={eng} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Chrome({ eng }: { eng: EngineSnap }) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
      <span className="h-3 w-3 rounded-full bg-ox" />
      <span className="h-3 w-3 rounded-full bg-faint" />
      <span className="h-3 w-3 rounded-full bg-faint" />
      <span className="ml-4 label">{eng.prompt}</span>
      <span className="ml-auto inline-flex items-center gap-2 label">
        <span className="block h-1.5 w-1.5 rounded-full bg-plasma shadow-[0_0_8px_var(--plasma)]" />
        <span className="label-plasma">{eng.badge}</span>
        <span className="hidden md:inline">/ 2.1 ms rtt</span>
      </span>
    </div>
  );
}

function Sidebar({ eng }: { eng: EngineSnap }) {
  const trees: Record<EngineId, [string, string?][]> = {
    postgres: [
      ['▾ public'],
      ['  orders'],
      ['  customers'],
      ['  order_items*', 'plasma'],
      ['  products'],
      ['▾ analytics'],
      ['  events'],
      ['  cohorts'],
      ['▸ stripe'],
      ['▸ pgvector'],
    ],
    redis: [
      ['▾ db 0'],
      ['  user:session:*  4,210', 'plasma'],
      ['  cart:*           812'],
      ['  rate:*       18,402'],
      ['  feed:hot*       40'],
      ['▸ db 1'],
      ['▸ pubsub'],
      ['  channels        12'],
      ['▸ keyspace'],
    ],
    opensearch: [
      ['▾ logs-*'],
      ['  logs-app-2026.05.09  18 GB', 'plasma'],
      ['  logs-app-2026.05.08'],
      ['  logs-edge-2026.05.09'],
      ['▾ traces-*'],
      ['  traces-2026.05.09'],
      ['▸ metrics-*'],
      ['▸ ilm-policies'],
      ['▸ pipelines'],
    ],
  };
  return (
    <aside className="col-span-12 md:col-span-2 p-4 border-r border-line font-mono text-[12px] leading-7">
      <div className="label label-strong mb-3">{eng.name}</div>
      {trees[eng.id].map(([label, color], i) => (
        <div
          key={i}
          className={
            color === 'plasma'
              ? 'text-plasma'
              : label.startsWith('▾') || label.startsWith('▸')
                ? 'text-fg'
                : 'text-dim'
          }
        >
          {label}
        </div>
      ))}
    </aside>
  );
}

function Editor({ eng }: { eng: EngineSnap }) {
  return (
    <main className="col-span-12 md:col-span-7 p-6 relative">
      <pre className="font-mono text-[13px] leading-7 text-fg/90 whitespace-pre-wrap">
        {eng.lines.map((l, i) => (
          <div key={i} className={l.cls ?? ''}>
            {colorize(l.text)}
          </div>
        ))}
        <span className="caret" />
      </pre>

      <div className="mt-6 grid grid-cols-4 gap-px bg-line border border-line text-[12px]">
        {eng.resultHead.map((h) => (
          <div
            key={h}
            className="bg-bg p-2 font-mono text-dim uppercase tracking-widest text-[10px]"
          >
            {h}
          </div>
        ))}
        {eng.result.map((row, ri) => (
          <div key={ri} className="contents">
            {row.map((cell, i) => (
              <div
                key={i}
                className={`bg-bg p-2 font-mono ${
                  i === row.length - 1 ? 'text-plasma' : 'text-fg'
                }`}
              >
                {cell}
              </div>
            ))}
          </div>
        ))}
      </div>
    </main>
  );
}

function AiRail({ eng }: { eng: EngineSnap }) {
  return (
    <aside className="col-span-12 md:col-span-3 p-5 border-l border-line">
      <div className="label mb-3 flex items-center gap-2">
        <span className="block h-1.5 w-1.5 rounded-full bg-volt shadow-[0_0_8px_var(--volt)]" />
        <span className="label-strong">ai · tool use</span>
      </div>
      <ul className="space-y-2.5 font-mono text-[12px]">
        {eng.ai.tools.map(([k, v]) => (
          <li key={k} className="flex items-baseline gap-3">
            <span className="block h-1.5 w-1.5 rounded-full bg-plasma shrink-0" />
            <span className="text-fg">{k}</span>
            <span className="text-dim truncate">{v}</span>
          </li>
        ))}
      </ul>
      <div className="mt-5 text-[12px] text-fg leading-[1.55] border-l border-plasma pl-3">
        <span className="text-plasma">→ </span>
        {eng.ai.quote}
      </div>
      <button
        type="button"
        data-cursor="apply"
        className="mt-5 w-full inline-flex items-center justify-between px-3 py-2 bg-plasma text-bg font-mono text-[10px] uppercase tracking-[0.3em] hover:bg-volt transition-colors"
      >
        {eng.ai.cta} <span className="opacity-60">⏎</span>
      </button>
    </aside>
  );
}

function Statusbar({ eng }: { eng: EngineSnap }) {
  const stat: Record<EngineId, string> = {
    postgres: '525 ms · 25 rows · index scan',
    redis: '0.4 ms · 4 keys · O(N) scan',
    opensearch: '38 ms · 50 hits · 1 shard',
  };
  return (
    <div className="flex items-center justify-between px-4 py-2 border-t border-line label">
      <span>idle · 2 unsaved · 4 tabs</span>
      <span className="hidden md:inline">
        {eng.name} · {eng.port} · pankaj@example.com
      </span>
      <span className="label-plasma">{stat[eng.id]}</span>
    </div>
  );
}

const KEYWORDS = [
  'SELECT',
  'FROM',
  'JOIN',
  'WHERE',
  'GROUP BY',
  'ORDER BY',
  'LIMIT',
  'SUM',
  'AS',
  'ON',
  'GET',
  'KEYS',
  'TTL',
  'HGETALL',
  'now()',
  "interval '7 days'",
];
function colorize(text: string) {
  let parts: (string | { kw: string })[] = [text];
  for (const kw of KEYWORDS) {
    parts = parts.flatMap((p) => {
      if (typeof p !== 'string') return [p];
      const out: (string | { kw: string })[] = [];
      let s = p;
      while (true) {
        const i = s.indexOf(kw);
        if (i === -1) {
          out.push(s);
          break;
        }
        if (i > 0) out.push(s.slice(0, i));
        out.push({ kw });
        s = s.slice(i + kw.length);
      }
      return out;
    });
  }
  return parts.map((p, i) =>
    typeof p === 'string' ? (
      <span key={i}>{p}</span>
    ) : (
      <span key={i} className="text-plasma">
        {p.kw}
      </span>
    ),
  );
}
