import { Pill } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import { actionSubject, actionTitle } from '@shared/agent-actions';
import { describeTableView } from '@shared/table-view';
import { FilePlus2, Loader2, Pencil, Play, Table2, Undo2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';

const ICONS = {
  show_table: Table2,
  run_query: Play,
  propose_change: Pencil,
  open_in_editor: FilePlus2,
} as const;

const EDGE = 'shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_8%,transparent)]';

/**
 * One action the agent proposed. Nothing runs until Approve is pressed; the
 * result (and a rejection note) goes back to the model.
 */
export function AgentActionCard({ actionId }: { actionId: string }) {
  const a = useSession((s) => s.aiActions[actionId]);
  const approve = useSession((s) => s.aiApproveAction);
  const reject = useSession((s) => s.aiRejectAction);
  const undo = useSession((s) => s.aiUndoAction);
  const [rejecting, setRejecting] = useState(false);
  const [why, setWhy] = useState('');
  if (!a) return null;

  const act = a.action;
  const title = actionTitle(a.name);
  const subject = actionSubject(act);
  const Icon = ICONS[a.name];
  const pending = a.status === 'pending';
  // A card that never got to run (bad arguments, wrong connection) is one quiet line.
  const quiet = (a.status === 'failed' && !a.tabId && !a.snapshot) || a.status === 'cancelled';

  const approveLabel =
    a.name === 'show_table'
      ? 'Apply'
      : a.name === 'run_query'
        ? 'Run'
        : a.name === 'open_in_editor'
          ? 'Open'
          : a.mode === 'preview'
            ? 'Preview with Safe Run'
            : 'Run it';
  const approveAria =
    a.name === 'propose_change'
      ? `${approveLabel}: ${subject}`
      : `${approveLabel} ${title.toLowerCase()}: ${subject}`;

  let body: ReactNode = null;
  if (!quiet) {
    if (act.name === 'show_table') {
      const chips = a.view ? describeTableView(a.view, a.viewColumns ?? []) : [];
      body =
        chips.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {chips.map((c) => (
              <span
                key={c}
                className="max-w-full truncate rounded-[6px] bg-[var(--wb-control)] px-2 py-1 font-mono text-[12px] text-[var(--wb-text)]"
                title={c}
              >
                {c}
              </span>
            ))}
          </div>
        ) : (
          <div className="text-[12px] text-[var(--wb-text-2)]">Opens the table as it is.</div>
        );
    } else {
      body = (
        <>
          {act.name === 'propose_change' && act.summary && (
            <div className="text-[12px] text-[var(--wb-text)]">{act.summary}</div>
          )}
          <pre
            className={cn(
              'max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-[var(--wb-field)] p-2 font-mono text-[12px] leading-relaxed text-[var(--wb-text)]',
              EDGE,
            )}
          >
            {act.sql}
          </pre>
          {act.name === 'propose_change' && pending && (
            <div className="text-[12px] text-[var(--wb-text-2)]">
              {a.mode === 'preview'
                ? 'Approve to preview it with Safe Run. Nothing is committed until you commit it.'
                : 'No preview for this statement. Approving runs it.'}
            </div>
          )}
          {act.name === 'run_query' && pending && (
            <div className="text-[12px] text-[var(--wb-text-2)]">
              {a.sandboxed
                ? 'Runs in a read-only session: it cannot change data.'
                : 'Not sandboxed on this engine: it runs as written. It was checked for writes, but approve only what you have read.'}
            </div>
          )}
          {act.name === 'open_in_editor' && pending && (
            <div className="text-[12px] text-[var(--wb-text-2)]">
              Opens in a new tab. It is not run.
            </div>
          )}
        </>
      );
    }
  }

  const statusLine = (() => {
    switch (a.status) {
      case 'pending':
        return null;
      case 'running':
        return (
          <span className="inline-flex items-center gap-1.5 text-[var(--wb-text-2)]">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {a.note ?? 'Working…'}
          </span>
        );
      case 'applied':
        return (
          <span className="inline-flex flex-wrap items-center gap-1.5 text-[var(--wb-text-2)]">
            <span>{a.undone ? 'Undone' : 'Applied'}</span>
            {a.note && !a.undone && <span className="text-[var(--wb-text-3)]">· {a.note}</span>}
            {a.name === 'show_table' && a.snapshot && !a.undone && (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[var(--wb-text)] hover:bg-[var(--wb-control)]"
                  aria-label={`Undo the view change on ${subject}`}
                  onClick={() => void undo(a.id)}
                >
                  <Undo2 className="h-3 w-3" aria-hidden />
                  Undo
                </button>
              </>
            )}
          </span>
        );
      case 'rejected':
        return (
          <span className="text-[var(--wb-text-2)]">
            Rejected{a.note ? <span className="text-[var(--wb-text-3)]"> · {a.note}</span> : null}
          </span>
        );
      case 'cancelled':
        return <span className="text-[var(--wb-text-3)]">Cancelled</span>;
      case 'failed':
        return (
          <span className="text-destructive" role="alert">
            Failed: {a.note ?? 'unknown error'}
          </span>
        );
    }
  })();

  return (
    <section
      aria-label={`${title}: ${subject}`}
      data-testid="agent-action-card"
      data-status={a.status}
      className={cn(
        'flex flex-col gap-2 rounded-[8px] bg-[var(--wb-content)] px-2.5 py-2 text-[13px]',
        EDGE,
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[var(--wb-text-2)]">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 text-[12px] font-medium text-[var(--wb-text)]">{title}</span>
        <span className="min-w-0 truncate font-mono text-[12px]" title={subject}>
          {subject}
        </span>
      </div>
      {body}
      {pending && !rejecting && (
        <div className="flex gap-2">
          <Pill onClick={() => void approve(a.id)} aria-label={approveAria}>
            {approveLabel}
          </Pill>
          <Pill onClick={() => setRejecting(true)} aria-label={`Reject: ${subject}`}>
            Reject
          </Pill>
        </div>
      )}
      {pending && rejecting && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            reject(a.id, why);
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: the field opens on an explicit click
            autoFocus
            value={why}
            maxLength={300}
            onChange={(e) => setWhy(e.target.value)}
            placeholder="What should change? (optional)"
            aria-label="Why are you rejecting this? (optional)"
            className="h-7 min-w-0 flex-1 rounded-[6px] border-0 bg-[var(--wb-field)] px-2 text-[12px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] outline-none placeholder:text-[var(--wb-text-3)] focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
          />
          <Pill type="submit" aria-label="Reject and send the note">
            Reject
          </Pill>
          <Pill onClick={() => setRejecting(false)} aria-label="Back to the choices">
            Back
          </Pill>
        </form>
      )}
      {statusLine && <div className="text-[12px]">{statusLine}</div>}
    </section>
  );
}
