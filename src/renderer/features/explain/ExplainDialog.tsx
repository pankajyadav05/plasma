import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Pill } from '@/components/ui/workbench';
import { ExplainPlanAi } from '@/features/ai/ExplainPlanAi';
import { cn } from '@/lib/cn';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { inlineVariables, runBound } from '@/lib/query-variables';
import { useSession } from '@/stores/session';
import { looksLikeWrite } from '@/stores/session-sql-heuristics';
import type { ExplainNode } from '@shared/protocol';
import type { VariableValues } from '@shared/sql-variables';
import { Check, ChevronDown, ChevronRight, Copy, Loader2, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Query plan viewer (F2 / A4 / E7 / VF29).
 *
 * Opening the dialog runs a plain `EXPLAIN (VERBOSE, FORMAT JSON)`, which
 * never executes the statement. "Run with ANALYZE" is opt-in: the worker
 * executes the statement inside a transaction (or savepoint) that is
 * always rolled back, so writes are undone. Data-changing statements
 * still go through the prod-tag confirmation, and read-only connections
 * refuse ANALYZE for them. Closing the dialog cancels a running ANALYZE.
 */
export function ExplainDialog({
  sql,
  open,
  onOpenChange,
  variables,
}: {
  sql: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Query variable values; `:name` placeholders in `sql` are bound from these. */
  variables?: VariableValues;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ExplainNode | null>(null);
  const [rawPlan, setRawPlan] = useState<unknown>(null);
  const [analyzed, setAnalyzed] = useState(false);
  const [planMs, setPlanMs] = useState<number | null>(null);
  const [execMs, setExecMs] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const runId = useRef(0);
  const analyzing = useRef(false);
  const readOnly = useSession((s) => Boolean(s.activeConfig?.readOnly));
  const confirmUserSql = useSession((s) => s.confirmUserSqlDetailed);
  const values = useMemo(() => variables ?? {}, [variables]);
  // What would really run (raw values pasted in) decides write detection and the gate.
  const effectiveSql = inlineVariables(sql, values);
  const writes = looksLikeWrite(effectiveSql);

  const run = useCallback(
    async (analyze: boolean) => {
      const id = ++runId.current;
      setError(null);
      if (analyze && writes) {
        if (readOnly) {
          setError('This connection is read-only, so ANALYZE is off for data-changing statements.');
          return;
        }
        const outcome = await confirmUserSql(effectiveSql, {
          force: true,
          summary: 'EXPLAIN ANALYZE (rolled back)',
        });
        if (!outcome.ok) {
          if (outcome.reason === 'refused' && id === runId.current) setError(outcome.message);
          return;
        }
        if (id !== runId.current) return;
      }
      setLoading(true);
      analyzing.current = analyze;
      try {
        const res = await runBound(sql, values, (text, params) =>
          ipc.query.explain({ sql: text, analyze, params }),
        );
        if (id !== runId.current) return;
        // FORMAT JSON comes back as one json cell (parsed) or its text.
        const raw = res.rows[0]?.[0];
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const root = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!root || typeof root !== 'object') throw new Error('unexpected EXPLAIN payload');
        setRawPlan(parsed);
        setPlan((root.Plan ?? root) as ExplainNode);
        setAnalyzed(analyze);
        setPlanMs(typeof root['Planning Time'] === 'number' ? root['Planning Time'] : null);
        setExecMs(typeof root['Execution Time'] === 'number' ? root['Execution Time'] : null);
      } catch (err) {
        if (id === runId.current)
          setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
      } finally {
        if (id === runId.current) {
          setLoading(false);
          analyzing.current = false;
        }
      }
    },
    [sql, values, effectiveSql, writes, readOnly, confirmUserSql],
  );

  // Plain EXPLAIN on open — safe, nothing executes.
  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setRawPlan(null);
    setAnalyzed(false);
    setPlanMs(null);
    setExecMs(null);
    setAiOpen(false);
    void run(false);
    return () => {
      runId.current++;
      // A running ANALYZE executes on the server — stop it, don't just
      // ignore its answer.
      if (analyzing.current) void ipc.query.cancel().catch(() => undefined);
      analyzing.current = false;
    };
  }, [open, run]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(rawPlan, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const totalActualMs = plan ? collectMaxActual(plan) : 0;
  const analyzeRunning = loading && analyzing.current;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {analyzed ? 'Query plan with timing' : 'Query plan'}
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--wb-text-2)]" />}
          </DialogTitle>
          {!analyzed && (
            <p className="text-[12px] text-[var(--wb-text-2)]">
              {analyzeRunning
                ? 'Running the statement for timing. Its changes are rolled back. Close to cancel.'
                : writes
                  ? 'Estimated plan. Running with ANALYZE executes this statement inside a transaction that is rolled back.'
                  : 'Estimated plan. Run with ANALYZE to execute the query and see real timings.'}
            </p>
          )}
        </DialogHeader>

        <div className="-mx-2 max-h-[68vh] overflow-y-auto px-2">
          {error && (
            <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-xs text-destructive">
              {error}
            </div>
          )}
          {plan && (
            <>
              {analyzed && (
                <div className="mb-3 grid grid-cols-3 gap-2 text-[11px]">
                  <Stat label="Planning" value={fmtMs(planMs)} />
                  <Stat label="Execution" value={fmtMs(execMs)} />
                  <Stat label="Total" value={fmtMs((planMs ?? 0) + (execMs ?? 0))} />
                </div>
              )}
              <PlanNode node={plan} depth={0} totalActualMs={totalActualMs} />
              {aiOpen && (
                <ExplainPlanAi
                  key={analyzed ? 'analyzed' : 'estimated'}
                  sql={sql}
                  plan={rawPlan}
                  analyzed={analyzed}
                  onOpened={() => onOpenChange(false)}
                />
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-3">
          <Pill onClick={() => void onCopy()} disabled={!rawPlan} title="Copy the plan as JSON">
            {copied ? <Check /> : <Copy />}
            Copy JSON
          </Pill>
          <Pill
            onClick={() => setAiOpen(true)}
            disabled={!rawPlan || aiOpen}
            title="Plain-English walk-through of this plan, with index suggestions"
          >
            <Sparkles />
            Explain with AI
          </Pill>
          <div className="flex-1" />
          {!analyzed && (
            <Pill
              onClick={() => void run(true)}
              disabled={loading || (writes && readOnly)}
              title={
                writes && readOnly
                  ? 'Read-only connection'
                  : 'Execute the statement (rolled back) and show real timings'
              }
            >
              Run with ANALYZE
            </Pill>
          )}
          <Pill onClick={() => onOpenChange(false)}>Close</Pill>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
      <div className="text-[11px] text-[var(--wb-text-2)]">{label}</div>
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
          className="absolute inset-y-0 left-0 w-[3px] rounded-l-md bg-destructive"
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
            <span className="font-mono text-[11px] text-[var(--wb-text-2)]">
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
          {typeof node['Actual Rows'] === 'number' && (
            <Detail label="rows actual">{actualRows.toLocaleString()}</Detail>
          )}
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
      <span>{label}</span>
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
