import { Badge } from '@/components/ui/view-parts';
import { cn } from '@/lib/cn';
import {
  type LockContext,
  type StatementLock,
  describeLockTarget,
  lockBlocksDetail,
} from '@shared/pg-lock-preview';
import type { LintFinding, LintSeverity } from '@shared/pg-migration-lint';
import { AlertTriangle, ExternalLink, Info, Lock, OctagonAlert, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useMigrationCheck } from './use-migration-check';

const TONE: Record<LintSeverity, 'danger' | 'warn' | 'neutral'> = {
  error: 'danger',
  warn: 'warn',
  info: 'neutral',
};

function SeverityIcon({ severity }: { severity: LintSeverity }) {
  const cls = 'mt-0.5 h-3.5 w-3.5 shrink-0';
  if (severity === 'error') {
    return <OctagonAlert className={cn(cls, 'text-[var(--wb-danger-fill)]')} aria-hidden />;
  }
  if (severity === 'warn') {
    return <AlertTriangle className={cn(cls, 'text-[var(--status-warn)]')} aria-hidden />;
  }
  return <Info className={cn(cls, 'text-[var(--wb-text-3)]')} aria-hidden />;
}

export function FindingRow({
  f,
  onApplyFix,
}: { f: LintFinding; onApplyFix?: (f: LintFinding) => void }) {
  return (
    <li className="flex items-start gap-2" data-testid={`lint-finding-${f.ruleId}`}>
      <SeverityIcon severity={f.severity} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12.5px] font-medium text-[var(--wb-text)]">{f.title}</span>
          <Badge tone={TONE[f.severity]}>{f.severity}</Badge>
          {f.target && (
            <span className="font-mono text-[11.5px] text-[var(--wb-text-3)]">{f.target}</span>
          )}
        </div>
        <p className="text-[12px] leading-snug text-[var(--wb-text-2)]">{f.message}</p>
        <p className="text-[12px] leading-snug text-[var(--wb-text-2)]">
          <span className="font-medium text-[var(--wb-text)]">Safer: </span>
          {f.alternative}{' '}
          <a
            href={f.docs}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-[var(--wb-accent)] hover:underline"
          >
            Docs
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
          {f.fix && onApplyFix && (
            <button
              type="button"
              className="ml-2 text-[var(--wb-accent)] hover:underline"
              onClick={() => onApplyFix(f)}
            >
              {f.fix.title}
            </button>
          )}
        </p>
      </div>
    </li>
  );
}

function LockRows({
  locks,
  ctx,
}: {
  locks: StatementLock[];
  ctx: Map<string, LockContext> | undefined;
}) {
  return (
    <ul className="flex flex-col gap-1.5" data-testid="lock-preview">
      {locks.flatMap((lock) =>
        lock.targets.map((t) => {
          const c = ctx?.get(t.raw);
          const line = describeLockTarget(lock, t, c);
          const busy = c?.sessions.filter((s) => s.query || s.waiting).slice(0, 3) ?? [];
          return (
            <li
              key={`${lock.statementIndex}:${t.raw}:${t.mode}`}
              className="flex items-start gap-2"
            >
              <Lock
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 shrink-0',
                  line.blocks === 'reads and writes'
                    ? 'text-[var(--wb-danger-fill)]'
                    : line.blocks === 'writes'
                      ? 'text-[var(--status-warn)]'
                      : 'text-[var(--wb-text-3)]',
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] leading-snug text-[var(--wb-text)]">{line.text}</p>
                <p className="text-[12px] leading-snug text-[var(--wb-text-3)]">
                  {lockBlocksDetail(t.mode)}
                  {lock.note ? ` ${lock.note}` : ''}
                </p>
                {busy.length > 0 && (
                  <ul className="mt-0.5 flex flex-col gap-0.5">
                    {busy.map((s) => (
                      <li
                        key={s.pid}
                        className="truncate font-mono text-[11.5px] text-[var(--wb-text-3)]"
                        title={s.query ?? undefined}
                      >
                        pid {s.pid} · {s.user ?? '?'} ·{' '}
                        {s.waiting ? 'waiting' : (s.state ?? 'idle')} · {s.modes}
                        {s.query ? ` · ${s.query.replace(/\s+/g, ' ')}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        }),
      )}
    </ul>
  );
}

/**
 * Lint findings + lock preview for a SQL script, shown above the SQL in
 * every Preview SQL panel. When `onBlockedChange` is given, error findings
 * need an explicit "Run anyway" acknowledgement before the caller enables
 * its action (the callback reports whether it is still blocked).
 */
export function MigrationCheckPanel({
  sql,
  inTransaction,
  onBlockedChange,
  className,
  showClean,
}: {
  sql: string;
  inTransaction?: boolean;
  onBlockedChange?: (blocked: boolean) => void;
  className?: string;
  /** Say so when there is nothing to report (the Check migration dialog). */
  showClean?: boolean;
}) {
  const { check, ctx, loading, contextError, refresh } = useMigrationCheck(sql, { inTransaction });
  const [ack, setAck] = useState(false);
  const errorKey = useMemo(
    () =>
      check.findings
        .filter((f) => f.severity === 'error')
        .map((f) => `${f.ruleId}:${f.statementIndex}`)
        .join('|'),
    [check.findings],
  );
  // A different set of errors needs its own acknowledgement.
  // biome-ignore lint/correctness/useExhaustiveDependencies: errorKey is the trigger
  useEffect(() => setAck(false), [errorKey]);
  const hasError = errorKey !== '';
  const blocked = hasError && !ack;
  useEffect(() => {
    onBlockedChange?.(blocked);
  }, [blocked, onBlockedChange]);
  useEffect(() => () => onBlockedChange?.(false), [onBlockedChange]);

  if (check.findings.length === 0 && check.locks.length === 0) {
    if (!showClean) return null;
    return (
      <p className="text-[13px] text-[var(--wb-text-2)]" data-testid="migration-check-clean">
        {sql.trim() === ''
          ? 'The editor is empty.'
          : 'No locking DDL and no unsafe migration patterns found.'}
      </p>
    );
  }
  const ordered = [...check.findings].sort(
    (a, b) => rank(b.severity) - rank(a.severity) || a.statementIndex - b.statementIndex,
  );
  return (
    <section
      aria-label="Migration check"
      data-testid="migration-check"
      className={cn(
        'flex flex-col gap-2 rounded-[6px] border border-[var(--wb-separator)] bg-[var(--wb-field)] px-2.5 py-2',
        className,
      )}
    >
      {check.locks.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-[var(--wb-text-3)]">
            Locks
            {loading && <span className="normal-case tracking-normal">checking live…</span>}
            {ctx && (
              <button
                type="button"
                onClick={refresh}
                className="inline-flex items-center gap-1 normal-case tracking-normal hover:text-[var(--wb-text)]"
                aria-label="Refresh live lock context"
              >
                <RefreshCw className="h-3 w-3" aria-hidden />
                Refresh
              </button>
            )}
          </div>
          <LockRows locks={check.locks} ctx={ctx} />
          {contextError && (
            <p className="text-[12px] text-[var(--wb-text-3)]">
              Live table info unavailable: {contextError}
            </p>
          )}
        </div>
      )}
      {ordered.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--wb-text-3)]">
            Migration check
          </div>
          <ul className="flex flex-col gap-2">
            {ordered.map((f) => (
              <FindingRow key={`${f.ruleId}:${f.statementIndex}:${f.start}`} f={f} />
            ))}
          </ul>
        </div>
      )}
      {hasError && onBlockedChange && (
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-[var(--wb-text)]">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            data-testid="lint-run-anyway"
          />
          Run anyway. I understand the risks listed above.
        </label>
      )}
    </section>
  );
}

function rank(s: LintSeverity): number {
  return s === 'error' ? 2 : s === 'warn' ? 1 : 0;
}
