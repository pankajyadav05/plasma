'use client';

import { useRef } from 'react';
import { Reveal } from '@/components/reveal';
import { gsap, ScrollTrigger, useGSAP } from '@/lib/gsap';

/**
 * 3D-tilted editor showcase. The mock window enters at a steep 22°
 * tilt + scaled down + dim, then ScrollTrigger scrubs it upright + full
 * brightness as it crosses the viewport center. Reads like a watch
 * advert — one object, beautifully lit, slowly turning into focus.
 */
export function Showcase() {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const card = root.current?.querySelector<HTMLElement>('.show-card');
      if (!card) return;
      gsap.fromTo(
        card,
        { rotateX: 22, rotateY: -8, scale: 0.85, y: 80 },
        {
          rotateX: 0,
          rotateY: 0,
          scale: 1,
          y: 0,
          ease: 'none',
          scrollTrigger: {
            trigger: card,
            start: 'top 78%',
            end: 'top 20%',
            scrub: 0.6,
          },
        },
      );
      return () => ScrollTrigger.getAll().forEach((s) => s.kill());
    },
    { scope: root },
  );

  return (
    <section id="showcase" ref={root} className="relative px-6 md:px-10 py-[18vh] border-b border-line overflow-hidden">
      <div className="mx-auto max-w-[1440px]">
        <Reveal>
          <div className="grid grid-cols-12 gap-6 mb-16 items-end">
            <div className="col-span-12 md:col-span-9">
              <div className="sec-no mb-6">¶ 02 — The editor</div>
              <h2
                className="font-display italic leading-[0.95] tracking-[-0.03em]"
                style={{
                  fontSize: 'clamp(48px, 8vw, 144px)',
                  fontVariationSettings: '"opsz" 144, "SOFT" 100, "WONK" 1',
                }}
              >
                A surface so calm it <span className="not-italic text-ox">disappears</span>.
              </h2>
            </div>
            <div className="col-span-12 md:col-span-3 self-end font-mono text-[11px] uppercase tracking-[0.3em] text-dim">
              schema-aware autocomplete · explain tree · ai with tool use
            </div>
          </div>
        </Reveal>

        <div style={{ perspective: '1800px' }}>
          <div
            className="show-card relative bg-bg-2 border border-line rounded-md overflow-hidden will-change-transform"
            style={{
              boxShadow:
                '0 60px 120px -50px rgba(255, 87, 51, 0.35), 0 30px 60px -30px rgba(0,0,0,0.5)',
            }}
          >
            <Chrome />
            <div className="grid grid-cols-12">
              <Sidebar />
              <Editor />
              <AiRail />
            </div>
            <Statusbar />
          </div>
        </div>
      </div>
    </section>
  );
}

function Chrome() {
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
      <span className="h-3 w-3 rounded-full bg-ox" />
      <span className="h-3 w-3 rounded-full bg-line" />
      <span className="h-3 w-3 rounded-full bg-line" />
      <span className="ml-4 font-mono text-[11px] text-dim">plasma · prod-replica · scratch.sql · 2 unsaved</span>
      <span className="ml-auto inline-flex items-center gap-2 font-mono text-[10px] text-accent">
        <span className="block h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" /> connected · 2.1 ms
      </span>
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="col-span-12 md:col-span-2 p-4 border-r border-line font-mono text-[12px] leading-7 text-dim">
      <div className="text-fg uppercase text-[10px] tracking-widest mb-2">prod-replica</div>
      <div className="text-fg">▾ public</div>
      <div className="pl-4">orders</div>
      <div className="pl-4">customers</div>
      <div className="pl-4 text-ox">order_items*</div>
      <div className="pl-4">products</div>
      <div className="text-fg mt-3">▾ analytics</div>
      <div className="pl-4">events</div>
      <div className="pl-4">cohorts</div>
      <div className="text-fg mt-3">▸ stripe</div>
      <div className="text-fg mt-3">▸ pgvector</div>
    </aside>
  );
}

function Editor() {
  return (
    <main className="col-span-12 md:col-span-7 p-6 relative">
      <pre className="font-mono text-[13px] leading-7 text-fg/90">
        <span className="text-dim">-- weekly revenue, top customers</span>{'\n'}
        <span className="text-ox">SELECT</span> o.id, c.name,
        <br />
        <span className="text-ox">       SUM</span>(oi.qty * oi.unit_price) <span className="text-ox">AS</span> total
        <br />
        <span className="text-ox">FROM</span> orders o
        <br />
        <span className="text-ox">JOIN</span> customers c <span className="text-ox">ON</span> c.id = o.customer_id
        <br />
        <span className="text-ox">JOIN</span> order_items oi <span className="text-ox">ON</span> oi.order_id = o.id
        <br />
        <span className="text-ox">WHERE</span> o.created_at &gt; <span className="text-accent">now()</span> - <span className="text-accent">interval &apos;7 days&apos;</span>
        <br />
        <span className="text-ox">GROUP BY</span> o.id, c.name
        <br />
        <span className="text-ox">ORDER BY</span> total <span className="text-ox">DESC</span> <span className="text-ox">LIMIT</span> 25;<span className="caret" />
      </pre>

      <div className="mt-6 grid grid-cols-4 gap-px bg-line border border-line text-[12px]">
        {['id', 'customer', 'items', 'total'].map((h) => (
          <div key={h} className="bg-bg p-2 font-mono text-dim uppercase tracking-widest text-[10px]">
            {h}
          </div>
        ))}
        {[
          ['10241', 'Acme Co.', '8', '$ 12,480.00'],
          ['10240', 'Globex', '5', '$ 9,210.50'],
          ['10239', 'Initech', '3', '$ 5,780.00'],
          ['10238', 'Umbrella', '11', '$ 18,300.00'],
        ].map((row) => (
          <div key={row[0]} className="contents">
            {row.map((cell, i) => (
              <div key={i} className={`bg-bg p-2 font-mono ${i === 3 ? 'text-accent' : 'text-fg'}`}>
                {cell}
              </div>
            ))}
          </div>
        ))}
      </div>
    </main>
  );
}

function AiRail() {
  return (
    <aside className="col-span-12 md:col-span-3 p-5 border-l border-line">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-dim mb-3 flex items-center gap-2">
        <span className="block h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />
        ai · tool use
      </div>
      <ul className="space-y-2.5 font-mono text-[12px]">
        {[
          ['list_tables', 'public · analytics'],
          ['describe', 'orders · customers · order_items'],
          ['sample', 'orders LIMIT 5'],
          ['suggest_index', 'btree(orders.created_at)'],
        ].map(([k, v]) => (
          <li key={k} className="flex items-baseline gap-3">
            <span className="block h-1.5 w-1.5 rounded-full bg-ox shrink-0" />
            <span className="text-fg">{k}</span>
            <span className="text-dim truncate">{v}</span>
          </li>
        ))}
      </ul>
      <div className="mt-5 text-[12px] text-fg leading-[1.55] border-l border-ox pl-3">
        <span className="text-ox">→ </span>
        Add an index on <span className="font-mono">orders.created_at</span>. Drops the 7-day query from <span className="text-accent">525 ms</span> to <span className="text-accent">38 ms</span>.
      </div>
      <button
        type="button"
        data-cursor="apply"
        className="mt-5 w-full inline-flex items-center justify-between px-3 py-2 bg-fg text-bg font-mono text-[10px] uppercase tracking-[0.3em] hover:bg-ox"
      >
        Apply suggestion <span className="opacity-60">⏎</span>
      </button>
    </aside>
  );
}

function Statusbar() {
  return (
    <div className="flex items-center justify-between px-4 py-2 border-t border-line font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
      <span>idle · 2 unsaved · 4 tabs</span>
      <span className="hidden md:inline">postgres-16 · prod-replica · pankaj@example.com</span>
      <span>525 ms · 25 rows · index scan</span>
    </div>
  );
}
