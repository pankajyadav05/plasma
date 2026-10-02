import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Pill } from '@/components/ui/workbench';
import { aiSchemaAllowed, runAiTask } from '@/lib/ai-task';
import { cleanIpcError } from '@/lib/errors';
import { operatorLabel } from '@/lib/pg-types';
import { useActiveTab, useSession } from '@/stores/session';
import {
  type NlFilterSuggestion,
  buildNlFilterPrompt,
  parseNlFilterResponse,
} from '@shared/ai-tasks';
import { Check, Copy, FilePlus2, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AiKeyNotice, AiThinking, useAiRun, useHasAiKey } from './ai-ui';
import { nlRowsToFilters, whereFragmentQuery } from './nl-filter';

let counter = 0;
const newId = () => `nl-${Date.now().toString(36)}-${counter++}`;

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * "Ask" mode of a table tab's filter bar: type what you want in plain
 * English, review the filter rows (or WHERE fragment) the assistant
 * proposes, then apply. Nothing changes until you press Apply.
 */
export function AskFilter() {
  const tab = useActiveTab();
  const schema = useSession((s) => s.schema);
  const schemaAllowed = useSession((s) => aiSchemaAllowed(s));
  const hasKey = useHasAiKey();
  const { state, start, reset } = useAiRun<NlFilterSuggestion>();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  const columns = useMemo(() => {
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return [];
    return (
      schema?.columns
        .filter((c) => c.schema === tab.tableSchema && c.table === tab.tableName)
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((c) => ({ name: c.name, dataType: c.dataType })) ?? []
    );
  }, [tab, schema]);

  if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return null;
  const tableSchema = tab.tableSchema;
  const tableName = tab.tableName;

  const ask = () => {
    const request = text.trim();
    if (!request || columns.length === 0) return;
    void start(async (signal) => {
      const raw = await runAiTask({
        task: 'nl-filter',
        prompt: buildNlFilterPrompt({
          request,
          schema: tableSchema,
          table: tableName,
          columns,
          today: today(),
        }),
        // The column list travels in the prompt; the broader schema is not needed.
        schema: null,
        signal,
      });
      return parseNlFilterResponse(raw, columns);
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Describe the rows you want in plain English"
          className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-[6px] px-2 text-[13px] text-[var(--wb-text-2)] transition-colors duration-150 hover:bg-[var(--wb-control)] hover:text-[var(--wb-text)]"
        >
          <Sparkles className="h-3 w-3" />
          Ask
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[460px] max-w-[92vw] p-3">
        {!hasKey ? (
          <AiKeyNotice />
        ) : !schemaAllowed ? (
          <div className="text-[12px] text-[var(--wb-text-2)]">
            Sharing schema names with the AI provider is off for this connection (Settings, AI), and
            the filter assistant needs the column names.
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                ask();
              }}
            >
              <input
                // biome-ignore lint/a11y/noAutofocus: the popover opens on an explicit action
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="orders over 500 from last week"
                aria-label="Describe the filter"
                className="h-8 min-w-0 flex-1 rounded-[7px] border-0 bg-[var(--wb-field)] px-2.5 text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] outline-none placeholder:text-[var(--wb-text-3)] focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
              />
              <Pill type="submit" disabled={!text.trim() || state.status === 'loading'}>
                <Sparkles />
                Ask
              </Pill>
            </form>
            {state.status === 'loading' && <AiThinking label="Working out the filter…" />}
            {state.status === 'error' && (
              <div className="text-[12px] text-destructive" role="alert">
                {cleanIpcError(state.message)}
              </div>
            )}
            {state.status === 'done' && (
              <Suggestion
                suggestion={state.data}
                schema={tableSchema}
                table={tableName}
                onApplied={() => {
                  setOpen(false);
                  reset();
                  setText('');
                }}
              />
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Suggestion({
  suggestion,
  schema,
  table,
  onApplied,
}: {
  suggestion: NlFilterSuggestion;
  schema: string;
  table: string;
  onApplied: () => void;
}) {
  const [copied, setCopied] = useState(false);

  if (suggestion.kind === 'none') {
    return <div className="text-[12px] text-[var(--wb-text-2)]">{suggestion.explanation}</div>;
  }

  if (suggestion.kind === 'filters') {
    const apply = () => {
      const added = nlRowsToFilters(suggestion.filters, newId);
      useSession.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === s.activeTabId && t.kind === 'table'
            ? { ...t, filters: [...t.filters, ...added], page: 0 }
            : t,
        ),
      }));
      void useSession.getState().refreshTable();
      onApplied();
    };
    return (
      <div className="flex flex-col gap-2" data-testid="ask-filter-result">
        {suggestion.explanation && (
          <div className="text-[12px] text-[var(--wb-text-2)]">{suggestion.explanation}</div>
        )}
        <div className="flex flex-col gap-1">
          {suggestion.filters.map((f) => (
            <div
              key={`${f.column}${f.op}${f.value}`}
              className="flex items-center gap-1.5 rounded-[6px] bg-[var(--wb-control)] px-2 py-1 text-[13px]"
            >
              <span className="font-mono font-medium text-[var(--wb-text)]">{f.column}</span>
              <span className="text-[var(--wb-text-2)]">{operatorLabel(f.op)}</span>
              {f.op !== 'IS NULL' && f.op !== 'IS NOT NULL' && (
                <span className="min-w-0 truncate font-mono text-[var(--wb-text)]">{f.value}</span>
              )}
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Pill onClick={apply} title="Add these as filters on this table">
            <Check />
            Apply{' '}
            {suggestion.filters.length === 1 ? 'filter' : `${suggestion.filters.length} filters`}
          </Pill>
        </div>
      </div>
    );
  }

  const query = whereFragmentQuery(schema, table, suggestion.where);
  return (
    <div className="flex flex-col gap-2" data-testid="ask-filter-result">
      <div className="text-[12px] text-[var(--wb-text-2)]">
        {suggestion.explanation || 'This needs more than the filter bar can express.'} It is shown
        as a WHERE fragment for you to review.
      </div>
      <pre className="whitespace-pre-wrap break-words rounded-[6px] bg-[var(--wb-field)] p-2 font-mono text-[12px] text-[var(--wb-text)] ring-1 ring-inset ring-[var(--wb-separator)]">
        {query}
      </pre>
      <div className="flex gap-2">
        <Pill
          onClick={() => {
            const s = useSession.getState();
            s.addTab();
            s.setSql(query);
            onApplied();
          }}
          title="Open as a query in a new tab (does not run it)"
        >
          <FilePlus2 />
          Open in editor
        </Pill>
        <Pill
          onClick={() => {
            void navigator.clipboard
              .writeText(suggestion.where)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
              .catch(() => undefined);
          }}
        >
          <Copy />
          {copied ? 'Copied' : 'Copy WHERE'}
        </Pill>
      </div>
    </div>
  );
}
