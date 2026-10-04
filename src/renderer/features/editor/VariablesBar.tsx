import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, MenuItem, Pill, Segmented } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { shortcut } from '@/lib/platform';
import { defaultVariableValue } from '@/lib/query-variables';
import { useActiveTab, useSession } from '@/stores/session';
import { markVarsReviewed, setQueryVar, setVarsBarOpen } from '@/stores/session-variables';
import {
  type VariableMode,
  type VariableValue,
  bindVariables,
  listVariables,
  validateVariableValue,
} from '@shared/sql-variables';
import { ChevronDown, Code2, History, Play, TriangleAlert, X } from 'lucide-react';
import { useMemo, useState } from 'react';

const MODE_LABEL: Record<VariableMode, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Boolean',
  null: 'NULL',
  raw: 'Raw SQL',
};

const MODE_HINT: Partial<Record<VariableMode, string>> = {
  text: 'Bound as a parameter ($n)',
  raw: 'Inserted into the SQL exactly as typed (identifiers, expressions) — not escaped',
};

/**
 * Query variables bar (`:name`, `:'name'`, `$name`). Shown above the
 * results once a run needs values. Typed values are bound as real
 * parameters; only "Raw SQL" inputs are pasted into the statement, and are
 * marked as such.
 */
export function VariablesBar() {
  const tab = useActiveTab();
  const runQuery = useSession((s) => s.runQuery);
  const history = useSession((s) => s.settings.variableHistory);
  const sql = tab?.kind === 'sql' ? tab.sql : '';
  const names = useMemo(() => listVariables(sql), [sql]);
  if (!tab || tab.kind !== 'sql' || !tab.varsBarOpen || names.length === 0) return null;

  const values = tab.queryVars ?? {};
  const running = tab.queryRunState === 'running';
  const run = () => {
    if (running) return;
    markVarsReviewed(tab.id);
    void runQuery();
  };
  const attention = tab.varsAttention as string | null | undefined;

  return (
    <div
      className="flex shrink-0 flex-col gap-1.5 border-t border-[var(--wb-separator)] bg-[var(--wb-content)] px-2.5 py-2"
      data-testid="variables-bar"
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-4 gap-y-1.5">
          {names.map((name, i) => (
            <VariableField
              key={name}
              name={name}
              value={values[name]}
              history={history?.[name] ?? []}
              autoFocus={i === 0 && Boolean(attention)}
              onChange={(v) => setQueryVar(tab.id, name, v)}
              onEnter={run}
            />
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <BoundPreview sql={tab.sql} values={values} />
          <Pill
            onClick={run}
            disabled={running}
            data-testid="variables-run"
            title="Run with these values"
          >
            <Play className="fill-current" />
            Run
            <span className="font-mono text-[12px] text-[var(--wb-text-2)]">
              {shortcut('runQuery')}
            </span>
          </Pill>
          <IconButton
            variant="plain"
            label="Hide variables"
            onClick={() => setVarsBarOpen(tab.id, false)}
          >
            <X />
          </IconButton>
        </div>
      </div>
      {attention && (
        <div className="flex items-center gap-1.5 text-[12px] text-destructive" role="alert">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          {attention}
        </div>
      )}
    </div>
  );
}

function VariableField({
  name,
  value,
  history,
  autoFocus,
  onChange,
  onEnter,
}: {
  name: string;
  value: VariableValue | undefined;
  history: string[];
  autoFocus: boolean;
  onChange: (v: VariableValue) => void;
  onEnter: () => void;
}) {
  const v = value ?? defaultVariableValue();
  const problem = value ? validateVariableValue(v) : null;
  const raw = v.mode === 'raw';
  const [modeOpen, setModeOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const setMode = (mode: VariableMode) => {
    setModeOpen(false);
    onChange({
      mode,
      value:
        mode === 'boolean'
          ? /^(true|false)$/i.test(v.value)
            ? v.value.toLowerCase()
            : 'true'
          : v.value,
    });
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        className={cn(
          'shrink-0 font-mono text-[12px]',
          raw ? 'text-[var(--status-warn)]' : 'text-[var(--wb-text-2)]',
        )}
      >
        :{name}
      </span>
      <Popover open={modeOpen} onOpenChange={setModeOpen}>
        <PopoverTrigger asChild>
          <Pill
            title={MODE_HINT[v.mode] ?? `Value type: ${MODE_LABEL[v.mode]}`}
            aria-label={`Type of ${name}`}
          >
            {MODE_LABEL[v.mode]}
            <ChevronDown className="!h-3.5 !w-3.5 opacity-70" />
          </Pill>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={4} className="w-[170px] p-1" role="menu">
          {(Object.keys(MODE_LABEL) as VariableMode[]).map((m) => (
            <MenuItem
              key={m}
              label={MODE_LABEL[m]}
              checked={v.mode === m}
              hint={m === 'raw' ? 'unescaped' : undefined}
              onClick={() => setMode(m)}
            />
          ))}
        </PopoverContent>
      </Popover>

      {v.mode === 'null' ? (
        <span className="px-1 font-mono text-[12px] italic text-[var(--wb-text-2)]">NULL</span>
      ) : v.mode === 'boolean' ? (
        <Segmented<'true' | 'false'>
          ariaLabel={`Value of ${name}`}
          variant="track"
          value={v.value === 'false' ? 'false' : 'true'}
          onChange={(b) => onChange({ mode: 'boolean', value: b })}
          options={[
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' },
          ]}
        />
      ) : (
        <Input
          autoFocus={autoFocus}
          value={v.value}
          aria-label={`Value of ${name}`}
          aria-invalid={problem ? true : undefined}
          title={problem ?? MODE_HINT[v.mode]}
          spellCheck={false}
          autoComplete="off"
          inputMode={v.mode === 'number' ? 'decimal' : undefined}
          placeholder={
            v.mode === 'date'
              ? 'YYYY-MM-DD'
              : v.mode === 'number'
                ? '0'
                : raw
                  ? 'identifier or expression'
                  : 'value'
          }
          onChange={(e) => onChange({ mode: v.mode, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onEnter();
            }
          }}
          className={cn(
            'h-[26px] w-[170px]',
            (raw || v.mode === 'number') && 'font-mono',
            raw && 'shadow-[inset_0_0_0_1px_var(--status-warn)]',
          )}
        />
      )}
      {raw && (
        <span
          className="shrink-0 rounded-[4px] bg-[color-mix(in_srgb,var(--status-warn)_18%,transparent)] px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-[var(--status-warn)]"
          title={MODE_HINT.raw}
        >
          raw
        </span>
      )}
      {history.length > 0 && v.mode !== 'null' && v.mode !== 'boolean' && (
        <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
          <PopoverTrigger asChild>
            <IconButton variant="plain" label={`Recent values of ${name}`}>
              <History />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={4} className="w-[240px] p-1" role="menu">
            {history.map((h) => (
              <MenuItem
                key={h}
                label={
                  <span className="font-mono">{h.length > 60 ? `${h.slice(0, 60)}…` : h}</span>
                }
                onClick={() => {
                  setHistoryOpen(false);
                  onChange({ mode: v.mode, value: h });
                }}
              />
            ))}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

/** The SQL as it will be sent: `$n` for bound values, raw text pasted in. */
function BoundPreview({ sql, values }: { sql: string; values: Record<string, VariableValue> }) {
  const bound = bindVariables(sql, values);
  const ready =
    bound.missing.length === 0 && !bound.conflict && Object.keys(bound.invalid).length === 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton variant="plain" label="Show the SQL and parameters that will be sent">
          <Code2 />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[460px] max-w-[90vw] p-0">
        <div className="border-b border-[var(--wb-separator)] px-3 py-1.5 text-[12px] text-[var(--wb-text-2)]">
          Sent to the server
        </div>
        {ready ? (
          <>
            <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px] text-[var(--wb-text)]">
              {bound.sql}
            </pre>
            {bound.params.length > 0 && (
              <div className="border-t border-[var(--wb-separator)] px-3 py-2 font-mono text-[12px] text-[var(--wb-text-2)]">
                {bound.params.map((p, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional parameters
                  <div key={i}>
                    <span className="text-[var(--wb-text-3)]">${i + 1}</span> ={' '}
                    {p === null ? 'NULL' : JSON.stringify(p)}
                    <span className="text-[var(--wb-text-3)]"> · {bound.paramNames[i]}</span>
                  </div>
                ))}
              </div>
            )}
            {bound.rawNames.length > 0 && (
              <div className="border-t border-[var(--wb-separator)] px-3 py-2 text-[12px] text-[var(--status-warn)]">
                Raw SQL pasted in: {bound.rawNames.map((n) => `:${n}`).join(', ')}
              </div>
            )}
          </>
        ) : (
          <div className="p-3 text-[12px] text-[var(--wb-text-2)]">
            {bound.conflict ?? 'Fill in every variable to see the bound statement.'}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
