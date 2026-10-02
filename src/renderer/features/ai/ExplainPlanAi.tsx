import { Pill } from '@/components/ui/workbench';
import { aiSchemaAllowed, runAiTask, schemaForTask } from '@/lib/ai-task';
import { cleanIpcError } from '@/lib/errors';
import { useSession } from '@/stores/session';
import {
  type PlanExplanation,
  buildExplainPlanPrompt,
  parseExplainPlanResponse,
} from '@shared/ai-tasks';
import { Copy, FilePlus2, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AiKeyNotice, AiThinking, useAiRun, useHasAiKey } from './ai-ui';

/**
 * "Explain this plan": a plain-English walk-through of the EXPLAIN output
 * plus concrete `CREATE INDEX CONCURRENTLY` suggestions. Each suggestion
 * opens in a new editor tab — nothing is executed from here.
 */
export function ExplainPlanAi({
  sql,
  plan,
  analyzed,
  onOpened,
}: {
  /** The explained statement (with `$n` placeholders when it used variables). */
  sql: string;
  plan: unknown;
  analyzed: boolean;
  /** Called after a suggestion was opened in the editor (the dialog closes). */
  onOpened: () => void;
}) {
  const hasKey = useHasAiKey();
  const { state, start } = useAiRun<PlanExplanation>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: one request per mount (the parent re-keys on plan changes)
  useEffect(() => {
    if (!hasKey) return;
    void start(async (signal) => {
      const s = useSession.getState();
      const raw = await runAiTask({
        task: 'explain-plan',
        prompt: buildExplainPlanPrompt({ sql, plan, analyzed }),
        schema: schemaForTask(s.schema, aiSchemaAllowed(s), sql),
        signal,
      });
      return parseExplainPlanResponse(raw);
    });
  }, [hasKey]);

  return (
    <section
      className="mt-4 rounded-[8px] bg-[var(--wb-control)]/60 p-3 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_6%,transparent)]"
      data-testid="explain-plan-ai"
    >
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[var(--wb-text)]">
        <Sparkles className="h-3.5 w-3.5" />
        Plan explained
        <span className="font-normal text-[var(--wb-text-3)]">
          · suggestions only, nothing is run
        </span>
      </div>
      {!hasKey && <AiKeyNotice />}
      {state.status === 'loading' && <AiThinking label="Reading the plan…" />}
      {state.status === 'error' && (
        <div className="text-[12px] text-destructive" role="alert">
          {cleanIpcError(state.message)}
        </div>
      )}
      {state.status === 'done' && <Explained result={state.data} onOpened={onOpened} />}
    </section>
  );
}

function Explained({ result, onOpened }: { result: PlanExplanation; onOpened: () => void }) {
  const addTab = useSession((s) => s.addTab);
  const setSql = useSession((s) => s.setSql);
  const [copied, setCopied] = useState<number | null>(null);

  const open = (sql: string) => {
    addTab();
    setSql(`${sql};`);
    onOpened();
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--wb-text)]">
        {result.explanation || 'The assistant returned no explanation.'}
      </p>
      {result.indexes.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="text-[12px] font-medium text-[var(--wb-text-2)]">
            Suggested indexes (built without blocking writes)
          </div>
          {result.indexes.map((ix, i) => (
            <div
              key={ix.sql}
              className="rounded-[6px] bg-[var(--wb-field)] p-2.5 ring-1 ring-inset ring-[var(--wb-separator)]"
            >
              {ix.reason && (
                <div className="mb-1 text-[12px] text-[var(--wb-text-2)]">{ix.reason}</div>
              )}
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-[var(--wb-text)]">
                {`${ix.sql};`}
              </pre>
              <div className="mt-2 flex gap-2">
                <Pill
                  onClick={() => open(ix.sql)}
                  title="Open in a new editor tab (does not run it)"
                >
                  <FilePlus2 />
                  Open in editor
                </Pill>
                <Pill
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(`${ix.sql};`)
                      .then(() => {
                        setCopied(i);
                        setTimeout(() => setCopied(null), 1200);
                      })
                      .catch(() => undefined);
                  }}
                >
                  <Copy />
                  {copied === i ? 'Copied' : 'Copy'}
                </Pill>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[12px] text-[var(--wb-text-2)]">
          No index suggestions for this plan.
        </div>
      )}
    </div>
  );
}
