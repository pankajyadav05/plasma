import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { EmptyState, ViewFooter, ViewToolbar } from '@/components/ui/view-parts';
import { IconButton, MenuItem, Pill, Segmented } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { useActiveTab, useSession } from '@/stores/session';
import {
  Download,
  Key,
  Link2,
  Maximize,
  Minus,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Table2,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CARD_WIDTH,
  type ColumnMode,
  type ErEdge,
  type ErNode,
  HEADER_HEIGHT,
  type Point,
  type Positions,
  ROW_HEIGHT,
  type SvgColors,
  type View,
  boundsOf,
  buildErGraph,
  cardHeight,
  edgeGeometry,
  fitView,
  layoutGraph,
  matchNodes,
  mergePositions,
  neighbourhood,
  nodeRect,
  parseSavedPositions,
  positionsKey,
  shownColumns,
  toSvg,
  viewportWorld,
  visibleNodeIds,
  zoomAt,
} from './er-model';

const MODE_KEY = 'plasma.er.columnMode';

/** Below this canvas width the less-used toolbar controls fold into a "…" menu. */
const COMPACT_WIDTH = 720;

function readMode(): ColumnMode {
  try {
    const v = globalThis.localStorage?.getItem(MODE_KEY);
    return v === 'keys' || v === 'none' ? v : 'all';
  } catch {
    return 'all';
  }
}

function readSaved(key: string): Positions {
  try {
    return parseSavedPositions(globalThis.localStorage?.getItem(key) ?? null);
  } catch {
    return {};
  }
}

interface CardProps {
  node: ErNode;
  pos: Point;
  mode: ColumnMode;
  dim: boolean;
  match: boolean;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  onHover: (id: string | null) => void;
  onOpen: (node: ErNode) => void;
}

const Card = memo(function Card({
  node,
  pos,
  mode,
  dim,
  match,
  onPointerDown,
  onHover,
  onOpen,
}: CardProps) {
  const cols = shownColumns(node, mode);
  return (
    <div
      data-er-card={node.id}
      className={cn(
        'absolute overflow-hidden rounded-[6px] bg-[var(--wb-content)] text-[12px] shadow-[0_0_0_1px_var(--wb-toolbar-group-edge)]',
        match && 'shadow-[0_0_0_2px_var(--wb-accent)]',
        dim && 'opacity-35',
      )}
      style={{ left: pos.x, top: pos.y, width: CARD_WIDTH, height: cardHeight(node, mode) }}
      onPointerEnter={() => onHover(node.id)}
      onPointerLeave={() => onHover(null)}
    >
      <button
        type="button"
        aria-label={`Open ${node.schema}.${node.name}`}
        title={`${node.schema}.${node.name} — click to open, drag to move`}
        className="flex w-full cursor-grab items-center gap-1.5 bg-[var(--wb-control)] px-2 text-left font-medium text-[var(--wb-text)] active:cursor-grabbing"
        style={{ height: HEADER_HEIGHT }}
        onPointerDown={(e) => onPointerDown(e, node.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onOpen(node);
        }}
      >
        <Table2 className="h-3.5 w-3.5 shrink-0 opacity-60" />
        <span className="truncate">{node.name}</span>
        {node.schema !== 'public' && (
          <span className="ml-auto truncate text-[11px] font-normal text-[var(--wb-text-3)]">
            {node.schema}
          </span>
        )}
      </button>
      {cols.map((c) => (
        <div
          key={c.name}
          className="flex items-center gap-1.5 px-2 text-[var(--wb-text)]"
          style={{ height: ROW_HEIGHT }}
        >
          <span className="flex w-4 shrink-0 justify-center text-[var(--wb-accent)]">
            {c.pk ? (
              <Key className="h-3 w-3" aria-label="Primary key" />
            ) : c.fk ? (
              <Link2 className="h-3 w-3" aria-label="Foreign key" />
            ) : null}
          </span>
          <span className={cn('truncate', c.nullable ? '' : 'font-medium')}>{c.name}</span>
          <span className="ml-auto max-w-[90px] shrink-0 truncate text-[11px] text-[var(--wb-text-3)]">
            {c.type}
          </span>
        </div>
      ))}
    </div>
  );
});

function resolveColor(host: HTMLElement, cssVar: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${cssVar})`;
  host.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ErDiagramView() {
  const tab = useActiveTab();
  const info = useSession((s) => s.schema);
  const connectionId = useSession((s) => s.activeConfig?.id ?? '_');
  const ensureSchemaColumns = useSession((s) => s.ensureSchemaColumns);
  const openTable = useSession((s) => s.openTable);

  const scope = (tab?.erScope ?? {}) as { schema?: string; tables?: string[] };
  const scopeKey = (tab?.erScopeKey as string | undefined) ?? scope.schema ?? 'public';

  const [mode, setMode] = useState<ColumnMode>(readMode);
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: 24, y: 24, scale: 1 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [moved, setMoved] = useState<Positions>(() =>
    readSaved(positionsKey(connectionId, scopeKey)),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);
  // Set once the user pans or zooms; until then a resize (e.g. a split pane
  // opening) re-fits the diagram to the new canvas.
  const userMoved = useRef(false);

  // Columns load per schema (F16); the graph needs those of the scope.
  const schemasNeeded = useMemo(() => {
    if (scope.tables?.length)
      return [...new Set(scope.tables.map((id) => id.slice(0, id.indexOf('.'))))];
    return [scope.schema ?? 'public'];
  }, [scope.schema, scope.tables]);
  useEffect(() => {
    for (const s of schemasNeeded) void ensureSchemaColumns(s);
  }, [schemasNeeded, ensureSchemaColumns]);

  const graph = useMemo(
    () =>
      info
        ? buildErGraph(info, { schema: scope.schema, tables: scope.tables, includeViews: false })
        : { nodes: [], edges: [] },
    [info, scope.schema, scope.tables],
  );
  const auto = useMemo(() => layoutGraph(graph, mode), [graph, mode]);
  const positions = useMemo(() => mergePositions(auto, moved), [auto, moved]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  const fit = useCallback(
    (p: Positions = positions) => {
      const rects = graph.nodes.flatMap((n) =>
        p[n.id] ? [nodeRect(n, p[n.id] as Point, mode)] : [],
      );
      setView(fitView(boundsOf(rects), size.w, size.h));
    },
    [graph.nodes, mode, positions, size.h, size.w],
  );

  // Track the canvas size.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Fit once the first real layout is there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fit only on first data
  useEffect(() => {
    if (fitted.current || graph.nodes.length === 0 || size.w < 50) return;
    fitted.current = true;
    fit();
  }, [graph.nodes.length, size.w]);

  // Keep the diagram usable when the canvas resizes and the user hasn't
  // taken over the viewport yet.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    if (!fitted.current || userMoved.current || size.w < 50 || size.h < 50) return;
    fitRef.current();
  }, [size.w, size.h]);

  // Wheel zoom (needs a non-passive listener to stop page scroll).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userMoved.current = true;
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      setView((v) => zoomAt(v, e.clientX - rect.left, e.clientY - rect.top, factor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const persist = useCallback(
    (next: Positions) => {
      try {
        globalThis.localStorage?.setItem(
          positionsKey(connectionId, scopeKey),
          JSON.stringify(next),
        );
      } catch {
        /* storage unavailable */
      }
    },
    [connectionId, scopeKey],
  );

  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const viewRef = useRef(view);
  viewRef.current = view;

  // Pan (background) and card drag share one gesture handler.
  const gesture = useRef<
    | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
    | {
        kind: 'card';
        id: string;
        sx: number;
        sy: number;
        ox: number;
        oy: number;
        travelled: number;
      }
    | null
  >(null);

  const onCardDown = useCallback((e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = positionsRef.current[id] as Point;
    gesture.current = {
      kind: 'card',
      id,
      sx: e.clientX,
      sy: e.clientY,
      ox: p.x,
      oy: p.y,
      travelled: 0,
    };
  }, []);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  };

  const onMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pan') {
      if (Math.abs(e.clientX - g.sx) + Math.abs(e.clientY - g.sy) > 2) userMoved.current = true;
      setView((v) => ({ ...v, x: g.vx + e.clientX - g.sx, y: g.vy + e.clientY - g.sy }));
      return;
    }
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    g.travelled = Math.max(g.travelled, Math.abs(dx) + Math.abs(dy));
    if (g.travelled < 4) return;
    const s = viewRef.current.scale;
    setMoved((m) => ({
      ...positionsRef.current,
      ...m,
      [g.id]: { x: g.ox + dx / s, y: g.oy + dy / s },
    }));
  };

  const onUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (g?.kind !== 'card') return;
    if (g.travelled < 4) {
      const n = nodeById.get(g.id);
      if (n) openTable(n.schema, n.name);
      return;
    }
    persist({ ...positionsRef.current });
  };

  const changeMode = (m: ColumnMode) => {
    setMode(m);
    try {
      globalThis.localStorage?.setItem(MODE_KEY, m);
    } catch {
      /* storage unavailable */
    }
  };

  const resetLayout = () => {
    setMoved({});
    try {
      globalThis.localStorage?.removeItem(positionsKey(connectionId, scopeKey));
    } catch {
      /* storage unavailable */
    }
    userMoved.current = false;
    fit(auto);
  };

  const zoomBy = (factor: number) => {
    userMoved.current = true;
    setView((v) => zoomAt(v, size.w / 2, size.h / 2, factor));
  };
  const fitToScreen = () => {
    userMoved.current = false;
    fit();
  };
  const compact = size.w < COMPACT_WIDTH;

  const matches = useMemo(() => matchNodes(graph.nodes, query), [graph.nodes, query]);
  const focus = useMemo(
    () => (hover ? neighbourhood(graph.edges, hover) : null),
    [graph.edges, hover],
  );

  // Cull to what is on screen.
  const vp = useMemo(() => viewportWorld(view, size.w, size.h), [view, size.w, size.h]);
  const visible = useMemo(
    () => visibleNodeIds(graph.nodes, positions, mode, vp),
    [graph.nodes, positions, mode, vp],
  );
  const visibleEdges = useMemo(() => {
    const out: { edge: ErEdge; path: string }[] = [];
    for (const e of graph.edges) {
      const f = nodeById.get(e.from);
      const t = nodeById.get(e.to);
      const fp = positions[e.from];
      const tp = positions[e.to];
      if (!f || !t || !fp || !tp) continue;
      if (!visible.has(e.from) && !visible.has(e.to)) {
        // Long edges can cross the viewport between two off-screen cards.
        const minX = Math.min(fp.x, tp.x);
        const maxX = Math.max(fp.x, tp.x) + CARD_WIDTH;
        const minY = Math.min(fp.y, tp.y);
        const maxY = Math.max(fp.y, tp.y);
        if (maxX < vp.x || minX > vp.x + vp.w || maxY < vp.y || minY > vp.y + vp.h) continue;
      }
      out.push({ edge: e, path: edgeGeometry(e, f, fp, t, tp, mode).path });
    }
    return out;
  }, [graph.edges, nodeById, positions, visible, mode, vp]);

  const openNode = useCallback((n: ErNode) => openTable(n.schema, n.name), [openTable]);

  const exportDiagram = async (kind: 'svg' | 'png') => {
    const host = rootRef.current;
    if (!host) return;
    const colors: SvgColors = {
      background: resolveColor(host, '--wb-content'),
      card: resolveColor(host, '--wb-content'),
      header: resolveColor(host, '--wb-control'),
      border: resolveColor(host, '--wb-toolbar-group-edge'),
      text: resolveColor(host, '--wb-text'),
      muted: resolveColor(host, '--wb-text-3'),
      accent: resolveColor(host, '--wb-accent'),
      edge: resolveColor(host, '--wb-text-3'),
    };
    const svg = toSvg(graph, positions, mode, colors, getComputedStyle(host).fontFamily);
    const base = `diagram-${scopeKey.replace(/[^\w.-]+/g, '_').slice(0, 60)}`;
    if (kind === 'svg') {
      download(new Blob([svg], { type: 'image/svg+xml' }), `${base}.svg`);
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not render the diagram.'));
      img.src = url;
    });
    const scale = Math.min(2, 16000 / Math.max(img.width, img.height, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(img.width * scale));
    canvas.height = Math.max(1, Math.floor(img.height * scale));
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob((b) => b && download(b, `${base}.png`), 'image/png');
  };

  const title = scope.tables?.length
    ? `${scope.tables.length} selected tables`
    : (scope.schema ?? 'public');

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--wb-content)]" data-testid="er-diagram">
      <ViewToolbar className="min-w-0 overflow-hidden">
        <Input
          className={compact ? 'min-w-0 flex-1' : 'w-[200px]'}
          placeholder="Find table or column"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find table or column"
        />
        {query.trim() !== '' && (
          <span className="shrink-0 text-[12px] text-[var(--wb-text-2)]">
            {matches.size} match{matches.size === 1 ? '' : 'es'}
          </span>
        )}
        {!compact && <div className="flex-1" />}
        {!compact && (
          <Segmented<ColumnMode>
            variant="track"
            size="sm"
            ariaLabel="Columns shown"
            value={mode}
            onChange={changeMode}
            options={[
              { value: 'all', label: 'All columns' },
              { value: 'keys', label: 'Keys' },
              { value: 'none', label: 'Names' },
            ]}
          />
        )}
        <IconButton label="Zoom out" onClick={() => zoomBy(0.8)}>
          <Minus />
        </IconButton>
        <span className="w-10 shrink-0 text-center text-[12px] tabular-nums text-[var(--wb-text-2)]">
          {Math.round(view.scale * 100)}%
        </span>
        <IconButton label="Zoom in" onClick={() => zoomBy(1.25)}>
          <Plus />
        </IconButton>
        <IconButton label="Fit to screen" onClick={fitToScreen}>
          <Maximize />
        </IconButton>
        {!compact && (
          <IconButton label="Reset layout" onClick={resetLayout}>
            <RotateCcw />
          </IconButton>
        )}
        {compact ? (
          <Popover>
            <PopoverTrigger asChild>
              <IconButton label="More diagram options">
                <MoreHorizontal />
              </IconButton>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[180px] p-1" role="menu">
              <MenuItem
                label="All columns"
                checked={mode === 'all'}
                onClick={() => changeMode('all')}
              />
              <MenuItem
                label="Keys only"
                checked={mode === 'keys'}
                onClick={() => changeMode('keys')}
              />
              <MenuItem
                label="Names only"
                checked={mode === 'none'}
                onClick={() => changeMode('none')}
              />
              <MenuItem icon={<RotateCcw />} label="Reset layout" onClick={resetLayout} />
              <MenuItem
                icon={<Download />}
                label="Export PNG"
                onClick={() => void exportDiagram('png')}
              />
              <MenuItem
                icon={<Download />}
                label="Export SVG"
                onClick={() => void exportDiagram('svg')}
              />
            </PopoverContent>
          </Popover>
        ) : (
          <Popover>
            <PopoverTrigger asChild>
              <Pill aria-label="Export diagram">
                <Download /> Export
              </Pill>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[160px] p-1" role="menu">
              <MenuItem label="PNG image" onClick={() => void exportDiagram('png')} />
              <MenuItem label="SVG image" onClick={() => void exportDiagram('svg')} />
            </PopoverContent>
          </Popover>
        )}
      </ViewToolbar>

      <div
        ref={rootRef}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        aria-label={`Diagram of ${title}`}
      >
        {graph.nodes.length === 0 ? (
          <EmptyState
            title="No tables to show"
            hint="This schema has no tables, or its columns are still loading."
          />
        ) : (
          <>
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
              role="img"
              aria-label="Relationships between tables"
            >
              <g
                transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}
                fill="none"
                strokeLinecap="round"
              >
                {visibleEdges.map(({ edge, path }) => {
                  const hot = hover !== null && (edge.from === hover || edge.to === hover);
                  return (
                    <path
                      key={edge.id}
                      d={path}
                      stroke={hot ? 'var(--wb-accent)' : 'var(--wb-text-3)'}
                      strokeWidth={hot ? 2 : 1.2}
                      opacity={hover && !hot ? 0.25 : 0.85}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
              </g>
            </svg>
            <div
              className="absolute left-0 top-0 origin-top-left"
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            >
              {graph.nodes.map((n) =>
                visible.has(n.id) ? (
                  <Card
                    key={n.id}
                    node={n}
                    pos={positions[n.id] as Point}
                    mode={mode}
                    dim={
                      (query.trim() !== '' && !matches.has(n.id)) ||
                      (focus !== null && !focus.has(n.id))
                    }
                    match={matches.has(n.id)}
                    onPointerDown={onCardDown}
                    onHover={setHover}
                    onOpen={openNode}
                  />
                ) : null,
              )}
            </div>
          </>
        )}
      </div>

      <ViewFooter>
        <span>{title}</span>
        <span>{graph.nodes.length} tables</span>
        <span>{graph.edges.length} relationships</span>
        <span className="ml-auto truncate text-[var(--wb-text-3)]">
          Scroll to zoom, drag to pan. Click a table header to open it.
        </span>
      </ViewFooter>
    </div>
  );
}
