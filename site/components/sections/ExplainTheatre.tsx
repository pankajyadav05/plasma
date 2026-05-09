'use client';

import { useEffect, useState } from 'react';
import { InstrumentFrame } from '@/components/instrument-frame';
import { Reveal } from '@/components/reveal';

interface PlanNode {
  op: string;
  cost: [number, number];
  rows: number;
  width?: number;
  hot?: boolean;
  detail?: string;
  children?: PlanNode[];
}

interface Sample {
  id: string;
  label: string;
  query: string;
  total: number; // ms
  planned: number; // ms
  plan: PlanNode;
}

const SAMPLES: Sample[] = [
  {
    id: 'revenue',
    label: 'Weekly revenue · top customers',
    query:
      "SELECT o.id, c.name, SUM(oi.qty * oi.unit_price) AS total FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_items oi ON oi.order_id = o.id WHERE o.created_at > now() - interval '7 days' GROUP BY o.id, c.name ORDER BY total DESC LIMIT 25;",
    total: 38.4,
    planned: 0.42,
    plan: {
      op: 'Limit',
      cost: [0.08, 0.42],
      rows: 25,
      detail: 'rows=25 width=72',
      children: [
        {
          op: 'Sort',
          cost: [184, 184],
          rows: 25,
          detail: 'key=total DESC',
          children: [
            {
              op: 'HashAggregate',
              cost: [142, 142],
              rows: 1820,
              detail: 'group by o.id, c.name',
              children: [
                {
                  op: 'Hash Join',
                  cost: [98, 124],
                  rows: 4210,
                  detail: 'oi.order_id = o.id',
                  children: [
                    {
                      op: 'Hash Join',
                      cost: [42, 88],
                      rows: 4210,
                      detail: 'c.id = o.customer_id',
                      children: [
                        {
                          op: 'Index Scan · orders',
                          cost: [0, 36],
                          rows: 4210,
                          hot: true,
                          detail: 'idx_orders_created · 7d window',
                        },
                        {
                          op: 'Seq Scan · customers',
                          cost: [0, 6],
                          rows: 1820,
                          detail: 'fully cached',
                        },
                      ],
                    },
                    {
                      op: 'Index Scan · order_items',
                      cost: [0, 22],
                      rows: 4210,
                      detail: 'idx_oi_order_id',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    id: 'session',
    label: 'Active session lookup',
    query:
      "SELECT u.email, s.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now();",
    total: 0.42,
    planned: 0.05,
    plan: {
      op: 'Nested Loop',
      cost: [0, 0.42],
      rows: 1,
      detail: 'one match expected',
      children: [
        {
          op: 'Index Scan · sessions',
          cost: [0, 0.18],
          rows: 1,
          detail: 'uniq_token_hash',
        },
        {
          op: 'Index Scan · users',
          cost: [0, 0.16],
          rows: 1,
          detail: 'pkey',
        },
      ],
    },
  },
  {
    id: 'cohort',
    label: 'Cohort retention · 30d',
    query:
      "SELECT date_trunc('week', signup_at) AS cohort, COUNT(DISTINCT user_id) FILTER (WHERE last_seen > signup_at + interval '30d') AS retained FROM events GROUP BY 1 ORDER BY 1;",
    total: 1240,
    planned: 8.1,
    plan: {
      op: 'Sort',
      cost: [824, 980],
      rows: 12,
      detail: 'key=cohort',
      children: [
        {
          op: 'GroupAggregate',
          cost: [610, 712],
          rows: 12,
          detail: 'group by week',
          children: [
            {
              op: 'Bitmap Heap Scan · events',
              cost: [120, 540],
              rows: 4_120_000,
              hot: true,
              detail: '12.4M heap pages · cold',
              children: [
                {
                  op: 'Bitmap Index Scan',
                  cost: [0, 80],
                  rows: 4_120_000,
                  detail: 'idx_events_signup_at',
                },
              ],
            },
          ],
        },
      ],
    },
  },
];

/**
 * EXPLAIN Theatre — three sample queries, one live plan tree. Picking a
 * tab unfolds the plan node-by-node with stagger; hot nodes flash red,
 * each node carries cost + row estimates. Bottom rail: planned vs actual.
 */
export function ExplainTheatre() {
  const [active, setActive] = useState(SAMPLES[0].id);
  const sample = SAMPLES.find((s) => s.id === active) ?? SAMPLES[0];
  const flat = flatten(sample.plan, 0);
  const maxCost = Math.max(...flat.map((n) => n.node.cost[1]));

  return (
    <section
      id="explain"
      className="relative px-4 md:px-8 py-[14vh] border-b border-line-strong lab-grid-fine"
    >
      <div className="mx-auto max-w-[1440px]">
        <Reveal>
          <div className="grid grid-cols-12 gap-6 mb-12 items-end">
            <div className="col-span-12 md:col-span-9">
              <div className="sec-no mb-5">¶ 04 — EXPLAIN theatre</div>
              <h2
                className="font-display leading-[0.92] tracking-[-0.04em]"
                style={{
                  fontSize: 'clamp(40px, 7vw, 120px)',
                  fontVariationSettings: '"opsz" 96, "wdth" 100, "wght" 700',
                }}
              >
                Read your plan{' '}
                <span className="text-plasma">like a page</span>.
              </h2>
              <p className="mt-4 text-fg/70 max-w-[60ch] font-sans text-[16px] leading-relaxed">
                Postgres&apos; EXPLAIN tree, rendered as something a human can
                actually read. Click a sample query — Plasma annotates each
                node with cost, row estimate, and the hot path your query
                spent its night on.
              </p>
            </div>
            <div className="col-span-12 md:col-span-3 self-end label">
              cost = startup..total <br />
              rows = estimate <br />
              <span className="text-ox">●</span> = hot node
            </div>
          </div>
        </Reveal>

        {/* Sample tabs */}
        <div className="flex flex-wrap gap-px bg-line-strong border border-line-strong">
          {SAMPLES.map((s) => {
            const isActive = s.id === active;
            return (
              <button
                key={s.id}
                type="button"
                data-cursor={`run · ${s.id}`}
                onClick={() => setActive(s.id)}
                className={`flex-1 min-w-[200px] flex items-center justify-between gap-3 px-5 py-3 transition-colors ${
                  isActive
                    ? 'bg-bg-2 text-fg'
                    : 'bg-bg text-dim hover:text-fg'
                }`}
                aria-pressed={isActive}
              >
                <span className="flex items-center gap-3">
                  <span
                    className={`block h-2 w-2 rounded-full ${
                      isActive
                        ? 'bg-plasma shadow-[0_0_10px_var(--plasma)]'
                        : 'bg-faint'
                    }`}
                  />
                  <span className="label label-strong">{s.label}</span>
                </span>
                <span className="label">{s.total} ms</span>
              </button>
            );
          })}
        </div>

        <InstrumentFrame
          index="04·PLAN"
          title={`explain analyze · ${sample.id}`}
          meta={`planned ${sample.planned} ms · executed ${sample.total} ms`}
          accent="plasma"
        >
          <div className="bg-bg-2">
            {/* Query header */}
            <div className="px-5 md:px-8 py-4 border-b border-line">
              <div className="label mb-2">query</div>
              <pre className="font-mono text-[12.5px] text-fg/85 whitespace-pre-wrap break-words leading-relaxed">
                {sample.query}
              </pre>
            </div>

            {/* Tree */}
            <div className="px-5 md:px-8 py-6 md:py-10">
              <div className="label mb-5 flex items-center justify-between">
                <span>plan tree</span>
                <span>{flat.length} nodes</span>
              </div>
              <div className="space-y-1.5">
                {flat.map((entry, i) => (
                  <PlanRow
                    key={`${active}-${i}`}
                    {...entry}
                    delay={i * 80}
                    maxCost={maxCost}
                  />
                ))}
              </div>
            </div>

            {/* Footer rail */}
            <div className="px-5 md:px-8 py-4 border-t border-line grid grid-cols-3 gap-4 label">
              <div>
                <span className="label">planning · </span>
                <span className="text-fg">{sample.planned} ms</span>
              </div>
              <div className="text-center">
                <span className="label">execution · </span>
                <span className="text-plasma label-plasma">
                  {sample.total} ms
                </span>
              </div>
              <div className="text-right">
                <span className="label">hot · </span>
                <span className="text-ox">
                  {flat.filter((f) => f.node.hot).length} node
                  {flat.filter((f) => f.node.hot).length === 1 ? '' : 's'}
                </span>
              </div>
            </div>
          </div>
        </InstrumentFrame>
      </div>
    </section>
  );
}

interface FlatEntry {
  node: PlanNode;
  depth: number;
  isLast: boolean;
}

function flatten(node: PlanNode, depth: number, isLast = true): FlatEntry[] {
  const out: FlatEntry[] = [{ node, depth, isLast }];
  const kids = node.children ?? [];
  kids.forEach((k, i) => {
    out.push(...flatten(k, depth + 1, i === kids.length - 1));
  });
  return out;
}

function PlanRow({
  node,
  depth,
  delay,
  maxCost,
}: FlatEntry & { delay: number; maxCost: number }) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(id);
  }, [delay]);

  const fillPct = Math.min(100, Math.round((node.cost[1] / maxCost) * 100));
  const tree = '│  '.repeat(Math.max(0, depth - 1)) + (depth > 0 ? '└─ ' : '');

  return (
    <div
      className={`grid grid-cols-12 gap-3 items-baseline transition-all duration-500 ${
        shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'
      }`}
    >
      {/* Tree gutter + op */}
      <div className="col-span-12 md:col-span-5 flex items-baseline gap-2 font-mono text-[13px]">
        <span className="text-faint whitespace-pre">{tree}</span>
        {node.hot && (
          <span
            className="block h-1.5 w-1.5 rounded-full bg-ox shrink-0 mt-1"
            style={{ boxShadow: '0 0 8px var(--ox)' }}
          />
        )}
        <span className={node.hot ? 'text-ox' : 'text-fg'}>{node.op}</span>
      </div>

      {/* Cost bar */}
      <div className="col-span-7 md:col-span-3 flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-line">
          <div
            className={`h-full transition-all duration-700 ${
              node.hot ? 'bg-ox' : 'bg-plasma'
            }`}
            style={{
              width: shown ? `${fillPct}%` : '0%',
              boxShadow: node.hot
                ? '0 0 8px var(--ox)'
                : '0 0 8px var(--plasma)',
            }}
          />
        </div>
        <span className="label tabular-nums w-16 text-right">
          {node.cost[1] < 1
            ? node.cost[1].toFixed(2)
            : node.cost[1].toFixed(0)}
        </span>
      </div>

      {/* Rows */}
      <div className="col-span-5 md:col-span-2 label tabular-nums">
        {formatRows(node.rows)} rows
      </div>

      {/* Detail */}
      <div className="col-span-12 md:col-span-2 label truncate">
        {node.detail ?? '—'}
      </div>
    </div>
  );
}

function formatRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
