'use client';

import { type ReactNode, useRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * Wraps a child element in a div that translates toward the cursor.
 * Strength is the fraction of the cursor offset to apply (0.18 = 18%).
 * Hands off to CSS for the smooth ease-back via `.magnetic` utility.
 */
export function Magnetic({
  children,
  strength = 0.22,
  className,
}: {
  children: ReactNode;
  strength?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  const onMove = (e: React.MouseEvent<HTMLSpanElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left - r.width / 2) * strength;
    const y = (e.clientY - r.top - r.height / 2) * strength;
    el.style.transform = `translate(${x}px, ${y}px)`;
  };
  const onLeave = () => {
    const el = ref.current;
    if (el) el.style.transform = '';
  };

  return (
    <span
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={cn('magnetic inline-block', className)}
    >
      {children}
    </span>
  );
}
