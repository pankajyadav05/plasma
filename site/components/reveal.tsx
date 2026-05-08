'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * Wraps children in a div that animates from `translateY(28px)` opacity 0
 * to its rest position when the element enters the viewport. Backed by
 * CSS — see `.reveal-up` in globals.css. Once revealed it stays revealed
 * (no exit animation).
 */
export function Reveal({
  children,
  delay = 0,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  as?: 'div' | 'section' | 'span' | 'li' | 'article' | 'p' | 'h2' | 'h3';
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            el.classList.add('in');
            io.disconnect();
          }
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const Component = Tag as 'div';
  return (
    <Component
      ref={ref as React.RefObject<HTMLDivElement>}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
      className={cn('reveal-up', className)}
    >
      {children}
    </Component>
  );
}
