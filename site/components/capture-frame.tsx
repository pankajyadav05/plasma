import Image from 'next/image';
import type { CSSProperties } from 'react';
import { Caption, Plate } from '@/components/plate';
import type { Capture } from '@/lib/captures';

/**
 * A magnified part of the capture, like the detail callout of a technical
 * drawing. Coordinates are CSS pixels of the captured window (half the 2x
 * file size): `rect` is the area to magnify, `at` is where the inset sits
 * ([x, y, width]; its height follows the area's aspect).
 */
export interface CaptureDetail {
  rect: [x: number, y: number, w: number, h: number];
  at: [x: number, y: number, w: number];
  label: string;
}

function DetailView({ c, d, style, className }: { c: Capture; d: CaptureDetail; style?: CSSProperties; className?: string }) {
  const W = c.width / 2;
  const H = c.height / 2;
  const [x, y, w, h] = d.rect;
  return (
    <div
      role="img"
      aria-label={`Detail: ${d.label}`}
      className={className}
      style={{
        aspectRatio: `${w} / ${h}`,
        backgroundImage: `url(${c.src})`,
        backgroundSize: `${(W / w) * 100}% auto`,
        backgroundPosition: `${(x / (W - w)) * 100}% ${(y / (H - h)) * 100}%`,
        backgroundRepeat: 'no-repeat',
        ...style,
      }}
    />
  );
}

/** The detail drawn over the capture: outline, leader line and inset. Wide screens only. */
function DetailOverlay({ c, d }: { c: Capture; d: CaptureDetail }) {
  const W = c.width / 2;
  const H = c.height / 2;
  const [x, y, w, h] = d.rect;
  const [ax, ay, aw] = d.at;
  const ah = (aw * h) / w;
  // Leader: from the side of the area facing the inset to the inset's facing side.
  const insetLeft = ax + aw < x;
  const from = insetLeft ? [x, y + h / 2] : [x + w, y + h / 2];
  const to = insetLeft ? [ax + aw, ay + ah / 2] : [ax, ay + ah / 2];
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 hidden md:block">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          fill="none"
          stroke="var(--color-signal)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={from[0]}
          y1={from[1]}
          x2={to[0]}
          y2={to[1]}
          stroke="var(--color-signal)"
          strokeWidth="1"
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={from[0]} cy={from[1]} r="3" fill="var(--color-signal)" />
      </svg>
      <div
        className="detail-inset absolute"
        style={{ left: pct(ax, W), top: pct(ay, H), width: pct(aw, W) }}
      >
        <DetailView c={c} d={d} className="w-full" />
        <p className="detail-label mono">Detail · {d.label}</p>
      </div>
    </div>
  );
}

/**
 * A real app capture in a plate with crop marks and a caption. Renders
 * nothing when the capture is not on disk yet, so the page builds before
 * every capture has landed.
 */
export function CaptureFrame({
  c,
  caption,
  sizes,
  marks = true,
  className,
  detail,
}: {
  c: Capture | undefined;
  caption?: string;
  sizes: string;
  marks?: boolean;
  className?: string;
  detail?: CaptureDetail;
}) {
  if (!c) return null;
  return (
    <figure className={className}>
      <Plate marks={marks}>
        <div className="relative">
          <Image
            src={c.src}
            alt={c.alt}
            width={c.width}
            height={c.height}
            sizes={sizes}
            loading="lazy"
            className="block h-auto w-full"
          />
          {detail && <DetailOverlay c={c} d={detail} />}
        </div>
      </Plate>
      {detail && (
        <div className="detail-inset mt-4 md:hidden">
          <DetailView c={c} d={detail} className="w-full" />
          <p className="detail-label mono">Detail · {detail.label}</p>
        </div>
      )}
      {caption && <Caption>{caption}</Caption>}
    </figure>
  );
}
