import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { MigrationCheckPanel } from '@/features/migration/MigrationCheckPanel';
import { cn } from '@/lib/cn';
import { formatCountdown, safeRunThreshold, safeRunWarning, statementsLabel } from '@/lib/safe-run';
import { useSession } from '@/stores/session';
import { type SafeRunState, safeRunPending } from '@/stores/session-safe-run';
import type { SafeRunReport } from '@shared/protocol';
import { type SafeRunDiff, buildSafeRunDiff } from '@shared/safe-run-diff';
import { planSafeRunScript } from '@shared/safe-run-script';
import { AlertTriangle, Check, Loader2, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScriptReview } from './ScriptReview';
import { buildColumns } from './diff-columns';

const VERB: Record<SafeRunReport['kind'], { noun: string; verb: string }> = {
  update: { noun: 'UPDATE', verb: 'updated' },
  delete: { noun: 'DELETE', verb: 'deleted' },
  insert: { noun: 'INSERT', verb: 'inserted' },
  merge: { noun: 'MERGE', verb: 'affected' },
  cte: { noun: 'WITH', verb: 'affected' },
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Safe Run review: what the statement did inside its still-open
 * transaction, with Commit and Roll back. Replaces the result grid while a
 * Safe Run exists for the tab, and stays as a receipt after the decision.
 */
export function SafeRunPanel() {
  const sr = useSession((s) => s.safeRun);
  const threshold = useSession((s) => safeRunThreshold(s.settings));
  const commit = useSession((s) => s.commitSafeRun);
  const commitPartial = useSession((s) => s.commitSafeRunPartial);
  const undo = useSession((s) => s.undoSafeRun);
  const rollback = useSession((s) => s.rollbackSafeRun);
  const dismiss = useSession((s) => s.dismissSafeRun);
  const [showUnchanged, setShowUnchanged] = useState(false);

  const report = sr?.report ?? null;
  const diff = useMemo(() => (report ? buildSafeRunDiff(report) : null), [report]);
  const reviewing = sr?.phase === 'review';
  const now = useNow(reviewing);
  const msLeft = report ? report.expiresAt - now : 0;

  // The worker rolls back by itself at the deadline; this tells the UI.
  const expiredFor = useRef<number | null>(null);
  const token = sr?.token ?? null;
  useEffect(() => {
    if (!reviewing || !report || token === null) return;
    if (msLeft <= 0 && expiredFor.current !== token) {
      expiredFor.current = token;
      void rollback('timeout');
    }
  }, [reviewing, report, msLeft, rollback, token]);

  const rows = useMemo(() => {
    if (!diff) return [];
    const hasChange = diff.rows.some((r) => r.status !== 'unchanged');
    return showUnchanged || !hasChange
      ? diff.rows
      : diff.rows.filter((r) => r.status !== 'unchanged');
  }, [diff, showUnchanged]);
  const columns = useMemo(() => (diff ? buildColumns(diff) : []), [diff]);

  // Pulse when something tried to run while this review is open.
  const [pulse, setPulse] = useState(false);
  const nudge = sr?.nudge ?? 0;
  useEffect(() => {
    if (nudge === 0) return;
    setPulse(true);
    const id = setTimeout(() => setPulse(false), 900);
    return () => clearTimeout(id);
  }, [nudge]);

  if (!sr) return null;

  return (
    <section
      aria-label="Safe Run review"
      data-testid="safe-run-panel"
      className="flex min-h-0 flex-1 flex-col bg-[var(--wb-content)]"
    >
      {sr.phase === 'running' && <RunningBar sr={sr} onCancel={() => void rollback('user')} />}
      {sr.phase === 'failed' && <FailedBar sr={sr} onClose={dismiss} />}
      {sr.phase === 'rolledBack' && !report && (
        <div className="flex items-center gap-3 px-4 py-3">
          <output className="min-w-0 flex-1 text-[13px] text-[var(--wb-text-2)]">
            {sr.error ?? 'Cancelled. Nothing was saved.'}
          </output>
          <Button size="pill" variant="secondary" onClick={dismiss}>
            Close
          </Button>
        </div>
      )}
      {report?.steps && (
        <ScriptReview
          sr={sr}
          report={report}
          steps={report.steps}
          threshold={threshold}
          msLeft={msLeft}
          pulse={pulse}
          onCommit={() => void commit()}
          onCommitPartial={() => void commitPartial()}
          onRollback={() => void rollback('user')}
          onUndo={() => void undo()}
          onClose={dismiss}
        />
      )}
      {report && diff && !report.steps && (
        <>
          <ReviewHeader
            sr={sr}
            report={report}
            threshold={threshold}
            msLeft={msLeft}
            pulse={pulse}
          />
          {sr.notice && (
            <p
              role="alert"
              className="border-b border-[var(--wb-separator)] px-4 py-1.5 text-[12px] text-[var(--wb-text)]"
            >
              {sr.notice}
            </p>
          )}
          {report.note && (
            <p className="border-b border-[var(--wb-separator)] bg-[var(--wb-toolbar-group)] px-4 py-1.5 text-[12px] text-[var(--wb-text-2)]">
              {report.note}
            </p>
          )}
          <DataTable
            ariaLabel="Rows changed by the statement"
            columns={columns}
            rows={rows}
            rowKey={(_r, i) => String(i)}
            empty={
              report.affected === 0
                ? 'The statement matched no rows.'
                : 'No rows to show for this statement.'
            }
          />
          <Footer
            sr={sr}
            report={report}
            diff={diff}
            showUnchanged={showUnchanged}
            onToggleUnchanged={() => setShowUnchanged((v) => !v)}
            threshold={threshold}
            onCommit={() => void commit()}
            onRollback={() => void rollback('user')}
            onClose={dismiss}
          />
        </>
      )}
    </section>
  );
}

function RunningBar({ sr, onCancel }: { sr: SafeRunState; onCancel: () => void }) {
  const plan = useMemo(() => planSafeRunScript(sr.sql), [sr.sql]);
  const count = plan.ok ? plan.statements.length : 1;
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--wb-text-2)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-[var(--wb-text)]">
          {count > 1
            ? `Running ${statementsLabel(count)} inside one transaction. Nothing is saved yet.`
            : 'Running inside a transaction. Nothing is saved yet.'}
        </div>
        <div className="truncate font-mono text-[12px] text-[var(--wb-text-3)]">{sr.sql}</div>
      </div>
      <Button size="pill" variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function FailedBar({ sr, onClose }: { sr: SafeRunState; onClose: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--wb-danger-fill)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--wb-text)]">
          {sr.outcomeUnknown ? 'Outcome unknown' : 'Safe Run did not finish'}
        </div>
        <div className="whitespace-pre-wrap text-[13px] text-[var(--wb-text-2)]">{sr.error}</div>
        <div className="mt-1 truncate font-mono text-[12px] text-[var(--wb-text-3)]">{sr.sql}</div>
        {/* Safe Run is DML-only; for DDL show what a normal Run would do. */}
        <MigrationCheckPanel sql={sr.sql} className="mt-2" />
      </div>
      <Button size="pill" variant="secondary" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

function ReviewHeader({
  sr,
  report,
  threshold,
  msLeft,
  pulse,
}: {
  sr: SafeRunState;
  report: SafeRunReport;
  threshold: number;
  msLeft: number;
  pulse: boolean;
}) {
  const kind = VERB[report.kind];
  const warning = safeRunWarning(
    report.affected,
    report.estimateRows,
    threshold,
    report.affectedExact,
  );
  const pending = safeRunPending(sr);
  return (
    <header
      className={cn(
        'shrink-0 border-b border-[var(--wb-separator)] px-4 py-3 transition-shadow',
        pulse && 'shadow-[inset_0_0_0_2px_var(--status-warn)]',
      )}
    >
      <div className="flex items-start gap-5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--wb-text-3)]">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            Safe Run · {kind.noun}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className="text-[32px] font-semibold leading-none tabular-nums text-[var(--wb-text)]"
              data-testid="safe-run-count"
            >
              {report.affected.toLocaleString('en-US')}
              {report.affectedExact ? '' : '+'}
            </span>
            <span className="text-[13px] text-[var(--wb-text-2)]">
              {report.affected === 1 ? 'row' : 'rows'} will be {kind.verb}
            </span>
          </div>
        </div>

        <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-[12px]">
          <dt className="text-[var(--wb-text-3)]">Planner estimate</dt>
          <dd className="font-mono tabular-nums text-[var(--wb-text)]">
            {report.estimateRows === null
              ? 'n/a'
              : `~${Math.round(report.estimateRows).toLocaleString('en-US')} rows`}
          </dd>
          <dt className="text-[var(--wb-text-3)]">Ran in</dt>
          <dd className="font-mono tabular-nums text-[var(--wb-text)]">{report.durationMs} ms</dd>
          {pending && sr.phase === 'review' && (
            <>
              <dt className="text-[var(--wb-text-3)]">Rolls back in</dt>
              <dd
                className={cn(
                  'font-mono tabular-nums',
                  msLeft < 30_000 ? 'text-[var(--status-warn)]' : 'text-[var(--wb-text)]',
                )}
                data-testid="safe-run-countdown"
              >
                {formatCountdown(msLeft)}
              </dd>
            </>
          )}
        </dl>

        <div className="min-w-0 flex-1 self-center">
          <div
            className="truncate font-mono text-[12px] text-[var(--wb-text-3)]"
            title={report.statement}
          >
            {report.statement}
          </div>
          <div className="mt-0.5 text-[12px] text-[var(--wb-text-2)]">
            {report.nested
              ? 'Inside your open transaction (a savepoint). Commit keeps it in that transaction; it is saved to the database when you commit the transaction.'
              : 'Held in a transaction on the primary connection. Other statements wait until you decide.'}
          </div>
        </div>
      </div>

      {warning.messages.length > 0 && (
        <div
          role="alert"
          className="mt-2 flex items-start gap-2 rounded-[6px] bg-[color-mix(in_srgb,var(--status-warn)_18%,transparent)] px-2.5 py-1.5 text-[12px] text-[var(--wb-text)]"
        >
          <AlertTriangle
            className="mt-px h-3.5 w-3.5 shrink-0 text-[var(--status-warn)]"
            aria-hidden
          />
          <div>
            {warning.messages.map((m) => (
              <div key={m}>{m}</div>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}

function pairingCaption(report: SafeRunReport, diff: SafeRunDiff): string | null {
  if (report.kind !== 'update' || report.mode !== 'diff') return null;
  if (diff.pairing === 'ctid-order') {
    return 'No primary key: rows are matched by their position in the table.';
  }
  if (!diff.paired && diff.pairing === 'none' && diff.rows.length > 0) {
    return 'Rows could not be matched one to one, so old and new rows are listed separately.';
  }
  return null;
}

function Footer({
  sr,
  report,
  diff,
  showUnchanged,
  onToggleUnchanged,
  threshold,
  onCommit,
  onRollback,
  onClose,
}: {
  sr: SafeRunState;
  report: SafeRunReport;
  diff: SafeRunDiff;
  showUnchanged: boolean;
  onToggleUnchanged: () => void;
  threshold: number;
  onCommit: () => void;
  onRollback: () => void;
  onClose: () => void;
}) {
  const large = report.affected > threshold;
  const busy = sr.phase === 'finishing';
  const total = report.affected;
  const partial = diff.rows.length < total ? diff.rows.length : null;
  const caption = pairingCaption(report, diff);
  const label = `${total.toLocaleString('en-US')}${report.affectedExact ? '' : '+'} ${total === 1 ? 'row' : 'rows'}`;

  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-[var(--wb-separator)] bg-[var(--wb-toolbar-group)] px-4 py-2">
      <div className="min-w-0 flex-1 text-[12px] text-[var(--wb-text-2)]">
        {partial !== null && (
          <span>
            Showing {partial.toLocaleString('en-US')} of {total.toLocaleString('en-US')} rows.{' '}
          </span>
        )}
        {diff.unchangedCount > 0 && (
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={onToggleUnchanged}
          >
            {showUnchanged
              ? 'Hide unchanged rows'
              : `${diff.unchangedCount.toLocaleString('en-US')} unchanged ${diff.unchangedCount === 1 ? 'row' : 'rows'} hidden`}
          </button>
        )}
        {caption && <span> {caption}</span>}
        {sr.phase === 'review' && (
          <span className="block text-[var(--wb-text-3)]">
            Other statements on this connection are paused until you decide.
          </span>
        )}
        {sr.phase === 'committed' && (
          <span className="inline-flex items-center gap-1 text-[var(--wb-text)]">
            <Check className="h-3.5 w-3.5" aria-hidden />
            Committed {label}.
          </span>
        )}
        {sr.phase === 'rolledBack' && (
          <output className="text-[var(--wb-text)]">
            {sr.error ??
              (sr.endReason === 'timeout'
                ? 'Rolled back automatically. Nothing was saved.'
                : 'Rolled back. Nothing was saved.')}
          </output>
        )}
      </div>

      {(sr.phase === 'review' || busy) && (
        <>
          <Button
            variant="secondary"
            size="default"
            disabled={busy}
            onClick={onRollback}
            autoFocus
            data-testid="safe-run-rollback"
          >
            <RotateCcw aria-hidden />
            Roll back
          </Button>
          <Button
            variant={large ? 'destructive' : 'primary'}
            size="default"
            disabled={busy}
            onClick={onCommit}
            data-testid="safe-run-commit"
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
            Commit {label}
          </Button>
        </>
      )}
      {(sr.phase === 'committed' || sr.phase === 'rolledBack') && (
        <Button variant="secondary" size="default" onClick={onClose}>
          <X aria-hidden />
          Close
        </Button>
      )}
    </footer>
  );
}
