import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { cn } from '@/lib/cn';
import {
  formatCountdown,
  partialCommitLabel,
  pendingStatementCount,
  rowsLabel,
  safeRunWarning,
  statementsLabel,
} from '@/lib/safe-run';
import { type SafeRunState, safeRunPending } from '@/stores/session-safe-run';
import { SAFE_RUN_TOTAL_ROW_CAP, type SafeRunReport, type SafeRunStep } from '@shared/protocol';
import { buildSafeRunDiff } from '@shared/safe-run-diff';
import { firstLine } from '@shared/safe-run-script';
import {
  AlertTriangle,
  Check,
  Loader2,
  Minus,
  RotateCcw,
  ShieldCheck,
  Undo2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildColumns } from './diff-columns';

interface Props {
  sr: SafeRunState;
  report: SafeRunReport;
  steps: SafeRunStep[];
  threshold: number;
  msLeft: number;
  pulse: boolean;
  onCommit: () => void;
  onCommitPartial: () => void;
  onRollback: () => void;
  onUndo: () => void;
  onClose: () => void;
}

const STATUS_LABEL: Record<SafeRunStep['status'], string> = {
  done: 'done',
  failed: 'failed',
  notRun: 'not run',
};

function StatusIcon({ status }: { status: SafeRunStep['status'] }) {
  const common = 'h-3.5 w-3.5 shrink-0';
  if (status === 'done') {
    return (
      <Check
        className={cn(common, 'text-[var(--wb-accent-text)]')}
        role="img"
        aria-label={STATUS_LABEL[status]}
      />
    );
  }
  if (status === 'failed') {
    return (
      <AlertTriangle
        className={cn(common, 'text-[var(--wb-danger-fill)]')}
        role="img"
        aria-label={STATUS_LABEL[status]}
      />
    );
  }
  return (
    <Minus
      className={cn(common, 'text-[var(--wb-text-3)]')}
      role="img"
      aria-label={STATUS_LABEL[status]}
    />
  );
}

/** The statements of a script as a ruled list; arrows move, Enter selects. */
function StatementList({
  steps,
  selected,
  onSelect,
}: {
  steps: SafeRunStep[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  const refs = useRef(new Map<number, HTMLButtonElement>());
  const [cursor, setCursor] = useState(selected);
  useEffect(() => setCursor(selected), [selected]);
  const cursorAt = steps.some((s) => s.index === cursor) ? cursor : selected;

  const move = (delta: number) => {
    const at = steps.findIndex((s) => s.index === cursorAt);
    const next = steps[Math.max(0, Math.min(steps.length - 1, at + delta))];
    if (!next) return;
    setCursor(next.index);
    refs.current.get(next.index)?.focus();
  };

  return (
    <ol
      aria-label="Statements"
      className="m-0 max-h-[40%] shrink-0 list-none overflow-auto border-b border-[var(--wb-separator)] p-0"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        } else if (e.key === 'Home') {
          e.preventDefault();
          move(-steps.length);
        } else if (e.key === 'End') {
          e.preventDefault();
          move(steps.length);
        }
      }}
    >
      {steps.map((step) => {
        const isSelected = step.index === selected;
        return (
          <li key={step.index} className="border-b border-[var(--wb-separator)] last:border-b-0">
            <button
              type="button"
              ref={(el) => {
                if (el) refs.current.set(step.index, el);
                else refs.current.delete(step.index);
              }}
              tabIndex={step.index === cursorAt ? 0 : -1}
              aria-current={isSelected ? 'true' : undefined}
              data-testid={`safe-run-statement-${step.index}`}
              onClick={() => onSelect(step.index)}
              onFocus={() => setCursor(step.index)}
              className={cn(
                'grid w-full grid-cols-[1.75rem_1rem_minmax(0,1fr)_auto_auto] items-center gap-x-2 px-4 py-1.5 text-left text-[12px] outline-none',
                'focus-visible:shadow-[inset_0_0_0_2px_var(--wb-accent)]',
                isSelected
                  ? 'bg-[var(--wb-toolbar-group)] text-[var(--wb-text)]'
                  : 'text-[var(--wb-text-2)] hover:bg-[var(--wb-toolbar-group)]',
                step.status === 'notRun' && 'text-[var(--wb-text-3)]',
              )}
            >
              <span className="tabular-nums text-[var(--wb-text-3)]">{step.index}</span>
              <StatusIcon status={step.status} />
              <span className="truncate font-mono" title={step.statement}>
                {firstLine(step.statement)}
              </span>
              <span className="tabular-nums">
                {step.status === 'done'
                  ? rowsLabel(step.affected, step.affectedExact)
                  : step.status === 'failed'
                    ? 'failed'
                    : 'not run'}
              </span>
              <span className="w-16 text-right font-mono tabular-nums text-[var(--wb-text-3)]">
                {step.status === 'done' ? `${step.durationMs} ms` : ''}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function StatementDetail({ step }: { step: SafeRunStep }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const diff = useMemo(() => (step.status === 'done' ? buildSafeRunDiff(step) : null), [step]);
  const columns = useMemo(() => (diff ? buildColumns(diff) : []), [diff]);
  const rows = useMemo(() => {
    if (!diff) return [];
    const hasChange = diff.rows.some((r) => r.status !== 'unchanged');
    return showUnchanged || !hasChange
      ? diff.rows
      : diff.rows.filter((r) => r.status !== 'unchanged');
  }, [diff, showUnchanged]);

  const intro = (
    <div className="shrink-0 border-b border-[var(--wb-separator)] px-4 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--wb-text-3)]">
        Statement {step.index}
      </div>
      <pre className="m-0 mt-0.5 max-h-20 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] text-[var(--wb-text-2)]">
        {step.statement}
      </pre>
    </div>
  );

  if (step.status !== 'done' || !diff) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="safe-run-statement-detail">
        {intro}
        <div className="px-4 py-3 text-[13px]">
          {step.status === 'failed' ? (
            <div role="alert" className="flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--wb-danger-fill)]"
                aria-hidden
              />
              <div className="min-w-0">
                <div className="whitespace-pre-wrap text-[var(--wb-text)]">{step.error}</div>
                <div className="mt-1 text-[12px] text-[var(--wb-text-2)]">
                  This statement was rolled back. Nothing it did is kept.
                </div>
              </div>
            </div>
          ) : (
            <span className="text-[var(--wb-text-2)]">
              Not run: an earlier statement failed, so the script stopped.
            </span>
          )}
        </div>
      </div>
    );
  }

  const shown = diff.rows.length;
  const truncated = step.afterTruncated || step.beforeTruncated;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="safe-run-statement-detail">
      {intro}
      {(step.note || step.notices.length > 0) && (
        <p className="m-0 border-b border-[var(--wb-separator)] bg-[var(--wb-toolbar-group)] px-4 py-1.5 text-[12px] text-[var(--wb-text-2)]">
          {step.note}
          {step.notices.map((n) => (
            <span key={n} className="block">
              Notice: {n}
            </span>
          ))}
        </p>
      )}
      <DataTable
        ariaLabel={`Rows changed by statement ${step.index}`}
        columns={columns}
        rows={rows}
        rowKey={(_r, i) => String(i)}
        empty={
          step.affected === 0
            ? 'The statement matched no rows.'
            : truncated
              ? 'No rows kept for this statement: the run keeps a limited number of rows.'
              : 'No rows to show for this statement.'
        }
      />
      <div className="shrink-0 border-t border-[var(--wb-separator)] px-4 py-1 text-[12px] text-[var(--wb-text-2)]">
        {truncated && (
          <span>
            Showing {shown.toLocaleString('en-US')} of {step.affected.toLocaleString('en-US')} rows
            (the run keeps up to {SAFE_RUN_TOTAL_ROW_CAP.toLocaleString('en-US')} rows per side in
            total).{' '}
          </span>
        )}
        {diff.unchangedCount > 0 && (
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => setShowUnchanged((v) => !v)}
          >
            {showUnchanged
              ? 'Hide unchanged rows'
              : `${diff.unchangedCount.toLocaleString('en-US')} unchanged ${diff.unchangedCount === 1 ? 'row' : 'rows'} hidden`}
          </button>
        )}
        <span className="block text-[var(--wb-text-3)]">
          BEFORE rows are as of this point in the script, after the statements above it.
        </span>
      </div>
    </div>
  );
}

function ScriptHeader({
  sr,
  report,
  steps,
  threshold,
  msLeft,
  pulse,
}: Pick<Props, 'sr' | 'report' | 'steps' | 'threshold' | 'msLeft' | 'pulse'>) {
  const warning = safeRunWarning(report.affected, null, threshold, report.affectedExact);
  const failedAt = report.failedAt ?? null;
  const status =
    sr.phase === 'finishing'
      ? sr.finishing === 'undo'
        ? 'Undoing…'
        : sr.finishing === 'rollback'
          ? 'Rolling back…'
          : 'Committing…'
      : failedAt !== null
        ? `Failed at statement ${failedAt}`
        : sr.phase === 'review'
          ? 'Review'
          : sr.phase === 'committed'
            ? 'Committed'
            : 'Rolled back';
  return (
    <header
      className={cn(
        'shrink-0 border-b border-[var(--wb-separator)] px-4 py-3 transition-shadow',
        pulse && 'shadow-[inset_0_0_0_2px_var(--status-warn)]',
      )}
    >
      <div className="flex items-start gap-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--wb-text-3)]">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            <span data-testid="safe-run-summary">
              Safe Run · {statementsLabel(steps.length)} ·{' '}
              {rowsLabel(report.affected, report.affectedExact)} changed in total
            </span>
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <span
              className="text-[32px] font-semibold leading-none tabular-nums text-[var(--wb-text)]"
              data-testid="safe-run-count"
            >
              {report.affected.toLocaleString('en-US')}
              {report.affectedExact ? '' : '+'}
            </span>
            <span className="text-[13px] text-[var(--wb-text-2)]">
              {report.affected === 1 ? 'row' : 'rows'} changed in total
            </span>
            <span
              className={cn(
                'text-[12px] font-medium',
                failedAt !== null ? 'text-[var(--wb-danger-fill)]' : 'text-[var(--wb-text-2)]',
              )}
              data-testid="safe-run-status"
            >
              {status}
            </span>
          </div>
          <div className="mt-1 text-[12px] text-[var(--wb-text-2)]">
            {report.nested
              ? 'Inside your open transaction (a savepoint). Commit keeps it in that transaction; it is saved to the database when you commit the transaction.'
              : 'Held in one transaction on the primary connection. Other statements wait until you decide.'}
          </div>
        </div>
        {safeRunPending(sr) && sr.phase === 'review' && (
          <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-[12px]">
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
          </dl>
        )}
      </div>

      {(warning.messages.length > 0 || sr.notice) && (
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
            {sr.notice && <div>{sr.notice}</div>}
          </div>
        </div>
      )}
    </header>
  );
}

/**
 * Review of a Safe Run script: the statements as a list, the selected
 * statement's BEFORE / AFTER diff, and the decision buttons. Roll back is
 * the default focus; a plain Commit is not offered once a statement failed.
 */
export function ScriptReview(props: Props) {
  const { sr, report, steps, threshold, onCommit, onCommitPartial, onRollback, onUndo, onClose } =
    props;
  const failed = steps.find((s) => s.status === 'failed');
  const [picked, setPicked] = useState<number | null>(null);
  const selected = steps.find((s) => s.index === picked) ?? failed ?? steps[0]!;

  const pendingCount = pendingStatementCount(report);
  const failedAt = report.failedAt ?? null;
  const large = report.affected > threshold;
  const busy = sr.phase === 'finishing';
  const decidable = sr.phase === 'review' || busy;
  const committing = busy && (sr.finishing === 'commit' || sr.finishing === 'commitPartial');
  const total = rowsLabel(report.affected, report.affectedExact);

  return (
    <>
      <ScriptHeader
        sr={sr}
        report={report}
        steps={steps}
        threshold={threshold}
        msLeft={props.msLeft}
        pulse={props.pulse}
      />
      <StatementList steps={steps} selected={selected.index} onSelect={setPicked} />
      <StatementDetail step={selected} key={`${selected.index}-${selected.status}`} />
      <footer className="flex shrink-0 items-center gap-3 border-t border-[var(--wb-separator)] bg-[var(--wb-toolbar-group)] px-4 py-2">
        <div className="min-w-0 flex-1 text-[12px] text-[var(--wb-text-2)]">
          {sr.phase === 'review' && failedAt !== null && (
            <span className="block text-[var(--wb-text)]">
              Statement {failedAt} failed and was rolled back. Nothing is saved yet.
            </span>
          )}
          {sr.phase === 'review' && (
            <span className="block text-[var(--wb-text-3)]">
              Other statements on this connection are paused until you decide.
            </span>
          )}
          {sr.phase === 'committed' && (
            <span className="inline-flex items-center gap-1 text-[var(--wb-text)]">
              <Check className="h-3.5 w-3.5" aria-hidden />
              Committed {statementsLabel(pendingCount)}, {total}.
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

        {decidable && (
          <>
            <Button
              variant="secondary"
              size="default"
              disabled={busy || pendingCount === 0}
              onClick={onUndo}
              data-testid="safe-run-undo-last"
              title="Roll back the last statement that ran and keep the earlier ones"
            >
              <Undo2 aria-hidden />
              Undo last statement
            </Button>
            <Button
              variant="secondary"
              size="default"
              disabled={busy}
              onClick={onRollback}
              autoFocus
              data-testid="safe-run-rollback"
            >
              <RotateCcw aria-hidden />
              Roll back all
            </Button>
            {failedAt === null ? (
              <Button
                variant={large ? 'destructive' : 'primary'}
                size="default"
                disabled={busy}
                onClick={onCommit}
                data-testid="safe-run-commit"
              >
                {committing ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Check aria-hidden />
                )}
                Commit all · {total}
              </Button>
            ) : (
              <Button
                variant={large ? 'destructive' : 'secondary'}
                size="default"
                disabled={busy}
                onClick={onCommitPartial}
                data-testid="safe-run-commit-partial"
                title={`Save only the ${statementsLabel(pendingCount)} that succeeded. Statement ${failedAt} and the ones after it are not saved.`}
              >
                {committing ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Check aria-hidden />
                )}
                {partialCommitLabel(pendingCount)} · {total}
              </Button>
            )}
          </>
        )}
        {(sr.phase === 'committed' || sr.phase === 'rolledBack') && (
          <Button variant="secondary" size="default" onClick={onClose}>
            <X aria-hidden />
            Close
          </Button>
        )}
      </footer>
    </>
  );
}
