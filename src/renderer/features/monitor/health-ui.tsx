import { Button } from '@/components/ui/button';
import { type DataColumn, DataTable } from '@/components/ui/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge, EmptyState, SectionHeading } from '@/components/ui/view-parts';
import { cn } from '@/lib/cn';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type {
  CheckResult,
  HealthAction,
  HealthFinding,
  HealthStatus,
  HealthTable,
} from '@shared/health/types';
import { splitSqlStatements } from '@shared/sql-statements';
import { Copy, FileCode2, Loader2 } from 'lucide-react';
import { useState } from 'react';

export const STATUS_COLOR: Record<HealthStatus, string> = {
  ok: 'var(--status-local)',
  warn: 'var(--status-staging)',
  crit: 'var(--status-prod)',
  unknown: 'var(--wb-text-3)',
};

export const STATUS_LABEL: Record<HealthStatus, string> = {
  ok: 'Healthy',
  warn: 'Warning',
  crit: 'Critical',
  unknown: 'Unavailable',
};

export function StatusDot({ status, className }: { status: HealthStatus; className?: string }) {
  return (
    <span
      role="img"
      aria-label={STATUS_LABEL[status]}
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', className)}
      style={{ background: STATUS_COLOR[status] }}
    />
  );
}

/** One tile of the overview strip. */
export function HealthTile({
  label,
  status,
  summary,
  loading,
  onClick,
}: {
  label: string;
  status: HealthStatus;
  summary: string;
  loading?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label}: ${summary}`}
      className="min-w-0 rounded-[8px] bg-[var(--wb-control)] px-3 py-2 text-left hover:bg-[var(--wb-control-hover)]"
      style={{ boxShadow: `inset 3px 0 0 ${loading ? 'var(--wb-text-3)' : STATUS_COLOR[status]}` }}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--wb-text-2)]">
        {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <StatusDot status={status} />}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-0.5 truncate text-[12px] text-[var(--wb-text)]">
        {loading ? 'Checking…' : summary}
      </div>
    </button>
  );
}

export function TileStrip({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="grid shrink-0 gap-2 border-b border-[var(--wb-separator)] px-3 py-2.5"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}
    >
      {children}
    </div>
  );
}

/** A fix waiting in the Preview SQL dialog. */
export interface PendingFix {
  title: string;
  action: HealthAction;
}

export function FindingRow({
  finding,
  onFix,
}: {
  finding: HealthFinding;
  onFix: (fix: PendingFix) => void;
}) {
  const a = finding.action;
  return (
    <li className="flex items-start gap-2 border-b border-[var(--wb-separator)] px-4 py-2 last:border-b-0">
      <StatusDot status={finding.status} className="mt-[5px]" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-[var(--wb-text)]">{finding.title}</div>
        <div className="mt-0.5 break-words text-[12px] text-[var(--wb-text-2)]">
          {finding.evidence}
        </div>
        {a?.note && !a.sql && (
          <div className="mt-1 text-[12px] text-[var(--wb-text-2)]">
            <span className="font-medium text-[var(--wb-text)]">{a.label}: </span>
            {a.note}
          </div>
        )}
        {a?.note && a.sql && (
          <div className="mt-1 text-[12px] text-[var(--wb-text-2)]">{a.note}</div>
        )}
      </div>
      {a?.sql && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onFix({ title: finding.title, action: a })}
        >
          {a.label}…
        </Button>
      )}
    </li>
  );
}

const TABLE_ROW_PX = 24;

export function ResultTable({ table, label }: { table: HealthTable; label: string }) {
  if (table.rows.length === 0) return null;
  const columns: DataColumn<Record<string, unknown>>[] = table.columns.map((c) => ({
    key: c.key,
    label: c.label,
    align: c.align,
    width: c.width,
    render: (row) => String(row[c.key] ?? ''),
    titleOf: (row) => String(row[c.key] ?? ''),
  }));
  const height = Math.min(table.rows.length, 10) * TABLE_ROW_PX + 30;
  return (
    <div
      className="mx-4 mb-3 overflow-hidden rounded-[6px] border border-[var(--wb-separator)]"
      style={{ height }}
    >
      <DataTable
        ariaLabel={label}
        columns={columns}
        rows={table.rows}
        rowKey={(_r, i) => String(i)}
        rowNumbers={false}
        stripeFill={false}
      />
    </div>
  );
}

/** A titled check: verdict badge, findings with fixes, optional detail table. */
export function CheckSection({
  title,
  result,
  loading,
  onFix,
}: {
  title: string;
  result: CheckResult | undefined;
  loading: boolean;
  onFix: (fix: PendingFix) => void;
}) {
  const tone =
    result?.status === 'crit' ? 'danger' : result?.status === 'warn' ? 'warn' : 'neutral';
  return (
    <section aria-label={title}>
      <SectionHeading
        action={
          loading && !result ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--wb-text-3)]" />
          ) : result ? (
            <Badge tone={tone}>
              {result.status === 'unknown' ? result.summary : STATUS_LABEL[result.status]}
            </Badge>
          ) : undefined
        }
      >
        {title}
      </SectionHeading>
      {result && result.status !== 'unknown' && (
        <p className="px-4 pb-1 text-[12px] text-[var(--wb-text-2)]">{result.summary}</p>
      )}
      {result?.status === 'unknown' && (
        <p className="px-4 pb-2 text-[12px] text-[var(--wb-text-3)]">
          {result.findings[0]?.evidence}
        </p>
      )}
      {result && result.status !== 'unknown' && result.findings.length > 0 && (
        <ul className="mx-4 mb-2 overflow-hidden rounded-[6px] border border-[var(--wb-separator)]">
          {result.findings.map((f) => (
            <FindingRow key={f.id} finding={f} onFix={onFix} />
          ))}
        </ul>
      )}
      {result?.table && result.status !== 'unknown' && (
        <ResultTable table={result.table} label={title} />
      )}
      {result?.note && result.status !== 'unknown' && (
        <p className="px-4 pb-2 text-[11px] text-[var(--wb-text-3)]">{result.note}</p>
      )}
    </section>
  );
}

/** Shown when a whole view cannot run (no privilege, extension missing). */
export function UnavailablePanel({ title, hint }: { title: string; hint: React.ReactNode }) {
  return <EmptyState title={title} hint={hint} className="min-h-[120px]" />;
}

/**
 * Preview SQL for a fix. Nothing runs until the user presses Run, and Run
 * passes through the same prod gate / safe mode as the editor. The SQL can
 * also be opened in the editor, where Safe Run and the linter apply.
 */
export function FixDialog({
  fix,
  onClose,
  onDone,
  readOnly,
}: {
  fix: PendingFix | null;
  onClose: () => void;
  onDone: () => void;
  readOnly: boolean;
}) {
  const reuseHistoryQuery = useSession((s) => s.reuseHistoryQuery);
  const confirmUserSqlDetailed = useSession((s) => s.confirmUserSqlDetailed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const sql = fix?.action.sql ?? '';

  const close = () => {
    if (busy) return;
    setError(null);
    setDone(null);
    onClose();
  };

  const run = async () => {
    if (!fix || busy) return;
    setBusy(true);
    setError(null);
    try {
      const gate = await confirmUserSqlDetailed(sql, {
        force: true,
        summary: fix.action.label,
      });
      if (!gate.ok) {
        setError(gate.message);
        return;
      }
      for (const stmt of splitSqlStatements(sql).filter((s) => s.trim())) {
        await ipc.query.sideband(stmt);
      }
      setDone(`${fix.action.label}: done.`);
      onDone();
    } catch (err) {
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={fix !== null} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{fix?.action.label}</DialogTitle>
          <DialogDescription>{fix?.title}</DialogDescription>
        </DialogHeader>
        <div className="text-[12px] font-medium text-[var(--wb-text-2)]">Preview SQL</div>
        <pre
          className="max-h-48 overflow-auto whitespace-pre-wrap rounded-[7px] bg-[var(--wb-field)] p-2 font-mono text-[11.5px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)]"
          aria-label="SQL preview"
        >
          {sql}
        </pre>
        <p className="text-[12px] text-[var(--wb-text-3)]">
          Nothing runs until you press Run. It goes through the production gate and safe mode like
          any statement from the editor.
          {readOnly && ' This connection is read-only, so the fix can only be copied or opened.'}
        </p>
        {error && (
          <p className="text-[12px] text-destructive" role="alert">
            {error}
          </p>
        )}
        {done && <output className="text-[12px] text-[var(--wb-text-2)]">{done}</output>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(sql)}>
            <Copy />
            Copy
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              reuseHistoryQuery(sql);
              close();
            }}
          >
            <FileCode2 />
            Open in editor
          </Button>
          <Button
            variant={fix?.action.destructive ? 'destructive' : 'primary'}
            disabled={readOnly || busy || done !== null}
            onClick={() => void run()}
          >
            {busy ? 'Running…' : 'Run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
