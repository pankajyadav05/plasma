import { Pill } from '@/components/ui/workbench';
import { aiSchemaAllowed, runAiTask, schemaForTask } from '@/lib/ai-task';
import { cn } from '@/lib/cn';
import { cleanIpcError } from '@/lib/errors';
import { type DiffSegment, applyFixToBuffer, diffLines, sameStatement } from '@/lib/text-diff';
import { useSession } from '@/stores/session';
import { buildFixSqlPrompt, parseFixSqlResponse } from '@shared/ai-tasks';
import type { FixSqlSuggestion } from '@shared/ai-tasks';
import { Check, Copy, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { AiKeyNotice, AiThinking, useAiRun, useHasAiKey } from './ai-ui';

interface Result {
  fix: FixSqlSuggestion | null;
  /** The model's raw answer, shown when it did not return a usable fix. */
  raw: string;
}

/**
 * "Fix with AI" for a failed statement. Sends the error, the failed SQL and
 * the relevant schema (per the AI schema settings); shows the corrected SQL
 * as a side-by-side diff. Apply replaces the statement in the editor — it
 * never runs anything.
 */
export function FixWithAi({
  tabId,
  sql,
  error,
}: {
  tabId: string;
  /** The statement that failed. */
  sql: string;
  error: string;
}) {
  const hasKey = useHasAiKey();
  const { state, start, reset } = useAiRun<Result>();
  const [applied, setApplied] = useState<string | null>(null);

  if (!hasKey) return <AiKeyNotice className="mt-3" />;

  const ask = () => {
    setApplied(null);
    void start(async (signal) => {
      const s = useSession.getState();
      const raw = await runAiTask({
        task: 'fix-sql',
        prompt: buildFixSqlPrompt({ sql, error: cleanIpcError(error) }),
        schema: schemaForTask(s.schema, aiSchemaAllowed(s), `${sql}\n${error}`),
        signal,
      });
      return { fix: parseFixSqlResponse(raw), raw };
    });
  };

  const apply = (fixed: string) => {
    const s = useSession.getState();
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const next = applyFixToBuffer(tab.sql, tab.queryErrorRange ?? null, sql, fixed);
    if (next === null) {
      // The statement moved or was edited: keep the work, in a new tab.
      s.addTab();
      s.setSql(fixed);
      setApplied('The statement changed in the editor, so the fix was opened in a new tab.');
      return;
    }
    useSession.setState((cur) => ({
      tabs: cur.tabs.map((t) =>
        t.id === tabId ? { ...t, sql: next, queryErrorRange: null, queryRunningRange: null } : t,
      ),
    }));
    setApplied('Applied to the editor. Review it, then run.');
  };

  return (
    <div className="mt-3" data-testid="fix-with-ai">
      {state.status === 'idle' && (
        <Pill onClick={ask} title="Ask the assistant for a corrected statement (nothing runs)">
          <Sparkles />
          Fix with AI
        </Pill>
      )}
      {state.status === 'loading' && <AiThinking label="Looking for a fix…" />}
      {state.status === 'error' && (
        <div className="flex items-center gap-2 text-[12px] text-destructive" role="alert">
          {cleanIpcError(state.message)}
          <Pill onClick={ask}>Try again</Pill>
        </div>
      )}
      {state.status === 'done' && (
        <FixResult
          result={state.data}
          original={sql}
          applied={applied}
          onApply={apply}
          onRetry={ask}
          onDismiss={reset}
        />
      )}
    </div>
  );
}

function FixResult({
  result,
  original,
  applied,
  onApply,
  onRetry,
  onDismiss,
}: {
  result: Result;
  original: string;
  applied: string | null;
  onApply: (sql: string) => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const fix = result.fix;

  if (!fix) {
    return (
      <div className="rounded-[8px] bg-[var(--wb-control)]/60 p-3 text-[12px] text-[var(--wb-text)]">
        <div className="mb-1 font-medium">No usable fix came back.</div>
        <p className="whitespace-pre-wrap text-[var(--wb-text-2)]">{result.raw.slice(0, 600)}</p>
        <div className="mt-2 flex gap-2">
          <Pill onClick={onRetry}>Try again</Pill>
          <Pill onClick={onDismiss}>Dismiss</Pill>
        </div>
      </div>
    );
  }

  const unchanged = sameStatement(original, fix.sql);
  const rows = diffLines(original, fix.sql);

  return (
    <div className="rounded-[8px] bg-[var(--wb-control)]/60 p-3 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_6%,transparent)]">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[var(--wb-text)]">
        <Sparkles className="h-3.5 w-3.5" />
        Suggested fix
        <span className="font-normal text-[var(--wb-text-3)]">
          · suggestion only, nothing was run
        </span>
      </div>
      {fix.explanation && (
        <p className="mb-2 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--wb-text-2)]">
          {fix.explanation}
        </p>
      )}
      {unchanged ? (
        <div className="text-[12px] text-[var(--wb-text-2)]">
          The assistant returned the same statement, so it found nothing to change.
        </div>
      ) : (
        <div
          className="grid grid-cols-2 overflow-hidden rounded-[6px] font-mono text-[12px] ring-1 ring-inset ring-[var(--wb-separator)]"
          data-testid="fix-diff"
        >
          <div className="border-b border-[var(--wb-separator)] bg-[var(--wb-field)] px-2 py-1 font-sans text-[11px] text-[var(--wb-text-2)]">
            Original
          </div>
          <div className="border-b border-l border-[var(--wb-separator)] bg-[var(--wb-field)] px-2 py-1 font-sans text-[11px] text-[var(--wb-text-2)]">
            Suggested
          </div>
          {rows.map((row, i) => (
            <DiffRow
              // biome-ignore lint/suspicious/noArrayIndexKey: static diff rows
              key={i}
              left={row.left}
              right={row.right}
              leftTone={row.kind === 'same' ? 'same' : 'removed'}
              rightTone={row.kind === 'same' ? 'same' : 'added'}
            />
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        {!unchanged && !applied && (
          <Pill
            onClick={() => onApply(fix.sql)}
            title="Replace the failed statement in the editor (does not run it)"
          >
            <Check />
            Apply to editor
          </Pill>
        )}
        <Pill
          onClick={() => {
            void navigator.clipboard
              .writeText(fix.sql)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
              .catch(() => undefined);
          }}
        >
          <Copy />
          {copied ? 'Copied' : 'Copy'}
        </Pill>
        <Pill onClick={onRetry}>Try again</Pill>
        <Pill onClick={onDismiss}>Dismiss</Pill>
        {applied && <span className="text-[12px] text-[var(--wb-text-2)]">{applied}</span>}
      </div>
    </div>
  );
}

const TONE = {
  same: '',
  removed: 'bg-destructive/10',
  added: 'bg-[color-mix(in_srgb,var(--status-local)_14%,transparent)]',
} as const;

function DiffRow({
  left,
  right,
  leftTone,
  rightTone,
}: {
  left?: DiffSegment[];
  right?: DiffSegment[];
  leftTone: keyof typeof TONE;
  rightTone: keyof typeof TONE;
}) {
  return (
    <>
      <DiffCell segs={left} tone={left ? leftTone : 'same'} side="left" />
      <DiffCell segs={right} tone={right ? rightTone : 'same'} side="right" />
    </>
  );
}

function DiffCell({
  segs,
  tone,
  side,
}: {
  segs?: DiffSegment[];
  tone: keyof typeof TONE;
  side: 'left' | 'right';
}) {
  return (
    <div
      className={cn(
        'min-h-[20px] whitespace-pre-wrap break-words px-2 py-px text-[var(--wb-text)]',
        side === 'right' && 'border-l border-[var(--wb-separator)]',
        TONE[tone],
      )}
    >
      {(segs ?? []).map((s, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static segments
          key={i}
          className={cn(
            s.changed &&
              tone !== 'same' &&
              (side === 'left'
                ? 'bg-destructive/25'
                : 'bg-[color-mix(in_srgb,var(--status-local)_32%,transparent)]'),
          )}
        >
          {s.text}
        </span>
      ))}
    </div>
  );
}
