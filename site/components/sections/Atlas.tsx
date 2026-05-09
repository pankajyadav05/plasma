'use client';

import { useState } from 'react';
import { InstrumentFrame } from '@/components/instrument-frame';
import { Reveal } from '@/components/reveal';
import { MOCK_THEMES, type MockTheme } from '@/lib/themes';

/**
 * Spectrum: themes laid as a continuous spectrum bar across the section.
 * Hover the bar → a mini terminal mock retints in real time. Click to
 * pin. Reads like a wavelength dial on an instrument.
 */
export function Atlas() {
  const [pinned, setPinned] = useState<string>('paper');
  const [hovered, setHovered] = useState<string | null>(null);
  const focus = hovered ?? pinned;
  const t = MOCK_THEMES.find((x) => x.id === focus) ?? MOCK_THEMES[0];

  return (
    <section
      id="spectrum"
      className="relative px-4 md:px-8 py-[14vh] border-b border-line-strong"
    >
      <div className="mx-auto max-w-[1440px]">
        <Reveal>
          <div className="grid grid-cols-12 gap-6 mb-12 items-end">
            <div className="col-span-12 md:col-span-9">
              <div className="sec-no mb-5">¶ 09 — Theme spectrum</div>
              <h2
                className="font-display leading-[0.92] tracking-[-0.04em]"
                style={{
                  fontSize: 'clamp(40px, 7vw, 120px)',
                  fontVariationSettings: '"opsz" 96, "wdth" 100, "wght" 700',
                }}
              >
                Nine wavelengths.{' '}
                <span className="text-plasma">Same calm.</span>
              </h2>
            </div>
            <div className="col-span-12 md:col-span-3 self-end label">
              <div className="flex items-baseline gap-2">
                <span>now showing ·</span>
                <span className="label-strong text-fg">{t.name}</span>
              </div>
              <div>λ {String(MOCK_THEMES.indexOf(t) + 1).padStart(2, '0')} / 09</div>
            </div>
          </div>
        </Reveal>

        <InstrumentFrame
          index="05·THEME"
          title="spectrum dial"
          meta={`${MOCK_THEMES.length} preset · live retint`}
          accent="plasma"
        >
          <div className="bg-bg-2 p-6 md:p-10">
            {/* Spectrum bar */}
            <div className="mb-2 flex items-end justify-between label">
              <span>↤ paper · warm</span>
              <span>cool · ink ↦</span>
            </div>

            <div
              className="relative h-20 md:h-24 grid grid-flow-col auto-cols-fr border border-line-strong overflow-hidden"
              role="tablist"
            >
              {MOCK_THEMES.map((tm, i) => {
                const isFocus = tm.id === focus;
                const isPinned = tm.id === pinned;
                return (
                  <button
                    key={tm.id}
                    type="button"
                    role="tab"
                    aria-selected={isPinned}
                    data-cursor={tm.name.toLowerCase()}
                    onMouseEnter={() => setHovered(tm.id)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(tm.id)}
                    onBlur={() => setHovered(null)}
                    onClick={() => setPinned(tm.id)}
                    className={`relative h-full overflow-hidden group transition-all ${
                      isFocus ? 'z-10 scale-y-105' : ''
                    }`}
                    style={{
                      background: tm.bg,
                      borderLeft:
                        i === 0 ? 'none' : '1px solid rgba(0,0,0,0.25)',
                    }}
                  >
                    {/* Color stripes — bg, fg, ox */}
                    <div className="absolute inset-x-0 top-0 h-full flex flex-col">
                      <div className="flex-1" style={{ background: tm.bg }} />
                      <div
                        className="h-2"
                        style={{ background: tm.swatch[1] }}
                      />
                      <div className="h-3" style={{ background: tm.fg }} />
                      <div
                        className="h-2"
                        style={{ background: tm.ox }}
                      />
                    </div>
                    {/* Pin indicator */}
                    {isPinned && (
                      <span
                        className="absolute top-1.5 left-1.5 block h-1.5 w-1.5 rounded-full"
                        style={{
                          background: tm.ox,
                          boxShadow: `0 0 10px ${tm.ox}`,
                        }}
                      />
                    )}
                    {/* Label */}
                    <span
                      className="absolute bottom-1.5 left-2 right-2 font-mono text-[10px] uppercase tracking-[0.2em] truncate"
                      style={{ color: tm.fg, mixBlendMode: 'difference' }}
                    >
                      {String(i + 1).padStart(2, '0')} {tm.name}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-1 grid grid-cols-9 gap-0 label">
              {MOCK_THEMES.map((tm, i) => (
                <div
                  key={tm.id}
                  className={`text-center py-2 transition-colors ${
                    tm.id === focus ? 'text-plasma' : ''
                  }`}
                >
                  λ{String(i + 1).padStart(2, '0')}
                </div>
              ))}
            </div>

            {/* Live mock */}
            <div className="mt-8">
              <ThemedMock theme={t} />
            </div>

            <div className="mt-6 flex flex-wrap items-baseline justify-between gap-4 label">
              <span>
                <span className="label-plasma">tip · </span>
                hover the bar to preview · click to pin
              </span>
              <span>
                {t.name} · bg {t.bg} · ox {t.ox}
              </span>
            </div>
          </div>
        </InstrumentFrame>
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
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ background: theme.fg, opacity: 0.2 }}
        />
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ background: theme.fg, opacity: 0.2 }}
        />
        <span className="ml-3 font-mono text-[11px]" style={{ opacity: 0.55 }}>
          plasma · prod-replica · {theme.id}.theme
        </span>
        <span
          className="ml-auto font-mono text-[10px] uppercase tracking-[0.2em]"
          style={{ color: theme.ox }}
        >
          λ {theme.name}
        </span>
      </div>

      <aside
        className="col-span-3 md:col-span-2 p-4 border-r font-mono text-[11px] leading-7"
        style={{ borderColor: theme.swatch[1], color: theme.fg, opacity: 0.85 }}
      >
        <div style={{ opacity: 1 }}>▾ public</div>
        <div className="pl-4">orders</div>
        <div className="pl-4">customers</div>
        <div className="pl-4" style={{ color: theme.ox }}>
          order_items*
        </div>
      </aside>

      <main className="col-span-9 md:col-span-10 p-5 md:p-6 font-mono text-[13px] leading-[1.75]">
        <div>
          <span style={{ color: theme.ox }}>SELECT</span> o.id, c.name,
        </div>
        <div className="pl-8">
          <span style={{ color: theme.ox }}>SUM</span>(oi.qty * oi.unit_price){' '}
          <span style={{ color: theme.ox }}>AS</span> total
        </div>
        <div>
          <span style={{ color: theme.ox }}>FROM</span> orders o{' '}
          <span style={{ color: theme.ox }}>JOIN</span> customers c{' '}
          <span style={{ color: theme.ox }}>ON</span> c.id = o.customer_id
        </div>
        <div>
          <span style={{ color: theme.ox }}>WHERE</span> o.created_at &gt;{' '}
          <span style={{ opacity: 0.7 }}>now()</span> -{' '}
          <span style={{ opacity: 0.7 }}>interval &apos;7 days&apos;</span>;
        </div>
        <div
          className="mt-5 grid grid-cols-4 gap-px text-[12px]"
          style={{ background: theme.swatch[1] }}
        >
          {['id', 'customer', 'items', 'total'].map((h) => (
            <div
              key={h}
              className="p-2"
              style={{ background: theme.bg, opacity: 0.6 }}
            >
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
                  style={{
                    background: theme.bg,
                    color: i === 3 ? theme.ox : theme.fg,
                  }}
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
