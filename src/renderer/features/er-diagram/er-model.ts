import type { SchemaInfo } from '@shared/protocol';

/**
 * ER diagram: data derivation, auto-layout and geometry. Pure — the
 * canvas component only draws what this module computes.
 */

export type ColumnMode = 'all' | 'keys' | 'none';

export interface ErColumn {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
  nullable: boolean;
}

export interface ErNode {
  id: string;
  schema: string;
  name: string;
  kind: SchemaInfo['tables'][number]['kind'];
  columns: ErColumn[];
}

export interface ErEdge {
  id: string;
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
}

export interface ErGraph {
  nodes: ErNode[];
  edges: ErEdge[];
}

export interface Point {
  x: number;
  y: number;
}

export type Positions = Record<string, Point>;

export const CARD_WIDTH = 224;
export const HEADER_HEIGHT = 28;
export const ROW_HEIGHT = 20;
const GAP_X = 96;
const GAP_Y = 32;
const PAD = 24;

export const nodeId = (schema: string, name: string): string => `${schema}.${name}`;

export interface GraphScope {
  /** Every table of this schema. */
  schema?: string;
  /** Or just these tables (ids `schema.name`). Wins over `schema`. */
  tables?: readonly string[];
  includeViews?: boolean;
}

/** Derive nodes and FK edges from introspection data. */
export function buildErGraph(info: SchemaInfo, scope: GraphScope): ErGraph {
  const wanted = scope.tables ? new Set(scope.tables) : null;
  const tables = info.tables.filter((t) => {
    if (t.partitionOf) return false;
    if (!scope.includeViews && (t.kind === 'view' || t.kind === 'matview')) return false;
    if (wanted) return wanted.has(nodeId(t.schema, t.name));
    return scope.schema === undefined || t.schema === scope.schema;
  });
  const ids = new Set(tables.map((t) => nodeId(t.schema, t.name)));
  const fkCols = new Set<string>();
  const edges: ErEdge[] = [];
  const seen = new Set<string>();
  for (const fk of info.foreignKeys) {
    fkCols.add(`${nodeId(fk.schema, fk.table)}\u0000${fk.column}`);
    const from = nodeId(fk.schema, fk.table);
    const to = nodeId(fk.refSchema, fk.refTable);
    if (!ids.has(from) || !ids.has(to)) continue;
    const id = `${from}.${fk.column}->${to}.${fk.refColumn}`;
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({ id, from, fromColumn: fk.column, to, toColumn: fk.refColumn });
  }
  const byTable = new Map<string, ErColumn[]>();
  for (const c of [...info.columns].sort((a, b) => a.ordinal - b.ordinal)) {
    const id = nodeId(c.schema, c.table);
    if (!ids.has(id)) continue;
    const list = byTable.get(id) ?? [];
    list.push({
      name: c.name,
      type: c.dataType,
      pk: c.isPrimaryKey,
      fk: fkCols.has(`${id}\u0000${c.name}`),
      nullable: c.isNullable,
    });
    byTable.set(id, list);
  }
  const nodes: ErNode[] = tables.map((t) => ({
    id: nodeId(t.schema, t.name),
    schema: t.schema,
    name: t.name,
    kind: t.kind,
    columns: byTable.get(nodeId(t.schema, t.name)) ?? [],
  }));
  return { nodes, edges };
}

/** Columns a card shows for `mode`. */
export function shownColumns(node: ErNode, mode: ColumnMode): ErColumn[] {
  if (mode === 'all') return node.columns;
  if (mode === 'none') return [];
  return node.columns.filter((c) => c.pk || c.fk);
}

export function cardHeight(node: ErNode, mode: ColumnMode): number {
  return HEADER_HEIGHT + shownColumns(node, mode).length * ROW_HEIGHT + (mode === 'none' ? 0 : 6);
}

// ─── Layout ──────────────────────────────────────────────────────────

/**
 * Layered layout: referenced tables sit left of the tables that reference
 * them. Components are laid out independently and packed into rows;
 * unconnected tables fill a grid at the end. Deterministic.
 */
export function layoutGraph(graph: ErGraph, mode: ColumnMode, targetWidth = 2400): Positions {
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const height = new Map(nodes.map((n) => [n.id, cardHeight(n, mode)]));
  const adj = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));
  const out = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));
  for (const e of graph.edges) {
    if (e.from === e.to) continue;
    adj.get(e.from)?.add(e.to);
    adj.get(e.to)?.add(e.from);
    out.get(e.from)?.add(e.to);
  }

  // Connected components (BFS).
  const comp = new Map<string, number>();
  const comps: string[][] = [];
  for (const n of nodes) {
    if (comp.has(n.id)) continue;
    const members: string[] = [];
    const queue = [n.id];
    comp.set(n.id, comps.length);
    while (queue.length) {
      const cur = queue.shift() as string;
      members.push(cur);
      for (const nb of [...(adj.get(cur) ?? [])].sort()) {
        if (!comp.has(nb)) {
          comp.set(nb, comps.length);
          queue.push(nb);
        }
      }
    }
    comps.push(members);
  }

  const boxes: { ids: string[]; pos: Positions; w: number; h: number }[] = [];
  const loose: string[] = [];
  for (const members of comps) {
    if (members.length === 1 && (adj.get(members[0] as string)?.size ?? 0) === 0) {
      loose.push(members[0] as string);
      continue;
    }
    boxes.push(layoutComponent(members, out, height));
  }
  boxes.sort((a, b) => b.ids.length - a.ids.length);

  const positions: Positions = {};
  let x = PAD;
  let y = PAD;
  let rowH = 0;
  const place = (pos: Positions, w: number, h: number) => {
    if (x > PAD && x + w > targetWidth) {
      x = PAD;
      y += rowH + GAP_Y * 2;
      rowH = 0;
    }
    for (const [id, p] of Object.entries(pos)) positions[id] = { x: p.x + x, y: p.y + y };
    x += w + GAP_X;
    rowH = Math.max(rowH, h);
  };
  for (const b of boxes) place(b.pos, b.w, b.h);

  // Loose tables: a grid under the connected ones.
  if (loose.length) {
    if (x > PAD || boxes.length) {
      x = PAD;
      y += rowH + GAP_Y * 2;
      rowH = 0;
    }
    const perRow = Math.max(1, Math.floor((targetWidth - PAD) / (CARD_WIDTH + GAP_X / 2)));
    let col = 0;
    let rowMax = 0;
    for (const id of loose) {
      const h = height.get(id) ?? HEADER_HEIGHT;
      positions[id] = { x: PAD + col * (CARD_WIDTH + GAP_X / 2), y };
      rowMax = Math.max(rowMax, h);
      col++;
      if (col === perRow) {
        col = 0;
        y += rowMax + GAP_Y;
        rowMax = 0;
      }
    }
  }
  return positions;
}

function layoutComponent(
  members: string[],
  out: Map<string, Set<string>>,
  height: Map<string, number>,
): { ids: string[]; pos: Positions; w: number; h: number } {
  const inSet = new Set(members);
  // Rank = longest path from any node to its deepest referenced table,
  // computed with cycles broken by DFS colouring. rank 0 = referenced most.
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  const order: string[] = [];
  const visit = (start: string) => {
    const stack: { id: string; it: Iterator<string> }[] = [
      {
        id: start,
        it: [...(out.get(start) ?? [])]
          .filter((t) => inSet.has(t))
          .sort()
          [Symbol.iterator](),
      },
    ];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1] as (typeof stack)[number];
      const next = top.it.next();
      if (next.done) {
        state.set(top.id, 2);
        order.push(top.id);
        stack.pop();
        continue;
      }
      const to = next.value;
      const st = state.get(to) ?? 0;
      if (st === 1) back.add(`${top.id}>${to}`);
      else if (st === 0) {
        state.set(to, 1);
        stack.push({
          id: to,
          it: [...(out.get(to) ?? [])]
            .filter((t) => inSet.has(t))
            .sort()
            [Symbol.iterator](),
        });
      }
    }
  };
  for (const id of members) if (!state.has(id)) visit(id);

  // `order` is post-order: referenced tables come before referencing ones.
  const depth = new Map<string, number>();
  for (const id of order) {
    let d = 0;
    for (const t of out.get(id) ?? []) {
      if (!inSet.has(t) || back.has(`${id}>${t}`) || t === id) continue;
      d = Math.max(d, (depth.get(t) ?? 0) + 1);
    }
    depth.set(id, d);
  }
  const layers: string[][] = [];
  for (const id of [...members].sort()) {
    const d = depth.get(id) ?? 0;
    const layer = layers[d] ?? [];
    layer.push(id);
    layers[d] = layer;
  }
  // Rank 0 must be leftmost = tables that reference nothing; flip so
  // deepest chains read left -> right toward referencing tables.
  const ordered = layers.map((l) => l ?? []);

  // Barycentre sweeps to cut crossings.
  const index = new Map<string, number>();
  const reindex = () => {
    for (const layer of ordered) layer.forEach((id, i) => index.set(id, i));
  };
  reindex();
  const neighbours = new Map<string, string[]>(members.map((m) => [m, []]));
  for (const id of members) {
    for (const t of out.get(id) ?? []) {
      if (!inSet.has(t) || t === id) continue;
      neighbours.get(id)?.push(t);
      neighbours.get(t)?.push(id);
    }
  }
  const sweep = (layer: string[], ref: number) => {
    const bary = new Map<string, number>();
    for (const id of layer) {
      const ns = (neighbours.get(id) ?? []).filter((n) => (depth.get(n) ?? 0) === ref);
      bary.set(
        id,
        ns.length
          ? ns.reduce((s, n) => s + (index.get(n) ?? 0), 0) / ns.length
          : (index.get(id) ?? 0),
      );
    }
    layer.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0) || a.localeCompare(b));
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let d = 1; d < ordered.length; d++) {
      sweep(ordered[d] as string[], d - 1);
      reindex();
    }
    for (let d = ordered.length - 2; d >= 0; d--) {
      sweep(ordered[d] as string[], d + 1);
      reindex();
    }
  }

  const pos: Positions = {};
  const layerH = ordered.map((l) => l.reduce((s, id) => s + (height.get(id) ?? 0) + GAP_Y, -GAP_Y));
  const totalH = Math.max(0, ...layerH);
  ordered.forEach((layer, d) => {
    let y = (totalH - (layerH[d] ?? 0)) / 2;
    for (const id of layer) {
      pos[id] = { x: d * (CARD_WIDTH + GAP_X), y };
      y += (height.get(id) ?? 0) + GAP_Y;
    }
  });
  return { ids: members, pos, w: ordered.length * (CARD_WIDTH + GAP_X) - GAP_X, h: totalH };
}

// ─── Geometry ────────────────────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function nodeRect(node: ErNode, pos: Point, mode: ColumnMode): Rect {
  return { x: pos.x, y: pos.y, w: CARD_WIDTH, h: cardHeight(node, mode) };
}

export function boundsOf(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export interface View {
  /** Screen offset of the world origin. */
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 2.5;

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** View that fits `bounds` inside a viewport, with padding, never above 1:1. */
export function fitView(bounds: Rect, vw: number, vh: number, pad = 32): View {
  if (bounds.w <= 0 || bounds.h <= 0 || vw <= 0 || vh <= 0) return { x: 0, y: 0, scale: 1 };
  const scale = clampScale(Math.min((vw - pad * 2) / bounds.w, (vh - pad * 2) / bounds.h, 1));
  return {
    scale,
    x: (vw - bounds.w * scale) / 2 - bounds.x * scale,
    y: (vh - bounds.h * scale) / 2 - bounds.y * scale,
  };
}

/** Zoom around a screen point, keeping the world point under it fixed. */
export function zoomAt(view: View, sx: number, sy: number, factor: number): View {
  const scale = clampScale(view.scale * factor);
  const k = scale / view.scale;
  return { scale, x: sx - (sx - view.x) * k, y: sy - (sy - view.y) * k };
}

/** World-space rectangle currently on screen. */
export function viewportWorld(view: View, vw: number, vh: number): Rect {
  return {
    x: -view.x / view.scale,
    y: -view.y / view.scale,
    w: vw / view.scale,
    h: vh / view.scale,
  };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Cull: ids of nodes whose card touches the (margin-expanded) viewport. */
export function visibleNodeIds(
  nodes: readonly ErNode[],
  positions: Positions,
  mode: ColumnMode,
  viewport: Rect,
  margin = 80,
): Set<string> {
  const vp = {
    x: viewport.x - margin,
    y: viewport.y - margin,
    w: viewport.w + margin * 2,
    h: viewport.h + margin * 2,
  };
  const out = new Set<string>();
  for (const n of nodes) {
    const p = positions[n.id];
    if (p && intersects(nodeRect(n, p, mode), vp)) out.add(n.id);
  }
  return out;
}

export interface EdgeGeometry {
  path: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Y of a column row's centre inside a card (header centre when hidden). */
export function columnY(node: ErNode, column: string, pos: Point, mode: ColumnMode): number {
  const shown = shownColumns(node, mode);
  const i = shown.findIndex((c) => c.name === column);
  if (i < 0) return pos.y + HEADER_HEIGHT / 2;
  return pos.y + HEADER_HEIGHT + i * ROW_HEIGHT + ROW_HEIGHT / 2 + 2;
}

/** Cubic path between the facing sides of two cards. */
export function edgeGeometry(
  edge: ErEdge,
  from: ErNode,
  fromPos: Point,
  to: ErNode,
  toPos: Point,
  mode: ColumnMode,
): EdgeGeometry {
  const y1 = columnY(from, edge.fromColumn, fromPos, mode);
  const y2 = columnY(to, edge.toColumn, toPos, mode);
  let x1: number;
  let x2: number;
  let c1: number;
  let c2: number;
  if (fromPos.x + CARD_WIDTH + 8 <= toPos.x) {
    x1 = fromPos.x + CARD_WIDTH;
    x2 = toPos.x;
    const d = Math.max(40, (x2 - x1) / 2);
    c1 = x1 + d;
    c2 = x2 - d;
  } else if (toPos.x + CARD_WIDTH + 8 <= fromPos.x) {
    x1 = fromPos.x;
    x2 = toPos.x + CARD_WIDTH;
    const d = Math.max(40, (x1 - x2) / 2);
    c1 = x1 - d;
    c2 = x2 + d;
  } else {
    // Overlapping columns (or a self reference): leave and re-enter on the right.
    x1 = fromPos.x + CARD_WIDTH;
    x2 = toPos.x + CARD_WIDTH;
    const d = 56 + Math.abs(y2 - y1) / 4;
    c1 = x1 + d;
    c2 = x2 + d;
  }
  return { x1, y1, x2, y2, path: `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}` };
}

// ─── Search / highlight ──────────────────────────────────────────────

/** Ids of nodes whose name (or a column name) contains `query`. */
export function matchNodes(nodes: readonly ErNode[], query: string): Set<string> {
  const q = query.trim().toLowerCase();
  const out = new Set<string>();
  if (!q) return out;
  for (const n of nodes) {
    if (n.name.toLowerCase().includes(q) || n.columns.some((c) => c.name.toLowerCase().includes(q)))
      out.add(n.id);
  }
  return out;
}

/** A table plus every table it references or is referenced by. */
export function neighbourhood(edges: readonly ErEdge[], id: string): Set<string> {
  const out = new Set<string>([id]);
  for (const e of edges) {
    if (e.from === id) out.add(e.to);
    if (e.to === id) out.add(e.from);
  }
  return out;
}

// ─── Persistence ─────────────────────────────────────────────────────

const STORE_PREFIX = 'plasma.er.positions.';

export function positionsKey(connectionId: string, scopeKey: string): string {
  return `${STORE_PREFIX}${connectionId}:${scopeKey}`;
}

export function parseSavedPositions(raw: string | null): Positions {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object') return {};
    const out: Positions = {};
    for (const [id, p] of Object.entries(data as Record<string, unknown>)) {
      const pt = p as Partial<Point> | null;
      if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y))
        out[id] = { x: pt.x as number, y: pt.y as number };
    }
    return out;
  } catch {
    return {};
  }
}

/** Saved positions win; new tables keep their auto-layout spot. Stale ids are dropped. */
export function mergePositions(auto: Positions, saved: Positions): Positions {
  const out: Positions = {};
  for (const id of Object.keys(auto)) out[id] = saved[id] ?? (auto[id] as Point);
  return out;
}

// ─── SVG export ──────────────────────────────────────────────────────

export interface SvgColors {
  background: string;
  card: string;
  header: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  edge: string;
}

const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** Standalone SVG of the whole diagram (no foreignObject, so it rasterises cleanly). */
export function toSvg(
  graph: ErGraph,
  positions: Positions,
  mode: ColumnMode,
  c: SvgColors,
  font = 'sans-serif',
): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const rects = graph.nodes.flatMap((n) => {
    const p = positions[n.id];
    return p ? [nodeRect(n, p, mode)] : [];
  });
  const b = boundsOf(rects);
  const pad = 24;
  const w = Math.max(1, Math.ceil(b.w + pad * 2));
  const h = Math.max(1, Math.ceil(b.h + pad * 2));
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${b.x - pad} ${b.y - pad} ${w} ${h}" font-family="${esc(font)}" font-size="12">`,
    `<rect x="${b.x - pad}" y="${b.y - pad}" width="${w}" height="${h}" fill="${esc(c.background)}"/>`,
  ];
  for (const e of graph.edges) {
    const f = byId.get(e.from);
    const t = byId.get(e.to);
    const fp = positions[e.from];
    const tp = positions[e.to];
    if (!f || !t || !fp || !tp) continue;
    parts.push(
      `<path d="${edgeGeometry(e, f, fp, t, tp, mode).path}" fill="none" stroke="${esc(c.edge)}" stroke-width="1.2"/>`,
    );
  }
  for (const n of graph.nodes) {
    const p = positions[n.id];
    if (!p) continue;
    const r = nodeRect(n, p, mode);
    parts.push(
      `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="6" fill="${esc(c.card)}" stroke="${esc(c.border)}"/>`,
      `<path d="M ${r.x} ${r.y + HEADER_HEIGHT} V ${r.y + 6} a 6 6 0 0 1 6 -6 H ${r.x + r.w - 6} a 6 6 0 0 1 6 6 V ${r.y + HEADER_HEIGHT} Z" fill="${esc(c.header)}"/>`,
      `<text x="${r.x + 10}" y="${r.y + 18}" fill="${esc(c.text)}" font-weight="600">${esc(n.name.length > 28 ? `${n.name.slice(0, 27)}…` : n.name)}</text>`,
    );
    shownColumns(n, mode).forEach((col, i) => {
      const y = r.y + HEADER_HEIGHT + i * ROW_HEIGHT + 15;
      const marker = col.pk ? 'PK' : col.fk ? 'FK' : '';
      if (marker) {
        parts.push(
          `<text x="${r.x + 10}" y="${y}" fill="${esc(c.accent)}" font-size="9" font-weight="600">${marker}</text>`,
        );
      }
      parts.push(
        `<text x="${r.x + 30}" y="${y}" fill="${esc(c.text)}">${esc(col.name.length > 18 ? `${col.name.slice(0, 17)}…` : col.name)}</text>`,
        `<text x="${r.x + r.w - 8}" y="${y}" fill="${esc(c.muted)}" text-anchor="end" font-size="10">${esc(col.type.length > 16 ? `${col.type.slice(0, 15)}…` : col.type)}</text>`,
      );
    });
  }
  parts.push('</svg>');
  return parts.join('');
}
