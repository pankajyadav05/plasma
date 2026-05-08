'use client';

import { useEffect, useRef, useState } from 'react';

const TARGET = 'EXPLAIN';

/**
 * Listens for the keystroke sequence "EXPLAIN" anywhere on the page
 * (outside form inputs). On match: drops a full-screen modal showing a
 * synthetic EXPLAIN tree of the page itself. Esc closes.
 */
export function ExplainEasterEgg() {
  const [open, setOpen] = useState(false);
  const buf = useRef('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && /^(input|textarea|select)$/i.test(tgt.tagName)) return;
      if (e.key === 'Escape' && open) {
        setOpen(false);
        return;
      }
      if (e.key.length === 1) {
        buf.current = (buf.current + e.key).toUpperCase().slice(-TARGET.length);
        if (buf.current === TARGET) {
          setOpen(true);
          buf.current = '';
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[250] grid place-items-center bg-[rgba(5,5,5,0.85)] backdrop-blur-md text-[#f2ede0] p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Page EXPLAIN"
      onClick={() => setOpen(false)}
    >
      <div
        className="max-w-[860px] w-full border border-[rgba(255,255,255,0.18)] bg-[#0a0a0c] p-8 font-mono text-[13px] leading-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-6">
          <span className="text-[10px] uppercase tracking-[0.3em] text-[#8c8a82]">
            page · explain analyze
          </span>
          <span className="text-[10px] uppercase tracking-[0.3em] text-[#ff5733]">
            press esc
          </span>
        </div>
        <pre className="text-[#f2ede0]">
{`Limit                                        cost=0.08..0.42 rows=1
  ↳ Sort                                     key=delight DESC
      ↳ HashAggregate                        groups=8
          ↳ Hash Join                        scroll → reveal
              ├ Index Scan curtain.iris      0 → 1 in 1.2s
              ├ Index Scan hero.title        opsz=144 wonk=1
              ├ Index Scan ascii_rain        28 drops · 60fps
              ├ Index Scan manifesto         scrub: 6 phrases
              ├ Index Scan editor_ribbon     pinned, hscroll
              ├ Index Scan the_index         12 entries · sticky
              ├ Index Scan cabinet           parallax 8 specimens
              ├ Index Scan theme_atlas       9 mocks · pin/hover
              └ Index Scan open              drip cascade · floor pool

Planning Time:   0.4 ms
Execution Time:  ${(typeof performance !== 'undefined' ? Math.round(performance.now()) : '—')} ms (so far)`}
        </pre>
        <div className="mt-6 text-[#8c8a82]">
          <span className="text-[#e8ff00]">tip · </span>
          this is the hidden tree of the page you're looking at. plasma does the
          same for your real queries.
        </div>
      </div>
    </div>
  );
}
