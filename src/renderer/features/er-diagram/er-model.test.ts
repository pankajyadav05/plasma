import type { SchemaInfo } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import {
  CARD_WIDTH,
  type ErGraph,
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
  toSvg,
  viewportWorld,
  visibleNodeIds,
  zoomAt,
} from './er-model';

const t = (schema: string, name: string, kind: 'table' | 'view' = 'table') => ({
  schema,
  name,
  kind,
  rowCountEstimate: null,
});
const col = (schema: string, table: string, name: string, ordinal: number, pk = false) => ({
  schema,
  table,
  name,
  dataType: 'integer',
  ordinal,
  isPrimaryKey: pk,
  isNullable: !pk,
  hasDefault: false,
});
const fk = (
  table: string,
  column: string,
  refTable: string,
  refColumn = 'id',
  schema = 'public',
  refSchema = 'public',
) => ({
  schema,
  table,
  column,
  refSchema,
  refTable,
  refColumn,
});

const info = (over: Partial<SchemaInfo> = {}): SchemaInfo =>
  ({
    schemas: [{ name: 'public' }, { name: 'other' }],
    tables: [
      t('public', 'users'),
      t('public', 'orders'),
      t('public', 'items'),
      t('public', 'lonely'),
      t('other', 'x'),
      t('public', 'v', 'view'),
    ],
    columns: [
      col('public', 'users', 'id', 1, true),
      col('public', 'orders', 'id', 1, true),
      col('public', 'orders', 'user_id', 2),
      col('public', 'items', 'id', 1, true),
      col('public', 'items', 'order_id', 2),
    ],
    foreignKeys: [
      fk('orders', 'user_id', 'users'),
      fk('items', 'order_id', 'orders'),
      fk('items', 'order_id', 'orders'),
    ],
    routines: [],
    sequences: [],
    types: [],
    extensions: [],
    ...over,
  }) as SchemaInfo;

describe('buildErGraph', () => {
  it('scopes to a schema, skips views, marks keys and dedupes edges', () => {
    const g = buildErGraph(info(), { schema: 'public' });
    expect(g.nodes.map((n) => n.id).sort()).toEqual([
      'public.items',
      'public.lonely',
      'public.orders',
      'public.users',
    ]);
    expect(g.edges).toHaveLength(2);
    const orders = g.nodes.find((n) => n.name === 'orders');
    expect(orders?.columns.map((c) => [c.name, c.pk, c.fk])).toEqual([
      ['id', true, false],
      ['user_id', false, true],
    ]);
  });

  it('honours an explicit table selection and drops edges leaving it', () => {
    const g = buildErGraph(info(), { tables: ['public.orders', 'public.items'] });
    expect(g.nodes).toHaveLength(2);
    expect(g.edges.map((e) => e.id)).toEqual(['public.items.order_id->public.orders.id']);
  });
});

describe('layoutGraph', () => {
  const g = buildErGraph(info(), { schema: 'public' });

  it('puts referenced tables left of referencing ones, without overlaps', () => {
    const pos = layoutGraph(g, 'all');
    expect(pos['public.users']!.x).toBeLessThan(pos['public.orders']!.x);
    expect(pos['public.orders']!.x).toBeLessThan(pos['public.items']!.x);
    const rects = g.nodes.map((n) => nodeRect(n, pos[n.id]!, 'all'));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap).toBe(false);
      }
    }
  });

  it('is deterministic and survives FK cycles', () => {
    const cyc: ErGraph = {
      nodes: ['a', 'b', 'c'].map((n) => ({
        id: n,
        schema: 's',
        name: n,
        kind: 'table',
        columns: [],
      })),
      edges: [
        { id: '1', from: 'a', fromColumn: 'x', to: 'b', toColumn: 'y' },
        { id: '2', from: 'b', fromColumn: 'x', to: 'c', toColumn: 'y' },
        { id: '3', from: 'c', fromColumn: 'x', to: 'a', toColumn: 'y' },
        { id: '4', from: 'a', fromColumn: 'x', to: 'a', toColumn: 'y' },
      ],
    };
    const p1 = layoutGraph(cyc, 'none');
    expect(layoutGraph(cyc, 'none')).toEqual(p1);
    expect(Object.keys(p1).sort()).toEqual(['a', 'b', 'c']);
  });

  it('lays out 300 tables quickly', () => {
    const nodes = Array.from({ length: 300 }, (_, i) => ({
      id: `public.t${i}`,
      schema: 'public',
      name: `t${i}`,
      kind: 'table' as const,
      columns: Array.from({ length: 8 }, (_, c) => ({
        name: `c${c}`,
        type: 'int',
        pk: c === 0,
        fk: c === 1,
        nullable: true,
      })),
    }));
    const edges = nodes.slice(1).map((n, i) => ({
      id: `e${i}`,
      from: n.id,
      fromColumn: 'c1',
      to: nodes[Math.floor(i / 3)]!.id,
      toColumn: 'c0',
    }));
    const t0 = performance.now();
    const pos = layoutGraph({ nodes, edges }, 'keys');
    expect(Object.keys(pos)).toHaveLength(300);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('viewport, culling and edges', () => {
  const g = buildErGraph(info(), { schema: 'public' });
  const pos = layoutGraph(g, 'all');

  it('culls cards outside the viewport', () => {
    const far = { ...pos, 'public.lonely': { x: 50000, y: 50000 } };
    const vis = visibleNodeIds(g.nodes, far, 'all', { x: 0, y: 0, w: 1200, h: 800 });
    expect(vis.has('public.lonely')).toBe(false);
    expect(vis.has('public.users')).toBe(true);
  });

  it('zoomAt keeps the anchor fixed and fitView fits', () => {
    const v = zoomAt({ x: 10, y: 20, scale: 1 }, 100, 100, 2);
    expect(v.scale).toBe(2);
    expect((100 - v.x) / v.scale).toBeCloseTo((100 - 10) / 1);
    const f = fitView({ x: 0, y: 0, w: 4000, h: 2000 }, 800, 600);
    expect(f.scale).toBeLessThan(0.25);
    const w = viewportWorld(f, 800, 600);
    expect(w.w).toBeGreaterThanOrEqual(4000);
    expect(fitView({ x: 0, y: 0, w: 100, h: 50 }, 800, 600).scale).toBe(1);
  });

  it('routes edges between facing card sides at the column rows', () => {
    const e = g.edges.find((x) => x.from === 'public.orders')!;
    const from = g.nodes.find((n) => n.id === e.from)!;
    const to = g.nodes.find((n) => n.id === e.to)!;
    const geo = edgeGeometry(e, from, pos[from.id]!, to, pos[to.id]!, 'all');
    expect(geo.x1).toBe(pos[from.id]!.x);
    expect(geo.x2).toBe(pos[to.id]!.x + CARD_WIDTH);
    expect(geo.path.startsWith('M ')).toBe(true);
  });

  it('cardHeight follows the column mode', () => {
    const n = g.nodes.find((x) => x.name === 'orders')!;
    expect(cardHeight(n, 'none')).toBeLessThan(cardHeight(n, 'keys'));
    expect(cardHeight(n, 'keys')).toBeLessThanOrEqual(cardHeight(n, 'all'));
  });
});

describe('search, persistence, export', () => {
  const g = buildErGraph(info(), { schema: 'public' });

  it('matches table and column names', () => {
    expect([...matchNodes(g.nodes, 'ord')].sort()).toEqual(['public.items', 'public.orders']);
    expect(matchNodes(g.nodes, '').size).toBe(0);
    expect([...neighbourhood(g.edges, 'public.orders')].sort()).toEqual([
      'public.items',
      'public.orders',
      'public.users',
    ]);
  });

  it('merges saved positions over auto layout and ignores junk', () => {
    const auto = { a: { x: 0, y: 0 }, b: { x: 1, y: 1 } };
    expect(mergePositions(auto, { a: { x: 9, y: 9 }, gone: { x: 5, y: 5 } })).toEqual({
      a: { x: 9, y: 9 },
      b: { x: 1, y: 1 },
    });
    expect(parseSavedPositions('{"a":{"x":1,"y":2},"b":{"x":"n"}}')).toEqual({ a: { x: 1, y: 2 } });
    expect(parseSavedPositions('not json')).toEqual({});
    expect(parseSavedPositions(null)).toEqual({});
  });

  it('exports a standalone svg with escaped names', () => {
    const pos = layoutGraph(g, 'all');
    const evil: ErGraph = { nodes: [{ ...g.nodes[0]!, id: 'x', name: '<b>&"' }], edges: [] };
    const svg = toSvg(evil, { x: { x: 0, y: 0 } }, 'all', {
      background: '#fff',
      card: '#fff',
      header: '#eee',
      border: '#ccc',
      text: '#000',
      muted: '#666',
      accent: '#f00',
      edge: '#999',
    });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('&lt;b&gt;&amp;&quot;');
    expect(svg).not.toContain('<b>');
    expect(
      toSvg(g, pos, 'keys', {
        background: '#fff',
        card: '#fff',
        header: '#eee',
        border: '#ccc',
        text: '#000',
        muted: '#666',
        accent: '#f00',
        edge: '#999',
      }),
    ).toContain('<path d="M');
  });
});
