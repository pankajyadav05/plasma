import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { copyableProblem, fieldLabel } from '@/lib/connect-problem';
import type { ConnectDiagnosis, ConnectField } from '@shared/connect-diagnosis';
import type { StageResult } from '@shared/connect-stages';
import { AlertTriangle, Check, ChevronRight, Copy, Minus, X } from 'lucide-react';
import { useId, useState } from 'react';

/**
 * A connection failure in plain words: what is wrong, what to try, which field
 * to look at, the raw error behind a "Details" disclosure with a copy button,
 * and the steps "Test connection" went through. Shared by the connection
 * editor and the reconnect banner. Colours come from the workbench tokens.
 */

export function StageList({ stages }: { stages: readonly StageResult[] }) {
  return (
    <ol
      aria-label="Connection steps"
      className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[12px]"
      data-testid="conn-stages"
    >
      {stages.map((s, i) => (
        <li key={s.id} className="flex items-center gap-1" data-stage={s.id} data-status={s.status}>
          {i > 0 && <ChevronRight className="h-3 w-3 text-[var(--wb-text-3)]" aria-hidden />}
          <StageIcon status={s.status} />
          <span
            className={cn(
              s.status === 'ok' && 'text-[var(--wb-text-2)]',
              s.status === 'failed' && 'font-medium text-[var(--destructive)]',
              s.status === 'skipped' && 'text-[var(--wb-text-3)]',
            )}
          >
            {s.label}
            <span className="sr-only">
              {s.status === 'ok'
                ? ': passed'
                : s.status === 'failed'
                  ? ': failed'
                  : ': not reached'}
            </span>
          </span>
          {s.status === 'ok' && s.note && (
            <span className="text-[var(--wb-text-3)]" title={s.note}>
              ({s.note.length > 24 ? `${s.note.slice(0, 22)}…` : s.note})
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function StageIcon({ status }: { status: StageResult['status'] }) {
  if (status === 'ok') {
    return <Check className="h-3 w-3 text-[var(--status-local)]" strokeWidth={3} aria-hidden />;
  }
  if (status === 'failed') {
    return <X className="h-3 w-3 text-[var(--destructive)]" strokeWidth={3} aria-hidden />;
  }
  return <Minus className="h-3 w-3 text-[var(--wb-text-3)]" aria-hidden />;
}

export interface ConnectionProblemProps {
  diagnosis: ConnectDiagnosis;
  stages?: readonly StageResult[];
  /** `warning`: the connection worked, with a note. */
  tone?: 'error' | 'warning';
  engine?: string;
  /** Jump to the control the diagnosis points at. */
  onFocusField?: (field: ConnectField) => void;
  className?: string;
}

export function ConnectionProblem({
  diagnosis,
  stages,
  tone = 'error',
  engine,
  onFocusField,
  className,
}: ConnectionProblemProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const detailsId = useId();
  const warning = tone === 'warning';

  const copy = () => {
    void navigator.clipboard?.writeText(copyableProblem(diagnosis)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <section
      id="conn-problem"
      role={warning ? 'status' : 'alert'}
      aria-label={warning ? 'Connection note' : 'Connection problem'}
      data-testid="conn-problem"
      data-cause={diagnosis.cause}
      className={cn(
        'flex max-h-[42vh] shrink-0 flex-col gap-2 overflow-y-auto border-t border-[var(--wb-separator)] bg-[var(--wb-content)] px-4 py-3 text-[13px] text-[var(--wb-text)]',
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle
          className={cn(
            'mt-[2px] h-4 w-4 shrink-0',
            warning ? 'text-[var(--status-staging)]' : 'text-[var(--destructive)]',
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug" data-testid="conn-problem-title">
            {diagnosis.title}
          </p>
          <p className="mt-0.5 leading-snug text-[var(--wb-text-2)]">{diagnosis.detail}</p>
          {diagnosis.fixes.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 leading-snug">
              {diagnosis.fixes.map((fix) => (
                <li key={fix}>{fix}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {diagnosis.field && onFocusField && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="conn-problem-field"
                onClick={() => onFocusField(diagnosis.field as ConnectField)}
              >
                Check {fieldLabel(diagnosis.field, engine).toLowerCase()}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen((v) => !v)}
              data-testid="conn-problem-details"
            >
              <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
              Details
            </Button>
          </div>
          {open && (
            <div id={detailsId} className="mt-1.5 flex items-start gap-2">
              <pre
                className="max-h-32 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-[var(--wb-field)] px-2 py-1.5 font-mono text-[12px] text-[var(--wb-text-2)]"
                data-testid="conn-problem-raw"
              >
                {diagnosis.raw}
              </pre>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={copy}
                aria-label="Copy the error details"
                data-testid="conn-problem-copy"
              >
                {copied ? <Check /> : <Copy />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          )}
        </div>
      </div>
      {stages && stages.length > 0 && <StageList stages={stages} />}
    </section>
  );
}
