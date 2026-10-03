import { cn } from '@/lib/cn';
import { type PrefixNode, squarify } from '@shared/health/redis-health';
import { fmtBytes } from '@shared/health/types';

const W = 1000;
const H = 1000;
const MIN_LABEL_PCT = 9;

/**
 * Memory treemap by key prefix. Rectangle area is MEMORY USAGE of the
 * sampled keys under that prefix; children nest inside their parent.
 * Positions are percentages of a unit square, so it scales with the box.
 */
export function Treemap({
  root,
  selected,
  onSelect,
  height = 260,
}: {
  root: PrefixNode;
  selected: string | null;
  onSelect: (node: PrefixNode) => void;
  height?: number;
}) {
  if (root.children.length === 0) return null;
  return (
    <div
      className="relative mx-4 mb-3 overflow-hidden rounded-[6px] border border-[var(--wb-separator)]"
      style={{ height }}
      role="img"
      aria-label="Memory by key prefix"
    >
      <Level nodes={root.children} depth={0} selected={selected} onSelect={onSelect} />
    </div>
  );
}

function Level({
  nodes,
  depth,
  selected,
  onSelect,
}: {
  nodes: PrefixNode[];
  depth: number;
  selected: string | null;
  onSelect: (node: PrefixNode) => void;
}) {
  const rects = squarify(nodes, (n) => n.bytes, W, H);
  return (
    <>
      {rects.map(({ item, x, y, w, h }) => {
        const showLabel = (w / W) * 100 >= MIN_LABEL_PCT && (h / H) * 100 >= 12;
        const nested = item.children.length > 0 && w / W > 0.12 && h / H > 0.25;
        return (
          <div
            key={item.path}
            className="absolute"
            style={{
              left: `${(x / W) * 100}%`,
              top: `${(y / H) * 100}%`,
              width: `${(w / W) * 100}%`,
              height: `${(h / H) * 100}%`,
              padding: 1,
            }}
          >
            <button
              type="button"
              onClick={() => onSelect(item)}
              title={`${item.path} — ${fmtBytes(item.bytes)}, ${item.count} key(s)`}
              aria-pressed={selected === item.path}
              className={cn(
                'relative block h-full w-full overflow-hidden rounded-[3px] text-left text-[11px] text-[var(--wb-text)]',
                selected === item.path && 'ring-2 ring-[var(--wb-accent)]',
              )}
              style={{
                background: `color-mix(in srgb, var(--wb-accent) ${Math.max(10, 34 - depth * 9)}%, var(--wb-control))`,
              }}
            >
              {showLabel && (
                <span className="absolute left-1 top-0.5 z-[1] max-w-full truncate font-mono">
                  {item.name}{' '}
                  <span className="text-[var(--wb-text-2)]">{fmtBytes(item.bytes)}</span>
                </span>
              )}
              {nested && (
                <span className="absolute inset-0 top-4 block">
                  <Level
                    nodes={item.children}
                    depth={depth + 1}
                    selected={selected}
                    onSelect={onSelect}
                  />
                </span>
              )}
            </button>
          </div>
        );
      })}
    </>
  );
}
