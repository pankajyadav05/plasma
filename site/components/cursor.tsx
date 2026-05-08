'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Custom cursor: a 24px crosshair circle that lerps toward the pointer
 * with an optional label (set via `data-cursor` on hovered elements).
 * Hidden under coarse pointers via a media query in globals.css.
 */
export function Cursor() {
  const dotRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      setEnabled(true);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const dot = dotRef.current;
    const label = labelRef.current;
    if (!dot || !label) return;

    const pos = { x: -100, y: -100, cx: -100, cy: -100 };
    let raf = 0;
    const labelText = { current: '' };

    const onMove = (e: MouseEvent) => {
      pos.x = e.clientX;
      pos.y = e.clientY;
      const target = e.target as HTMLElement | null;
      const t = target?.closest('[data-cursor]') as HTMLElement | null;
      const next = t?.getAttribute('data-cursor') ?? '';
      if (next !== labelText.current) {
        labelText.current = next;
        label.textContent = next;
        label.style.opacity = next ? '1' : '0';
      }
      // Hover-grow when over interactive
      const interactive = target?.closest('a,button,[role="button"],[data-cursor]');
      dot.style.setProperty(
        '--scale',
        interactive ? (next ? '2.4' : '1.6') : '1',
      );
    };

    const tick = () => {
      pos.cx += (pos.x - pos.cx) * 0.18;
      pos.cy += (pos.y - pos.cy) * 0.18;
      dot.style.transform = `translate3d(${pos.cx}px, ${pos.cy}px, 0) translate(-50%, -50%) scale(var(--scale, 1))`;
      label.style.transform = `translate3d(${pos.cx + 18}px, ${pos.cy + 18}px, 0)`;
      raf = requestAnimationFrame(tick);
    };

    window.addEventListener('mousemove', onMove);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <>
      <div
        ref={dotRef}
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 z-[200] h-6 w-6 rounded-full border border-fg mix-blend-difference"
        style={{ transition: 'border-color 0.2s, background 0.2s' }}
      >
        <span className="absolute left-1/2 top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-fg" />
        <span className="absolute left-1/2 top-1/2 h-px w-3 -translate-x-1/2 -translate-y-1/2 bg-fg" />
      </div>
      <div
        ref={labelRef}
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 z-[200] font-mono text-[10px] uppercase tracking-[0.18em] text-fg mix-blend-difference"
        style={{ opacity: 0, transition: 'opacity 0.2s' }}
      />
    </>
  );
}
