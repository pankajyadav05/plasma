'use client';

import { useState } from 'react';
import { Reveal } from '@/components/reveal';
import { MOCK_THEMES, type MockTheme } from '@/lib/themes';

/**
 * The whole section IS the live preview. A row of nine theme buttons
 * across the top. Below: a wide editor mock that retints in real time
 * as you hover or click. No 3×3 grid of mini-mocks — just one big mock
 * that breathes with the chosen theme.
 */
export function Atlas() {
  const [pinned, setPinned] = useState<string>('paper');
  const [hovered, setHovered] = useState<string | null>(null);
  const focus = hovered ?? pinned;
  const t = MOCK_THEMES.find((x) => x.id === focus) ?? MOCK_THEMES[0];

  return (
    <section id="atlas" className="relative px-6 md:px-10 py-[14vh] border-b border-line">
      <div className="mx-auto max-w-[1440px]">
        <Reveal>
          <div className="grid grid-cols-12 gap-6 mb-12 items-end">
            <div className="col-span-12 md:col-span-9">
              <div className="sec-no mb-6">¶ 03 — Theme atlas</div>
              <h2
                className="font-display italic leading-[0.95] tracking-[-0.03em]"
                style={{
                  fontSize: 'clamp(48px, 8vw, 144px)',
                  fontVariationSettings: '"opsz" 144, "SOFT" 100, "WONK" 1',
                }}
              >
                Nine rooms. <span className="not-italic text-ox">Same calm.</span>
              </h2>
            </div>
            <div className="col-span-12 md:col-span-3 font-mono text-[11px] uppercase tracking-[0.3em] text-dim self-end">
              now showing · <span className="text-fg">{t.name}</span>
            </div>
          </div>
        </Reveal>

        {/* Theme switcher row */}
        <div className="flex flex-wrap gap-2 mb-10">
          {MOCK_THEMES.map((tm) => (
            <button
              type="button"
              key={tm.id}
              data-cursor={tm.name.toLowerCase()}
              onMouseEnter={() => setHovered(tm.id)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(tm.id)}
              onBlur={() => setHovered(null)}
              onClick={() => setPinned(tm.id)}
              className={`group inline-flex items-center gap-3 px-3 py-2 border transition-all ${
                pinned === tm.id ? 'border-ox text-fg' : 'border-line text-dim hover:border-fg hover:text-fg'
              }`}
              aria-pressed={pinned === tm.id}
            >
              <span className="inline-flex gap-[2px]">
                {tm.swatch.map((s, i) => (
                  <span
                    key={i}
                    className="block h-3.5 w-3.5 ring-1 ring-black/20"
                    style={{ background: s }}
                  />
                ))}
              </span>
              <span className="font-mono text-[11px] uppercase tracking-[0.22em]">{tm.name}</span>
            </button>
          ))}
        </div>

        {/* Live mock that retints */}
        <ThemedMock theme={t} />
      </div>
    </section>
  );
}

function ThemedMock({ theme }: { theme: MockTheme }) {
  return (
    <div
      className="relative grid grid-cols-12 border overflow-hidden transition-colors duration-500"
      style={{
        background: theme.bg,
        color: theme.fg,
        borderColor: theme.swatch[1],
        boxShadow: '0 30px 80px -40px rgba(0,0,0,0.55)',
      }}
    >
      <div
        className="col-span-12 flex items-center gap-2 px-4 py-3 border-b transition-colors duration-500"
        style={{ borderColor: theme.swatch[1] }}
      >
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: theme.ox }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: theme.fg, opacity: 0.2 }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: theme.fg, opacity: 0.2 }} />
        <span className="ml-3 font-mono text-[11px]" style={{ opacity: 0.55 }}>
          plasma · prod-replica · {theme.id}.theme
        </span>
      </div>

      <aside
        className="col-span-3 md:col-span-2 p-4 border-r font-mono text-[11px] leading-7"
        style={{ borderColor: theme.swatch[1], color: theme.fg, opacity: 0.85 }}
      >
        <div style={{ opacity: 1 }}>▾ public</div>
        <div className="pl-4">orders</div>
        <div className="pl-4">customers</div>
        <div className="pl-4" style={{ color: theme.ox }}>order_items*</div>
      </aside>

      <main className="col-span-9 md:col-span-10 p-5 md:p-6 font-mono text-[13px] leading-[1.75]">
        <div>
          <span style={{ color: theme.ox }}>SELECT</span> o.id, c.name,
        </div>
        <div className="pl-8">
          <span style={{ color: theme.ox }}>SUM</span>(oi.qty * oi.unit_price) <span style={{ color: theme.ox }}>AS</span> total
        </div>
        <div>
          <span style={{ color: theme.ox }}>FROM</span> orders o <span style={{ color: theme.ox }}>JOIN</span> customers c <span style={{ color: theme.ox }}>ON</span> c.id = o.customer_id
        </div>
        <div>
          <span style={{ color: theme.ox }}>WHERE</span> o.created_at &gt; <span style={{ opacity: 0.7 }}>now()</span> - <span style={{ opacity: 0.7 }}>interval '7 days'</span>;
        </div>
        <div className="mt-5 grid grid-cols-4 gap-px text-[12px]" style={{ background: theme.swatch[1] }}>
          {['id', 'customer', 'items', 'total'].map((h) => (
            <div key={h} className="p-2" style={{ background: theme.bg, opacity: 0.6 }}>
              {h}
            </div>
          ))}
          {[
            ['10241', 'Acme Co.', '8', '$ 12,480.00'],
            ['10240', 'Globex', '5', '$ 9,210.50'],
          ].map((row) => (
            <div key={row[0]} className="contents">
              {row.map((cell, i) => (
                <div
                  key={i}
                  className="p-2"
                  style={{ background: theme.bg, color: i === 3 ? theme.ox : theme.fg }}
                >
                  {cell}
                </div>
              ))}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
