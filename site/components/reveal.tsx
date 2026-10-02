'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * One IntersectionObserver for every <Reveal> on the page (dozens of
 * per-element observers were measurable on low-end phones). Elements start
 * visible; only those still below the fold when they mount are armed
 * (hidden), then flipped to `.in` once.
 */
let shared: IntersectionObserver | null = null;

function observer(): IntersectionObserver {
  shared ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        shared?.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
  );
  return shared;
}

/** Subtle scroll reveal: 8px rise plus fade, once. CSS handles reduced motion. */
export function Reveal({
  children,
  className,
  delay = 0,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: 'div' | 'li' | 'p' | 'section' | 'figure';
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const top = el.getBoundingClientRect().top;
    // Already on screen at mount: leave it visible, no hide/show flash.
    if (top < window.innerHeight * 0.92) return;
    el.classList.add('armed');
    const io = observer();
    io.observe(el);
    return () => io.unobserve(el);
  }, []);

  const Comp = Tag as 'div';
  return (
    <Comp
      ref={ref as React.RefObject<HTMLDivElement>}
      className={cn('reveal', className)}
      style={{ '--d': `${delay}ms` } as CSSProperties}
    >
      {children}
    </Comp>
  );
}
