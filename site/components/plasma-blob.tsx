'use client';

import { useEffect, useRef } from 'react';

/**
 * Live plasma — six soft-glow circles drifting in 2D, merged via SVG
 * `feGaussianBlur + feColorMatrix` ("goo filter") so they coalesce into
 * a fluid blob. One ball follows the pointer; the rest orbit on slow
 * sine paths so the blob is always alive even with no mouse input.
 */
interface Ball {
  baseX: number;
  baseY: number;
  ax: number;
  ay: number;
  speedX: number;
  speedY: number;
  phaseX: number;
  phaseY: number;
  x: number;
  y: number;
  r: number;
  follow: number;
}

export function PlasmaBlob() {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let balls: Ball[] = [];
    const target = { x: 0, y: 0, has: false };
    let raf = 0;
    let t0 = performance.now();

    const seed = (w: number, h: number) => {
      const cx = w / 2;
      const cy = h / 2;
      const s = Math.min(w, h);
      // Cluster around the center; amplitudes scale with viewport so the
      // blob fills the same proportional space at any size.
      balls = [
        { baseX: cx, baseY: cy, ax: s * 0.05, ay: s * 0.05, speedX: 0.0006, speedY: 0.0007, phaseX: 0, phaseY: 0, x: cx, y: cy, r: s * 0.22, follow: 0.85 },
        { baseX: cx - s * 0.18, baseY: cy - s * 0.10, ax: s * 0.10, ay: s * 0.08, speedX: 0.0009, speedY: 0.0011, phaseX: 1.2, phaseY: 0.4, x: 0, y: 0, r: s * 0.16, follow: 0 },
        { baseX: cx + s * 0.20, baseY: cy + s * 0.08, ax: s * 0.09, ay: s * 0.10, speedX: 0.0011, speedY: 0.0008, phaseX: 2.0, phaseY: 1.6, x: 0, y: 0, r: s * 0.14, follow: 0 },
        { baseX: cx - s * 0.10, baseY: cy + s * 0.18, ax: s * 0.07, ay: s * 0.07, speedX: 0.0014, speedY: 0.0010, phaseX: 0.8, phaseY: 2.5, x: 0, y: 0, r: s * 0.10, follow: 0 },
        { baseX: cx + s * 0.12, baseY: cy - s * 0.18, ax: s * 0.08, ay: s * 0.06, speedX: 0.0013, speedY: 0.0012, phaseX: 3.1, phaseY: 0.9, x: 0, y: 0, r: s * 0.09, follow: 0 },
        { baseX: cx, baseY: cy, ax: s * 0.14, ay: s * 0.05, speedX: 0.0017, speedY: 0.0019, phaseX: 4.0, phaseY: 2.1, x: 0, y: 0, r: s * 0.07, follow: 0 },
      ];
      target.x = cx;
      target.y = cy;
      // Apply radii to circles so the SVG matches
      const circles = svg.querySelectorAll('circle');
      circles.forEach((c, i) => {
        if (balls[i]) c.setAttribute('r', String(balls[i].r));
      });
    };

    const onMove = (e: MouseEvent) => {
      const r = svg.getBoundingClientRect();
      target.x = e.clientX - r.left;
      target.y = e.clientY - r.top;
      target.has = true;
    };

    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      for (const b of balls) {
        // Idle motion always — orbit around base point
        const idleX = b.baseX + Math.sin(t * b.speedX * 1000 + b.phaseX) * b.ax;
        const idleY = b.baseY + Math.cos(t * b.speedY * 1000 + b.phaseY) * b.ay;
        if (b.follow > 0 && target.has) {
          // Lerp toward cursor, but blend with idle drift so it never
          // freezes when the user stops moving.
          b.x += (target.x - b.x) * 0.08;
          b.y += (target.y - b.y) * 0.08;
        } else {
          b.x = reduce ? b.baseX : idleX;
          b.y = reduce ? b.baseY : idleY;
        }
      }
      const circles = svg.querySelectorAll('circle');
      circles.forEach((c, i) => {
        if (!balls[i]) return;
        c.setAttribute('cx', String(balls[i].x));
        c.setAttribute('cy', String(balls[i].y));
      });
      raf = requestAnimationFrame(tick);
    };

    // Seed on mount and on resize (handles late layout / responsive)
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const cr = e.contentRect;
      seed(cr.width, cr.height);
    });
    ro.observe(svg);
    seed(svg.clientWidth || window.innerWidth, svg.clientHeight || window.innerHeight);

    window.addEventListener('mousemove', onMove);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('mousemove', onMove);
    };
  }, []);

  return (
    <svg
      ref={ref}
      aria-hidden
      className="absolute inset-0 z-0 h-full w-full pointer-events-none"
      preserveAspectRatio="none"
    >
      <defs>
        {/* Goo filter — gaussian blur then a contrast bump that snaps the
            blurred circles back to a hard edge, producing the metaball
            "merge". Tweak stdDeviation higher for softer, lower for tighter. */}
        <filter id="plasma-goo">
          <feGaussianBlur in="SourceGraphic" stdDeviation="30" result="blur" />
          <feColorMatrix
            in="blur"
            mode="matrix"
            values="
              1 0 0 0 0
              0 1 0 0 0
              0 0 1 0 0
              0 0 0 24 -8
            "
            result="goo"
          />
        </filter>
        <radialGradient id="grad-1" cx="50%" cy="50%">
          <stop offset="0%" stopColor="#ffaa66" />
          <stop offset="55%" stopColor="#ff5733" />
          <stop offset="100%" stopColor="#a53d26" />
        </radialGradient>
        <radialGradient id="grad-2">
          <stop offset="0%" stopColor="#ff7a4f" />
          <stop offset="100%" stopColor="#ff5733" />
        </radialGradient>
        <radialGradient id="grad-3">
          <stop offset="0%" stopColor="#e8ff00" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#ff5733" />
        </radialGradient>
      </defs>

      <g filter="url(#plasma-goo)">
        <circle r="220" fill="url(#grad-1)" />
        <circle r="160" fill="url(#grad-1)" />
        <circle r="140" fill="url(#grad-2)" />
        <circle r="100" fill="url(#grad-3)" />
        <circle r="90" fill="url(#grad-2)" />
        <circle r="70" fill="url(#grad-3)" />
      </g>
    </svg>
  );
}
