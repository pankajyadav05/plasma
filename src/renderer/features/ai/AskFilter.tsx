import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Pill } from '@/components/ui/workbench';
import { markAiApplied } from '@/lib/ai-applied';
import { aiSchemaAllowed, runAiTask } from '@/lib/ai-task';
import { cleanIpcError } from '@/lib/errors';
import { useActiveTab, useSession } from '@/stores/session';
import { type NlViewSuggestion, buildNlViewPrompt, parseNlViewResponse } from '@shared/ai-tasks';
import {
  type CurrentTableView,
  type TableViewColumn,
  type TableViewSpec,
  describeTableView,
  isEmptyTableView,
  mergeHiddenFilterValues,
  trimViewToChanges,
} from '@shared/table-view';
import { Check, Copy, FilePlus2, Sparkles, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AiKeyNotice, AiThinking, useAiConfigured, useAiRun } from './ai-ui';
import { whereFragmentQuery } from './nl-filter';
import { type TableViewSnapshot, applyTableView, restoreTableView } from './table-view-apply';

/** What one Ask run produced, with the tab and columns it was asked about. */
interface AskResult {
  suggestion: NlViewSuggestion;
  tabId: string;
  columns: TableViewColumn[];
  current: CurrentTableView;
}

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * "Ask" on a table tab: describe the view you want in plain English (columns,
 * sort, filters, how many rows), review what the assistant proposes as chips,
 * then Apply. Nothing changes until you press Apply, and Undo puts the old
 * view back until the popover closes.
 */
export function AskFilter() {
  const tab = useActiveTab();
  const schema = useSession((s) => s.schema);
  const schemaAllowed = useSession((s) => aiSchemaAllowed(s));
  const hasKey = useAiConfigured();
  const { state, start, reset } = useAiRun<AskResult>();
  const rowData = useSession((s) => {
    const id = s.activeConfig?.id;
    return id ? s.settings.connectionAiRowData?.[id] === true : false;
  });
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  // The answer belongs to the tab it was asked on: switching tabs closes the popover.
  const activeId = tab?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on a tab change only
  useEffect(() => {
    setOpen(false);
    reset();
  }, [activeId]);

  const columns = useMemo<TableViewColumn[]>(() => {
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

  /** What the tab shows right now: the prompt and the "only what changes" chips use it. */
  const currentView = (): CurrentTableView => {
    const hidden = tab.hiddenColumns as Set<string>;
    return {
      columns: columns.map((c) => c.name).filter((n) => !hidden.has(n)),
      sort: (tab.tableSort as Array<{ column: string; direction: 'asc' | 'desc' }>).map((s) => ({
        column: s.column,
        direction: s.direction,
      })),
      filters: (
        tab.filters as Array<{ column: string; op: string; value: string; enabled?: boolean }>
      )
        .filter((f) => f.enabled !== false)
        .map((f) => ({ column: f.column, op: f.op, value: f.value })),
      pageSize: tab.pageSize,
    };
  };

  const ask = () => {
    const request = text.trim();
    if (!request || columns.length === 0) return;
    const current = currentView();
    const askedTabId = tab.id;
    const askedColumns = columns;
    void start(async (signal) => {
      const raw = await runAiTask({
        task: 'nl-view',
        prompt: buildNlViewPrompt({
          request,
          schema: tableSchema,
          table: tableName,
          columns,
          today: today(),
          current: {
            columns: current.columns,
            sort: current.sort,
            filters: current.filters.map((f) => ({
              column: f.column,
              op: f.op as never,
              value: f.value,
            })),
            pageSize: current.pageSize,
          },
          // Filter values can come from cells: the model sees them only with the row-data opt-in.
          showValues: rowData,
        }),
        // The column list travels in the prompt; the broader schema is not needed.
        schema: null,
        signal,
      });
      let suggestion = parseNlViewResponse(raw, askedColumns);
      if (suggestion.kind === 'view' && suggestion.view.filters) {
        // Filters echoed with the placeholder keep the value the user has.
        const merged = mergeHiddenFilterValues(suggestion.view.filters, current.filters);
        suggestion = merged.ok
          ? { ...suggestion, view: { ...suggestion.view, filters: merged.filters } }
          : { kind: 'none', explanation: merged.error };
      }
      return { suggestion, tabId: askedTabId, columns: askedColumns, current };
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
          title="Describe the view you want in plain English: columns, sort, filters, rows"
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
            the view assistant needs the column names.
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
                placeholder="latest 10 orders, only id, total, created_at"
                aria-label="Describe the view"
                className="h-8 min-w-0 flex-1 rounded-[7px] border-0 bg-[var(--wb-field)] px-2.5 text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] outline-none placeholder:text-[var(--wb-text-3)] focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
              />
              <Pill type="submit" disabled={!text.trim() || state.status === 'loading'}>
                <Sparkles />
                Ask
              </Pill>
            </form>
            {state.status === 'loading' && <AiThinking label="Working out the view…" />}
            {state.status === 'error' && (
              <div className="text-[12px] text-destructive" role="alert">
                {cleanIpcError(state.message)}
              </div>
            )}
            {state.status === 'done' && (
              <Suggestion
                // A new answer starts from a clean Apply state.
                key={JSON.stringify(state.data.suggestion)}
                suggestion={state.data.suggestion}
                tabId={state.data.tabId}
                schema={tableSchema}
                table={tableName}
                columns={state.data.columns}
                current={state.data.current}
                onClosePopover={() => {
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

function Chips({ chips }: { chips: string[] }) {
  return (
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
  );
}

function Suggestion({
  suggestion,
  tabId,
  schema,
  table,
  columns,
  current,
  onClosePopover,
}: {
  suggestion: NlViewSuggestion;
  tabId: string;
  schema: string;
  table: string;
  columns: TableViewColumn[];
  current: CurrentTableView;
  onClosePopover: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState<
    | { phase: 'idle' }
    | { phase: 'applying' }
    | { phase: 'applied'; snapshot: TableViewSnapshot }
    | { phase: 'undone' }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });
  // Fixed when the answer arrives: once applied, `current` IS the new view, and
  // comparing against it again would hide the Applied · Undo state.
  const [proposed] = useState(() =>
    suggestion.kind === 'view' ? trimViewToChanges(suggestion.view, current) : null,
  );

  if (suggestion.kind === 'none') {
    return <div className="text-[12px] text-[var(--wb-text-2)]">{suggestion.explanation}</div>;
  }

  if (suggestion.kind === 'view') {
    const view: TableViewSpec = proposed ?? suggestion.view;
    if (isEmptyTableView(view)) {
      return (
        <div className="text-[12px] text-[var(--wb-text-2)]" data-testid="ask-filter-result">
          The table already looks like that. Nothing to change.
        </div>
      );
    }
    const apply = async () => {
      setApplied({ phase: 'applying' });
      try {
        const snapshot = await applyTableView(tabId, view);
        setApplied({ phase: 'applied', snapshot });
      } catch (err) {
        setApplied({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    };
    return (
      <div className="flex flex-col gap-2" data-testid="ask-filter-result">
        {suggestion.explanation && (
          <div className="text-[12px] text-[var(--wb-text-2)]">{suggestion.explanation}</div>
        )}
        <Chips chips={describeTableView(view, columns)} />
        {applied.phase === 'idle' || applied.phase === 'applying' ? (
          <div className="flex gap-2">
            <Pill
              onClick={() => void apply()}
              disabled={applied.phase === 'applying'}
              title="Change this table's view as shown"
              aria-label="Apply this view"
            >
              <Check />
              Apply
            </Pill>
            <Pill onClick={onClosePopover} aria-label="Cancel">
              Cancel
            </Pill>
          </div>
        ) : applied.phase === 'applied' ? (
          <output className="flex items-center gap-2 text-[12px] text-[var(--wb-text-2)]">
            <span>Applied</span>
            <span aria-hidden>·</span>
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[var(--wb-text)] hover:bg-[var(--wb-control)]"
              aria-label="Undo this view change"
              onClick={() => {
                void restoreTableView(tabId, applied.snapshot).then(() =>
                  setApplied({ phase: 'undone' }),
                );
              }}
            >
              <Undo2 className="h-3 w-3" />
              Undo
            </button>
          </output>
        ) : applied.phase === 'undone' ? (
          <output className="block text-[12px] text-[var(--wb-text-2)]">
            Undone. The previous view is back.
          </output>
        ) : (
          <div className="text-[12px] text-destructive" role="alert">
            {applied.message}
          </div>
        )}
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
            markAiApplied(useSession.getState().activeTabId, query);
            onClosePopover();
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
