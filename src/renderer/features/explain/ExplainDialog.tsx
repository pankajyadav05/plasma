import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import type { ExplainNode } from '@shared/protocol';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * EXPLAIN ANALYZE viewer.
 *
 * Wraps the user's SQL in `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)`,
 * parses the JSON tree, and renders a collapsible plan with hot nodes
 * highlighted by their share of total time. Each node shows: type,
 * relation, planned vs actual rows (with mis-estimate factor), shared
 * read/hit blocks, and a delta bar relative to the slowest node.
 *
 * IMPORTANT: ANALYZE actually executes the query, including any
 * mutations. We surface a one-line warning under the title so the user
 * doesn't accidentally run an EXPLAIN ANALYZE against a DELETE.
 */
export function ExplainDialog({
  sql,
  open,
  onOpenChange,
}: {
  sql: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ExplainNode | null>(null);
  const [planMs, setPlanMs] = useState<number | null>(null);
  const [execMs, setExecMs] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPlan(null);
    setPlanMs(null);
    setExecMs(null);

    (async () => {
      try {
        const stripped = sql.trim().replace(/;\s*$/, '');
        const wrapped = `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${stripped}`;
        const res = await ipc.query.run(wrapped, undefined, { internal: true });
        if (cancelled) return;
        // Postgres returns the JSON plan in a single-row, single-column
        // result. The driver may already JSON.parse it (jsonb) or hand
        // back a string — handle both.
        const raw = res.rows[0]?.[0];
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const root = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!root || typeof root !== 'object') {
          throw new Error('unexpected EXPLAIN payload');
        }
        const planRoot = (root.Plan ?? root) as ExplainNode;
        setPlan(planRoot);
        setPlanMs(typeof root['Planning Time'] === 'number' ? root['Planning Time'] : null);
        setExecMs(typeof root['Execution Time'] === 'number' ? root['Execution Time'] : null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, sql]);

  const totalActualMs = plan ? collectMaxActual(plan) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            EXPLAIN ANALYZE
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </DialogTitle>
          <p className="font-display text-[11px] italic text-muted-foreground">
            Runs the query for real (including mutations). Cancel to abort.
          </p>
        </DialogHeader>

        <div className="-mx-2 max-h-[68vh] overflow-y-auto px-2">
          {error && (
            <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-xs text-destructive">
              {error}
            </div>
          )}
          {plan && (
            <>
              <div className="mb-3 grid grid-cols-3 gap-2 text-[11px]">
                <Stat label="Planning" value={fmtMs(planMs)} />
                <Stat label="Execution" value={fmtMs(execMs)} />
                <Stat label="Total" value={fmtMs((planMs ?? 0) + (execMs ?? 0))} />
              </div>
              <PlanNode node={plan} depth={0} totalActualMs={totalActualMs} />
            </>
          )}
        </div>

        <div className="flex justify-end pt-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
      <div className="font-display text-[10px] uppercase italic text-muted-foreground">{label}</div>
      <div className="font-mono tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function PlanNode({
  node,
  depth,
  totalActualMs,
}: {
  node: ExplainNode;
  depth: number;
  totalActualMs: number;
}) {
  const [open, setOpen] = useState(true);
  const children = node.Plans ?? [];
  const hasChildren = children.length > 0;
  const actual =
    typeof node['Actual Total Time'] === 'number' && typeof node['Actual Loops'] === 'number'
      ? node['Actual Total Time'] * node['Actual Loops']
      : null;
  const heatPct = actual && totalActualMs > 0 ? Math.min(100, (actual / totalActualMs) * 100) : 0;
  const planRows = node['Plan Rows'] ?? 0;
  const actualRows = (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1);
  const misestimate = planRows > 0 && actualRows > 0 ? actualRows / planRows : null;
  const skewBad = misestimate !== null && (misestimate >= 10 || misestimate <= 0.1);

  return (
    <div className="relative" style={{ paddingLeft: depth === 0 ? 0 : 16 }}>
      {depth > 0 && <span aria-hidden className="absolute left-2 top-0 h-full w-px bg-border" />}
      <div
        className={cn(
          'relative my-1 rounded-md border border-border bg-background px-3 py-2 text-sm',
          heatPct >= 50 && 'border-destructive/40 bg-destructive/5',
        )}
      >
        {/* Heat bar — left-edge red stripe scaled to time share. */}
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px] rounded-l-md bg-primary/60"
          style={{ opacity: 0.2 + (heatPct / 100) * 0.8 }}
        />
        <div className="flex items-center gap-2">
          {hasChildren && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="grid h-4 w-4 place-items-center text-muted-foreground"
              aria-label={open ? 'Collapse' : 'Expand'}
            >
              {open ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <span className="font-mono text-[13px] font-medium text-foreground">
            {String(node['Node Type'])}
          </span>
          {node['Relation Name'] && (
            <span className="font-mono text-[11px] text-muted-foreground">
              on {String(node['Relation Name'])}
            </span>
          )}
          {node['Index Name'] && (
            <span className="font-mono text-[11px] text-primary">
              using {String(node['Index Name'])}
            </span>
          )}
          <div className="flex-1" />
          {actual !== null && (
            <span className="font-mono tabular-nums text-[11px] text-foreground">
              {fmtMs(actual)}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 pl-6 font-mono text-[10px] text-muted-foreground">
          <Detail label="rows planned">{planRows.toLocaleString()}</Detail>
          <Detail label="rows actual">{actualRows.toLocaleString()}</Detail>
          {misestimate !== null && (
            <Detail label="misestimate" tone={skewBad ? 'bad' : undefined}>
              ×{misestimate >= 1 ? misestimate.toFixed(1) : misestimate.toFixed(2)}
            </Detail>
          )}
          {typeof node['Shared Hit Blocks'] === 'number' && (
            <Detail label="hit">{node['Shared Hit Blocks']}</Detail>
          )}
          {typeof node['Shared Read Blocks'] === 'number' && node['Shared Read Blocks'] > 0 && (
            <Detail label="read" tone="bad">
              {node['Shared Read Blocks']}
            </Detail>
          )}
          {typeof node['Total Cost'] === 'number' && (
            <Detail label="cost">{node['Total Cost'].toFixed(0)}</Detail>
          )}
        </div>
      </div>
      {hasChildren && open && (
        <div>
          {children.map((c, i) => (
            <PlanNode
              // biome-ignore lint/suspicious/noArrayIndexKey: tree position is stable for a single render
              key={i}
              node={c}
              depth={depth + 1}
              totalActualMs={totalActualMs}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Detail({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: 'bad';
  children: React.ReactNode;
}) {
  return (
    <span className={cn('inline-flex items-baseline gap-1', tone === 'bad' && 'text-destructive')}>
      <span className="font-display italic">{label}</span>
      <span className="tabular-nums">{children}</span>
    </span>
  );
}

function fmtMs(v: number | null): string {
  if (v == null) return '—';
  if (v < 1) return `${v.toFixed(2)} ms`;
  if (v < 1000) return `${v.toFixed(1)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

function collectMaxActual(node: ExplainNode): number {
  const self =
    typeof node['Actual Total Time'] === 'number' && typeof node['Actual Loops'] === 'number'
      ? node['Actual Total Time'] * node['Actual Loops']
      : 0;
  let max = self;
  for (const c of node.Plans ?? []) {
    max = Math.max(max, collectMaxActual(c));
  }
  return max;
}
