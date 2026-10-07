import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { IconButton, MenuItem, Pill } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { type CompareSide, type SideLabel, useCompare } from '@/stores/compare';
import { useSession } from '@/stores/session';
import { MAX_COMPARE_ROWS } from '@shared/result-compare';
import { isSqlEngine } from '@shared/sql-dialect';
import {
  AlertTriangle,
  FileCode,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCw,
  Table2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNow } from '../editor/RunStatus';
import { formatCaptured } from './cell-text';
import { comparableTabs, seedForTab } from './tab-source';

const ACTIVE = '__active';

/** Saved SQL connections plus the active one, for the connection picker. */
export function useSqlConnections(): Array<{ value: string; name: string; hint?: string }> {
  const saved = useSession((s) => s.savedConnections);
  const active = useSession((s) => s.activeConfig);
  return useMemo(() => {
    const list = saved
      .filter((c) => isSqlEngine(c.engine ?? 'postgres'))
      .map((c) => ({
        value: c.id,
        name: c.name,
        hint: c.id === active?.id ? 'connected' : undefined,
      }));
    if (active && !list.some((c) => c.value === active.id)) {
      list.unshift({ value: ACTIVE, name: active.name, hint: 'connected' });
    }
    return list;
  }, [saved, active]);
}

const connValue = (id: string | null, activeId: string | undefined) =>
  id === null || id === activeId ? (id ?? ACTIVE) : id;

/** Pick the connection a query runs on. */
export function ConnectionSelect({
  value,
  onChange,
  label,
}: {
  value: string | null;
  onChange(id: string | null): void;
  label: string;
}) {
  const options = useSqlConnections();
  const activeId = useSession((s) => s.activeConfig?.id);
  const current = connValue(value, activeId);
  return (
    <Select
      value={options.some((o) => o.value === current) ? current : undefined}
      onValueChange={(v) => onChange(v === ACTIVE ? null : v)}
    >
      <SelectTrigger aria-label={label} data-testid={`${label}-connection`} className="h-[24px]">
        <SelectValue placeholder="Choose a connection" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.name}
            {o.hint ? <span className="ml-2 text-[var(--wb-text-2)]">{o.hint}</span> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function QueryEditor({
  side,
  initial,
  onRun,
  onCancel,
}: {
  side: SideLabel;
  initial: { connectionId: string | null; sql: string };
  onRun(connectionId: string | null, sql: string): void;
  onCancel?: () => void;
}) {
  const [connectionId, setConnectionId] = useState<string | null>(initial.connectionId);
  const [sql, setSql] = useState(initial.sql);
  const ready = sql.trim().length > 0;
  const run = () => ready && onRun(connectionId, sql.trim());
  return (
    <div className="flex flex-col gap-1.5" data-testid={`compare-${side}-editor`}>
      <ConnectionSelect value={connectionId} onChange={setConnectionId} label={`${side}`} />
      <textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            run();
          }
        }}
        rows={3}
        spellCheck={false}
        aria-label={`Query for side ${side.toUpperCase()}`}
        data-testid={`compare-${side}-sql`}
        placeholder="SELECT … (one read-only statement)"
        className="min-h-[58px] w-full resize-y rounded-[7px] border-0 bg-[var(--wb-field)] p-2 font-mono text-[12px] leading-[17px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] placeholder:text-[var(--wb-text-3)] focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--ring),0_0_0_3px_color-mix(in_oklab,var(--ring)_30%,transparent)]"
      />
      <div className="flex items-center gap-2">
        <Pill onClick={run} disabled={!ready} data-testid={`compare-${side}-run`}>
          <Play />
          Run
        </Pill>
        {onCancel && (
          <Pill onClick={onCancel} data-testid={`compare-${side}-edit-cancel`}>
            Cancel
          </Pill>
        )}
        <span className="text-[11px] text-[var(--wb-text-3)]">
          Read-only · up to {MAX_COMPARE_ROWS.toLocaleString()} rows
        </span>
      </div>
    </div>
  );
}

/** One side of the comparison: where its rows come from, and how fresh they are. */
export function SourceCard({ tabId, side }: { tabId: string; side: SideLabel }) {
  const data: CompareSide | undefined = useCompare((s) => s.sessions[tabId]?.[side]);
  const setSide = useCompare((s) => s.setSide);
  const rerunSide = useCompare((s) => s.rerunSide);
  const clearSide = useCompare((s) => s.clearSide);
  const tabs = useSession((s) => s.tabs);
  const [editing, setEditing] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const loading = data?.status === 'loading';
  const now = useNow(loading, 250);

  if (!data) return null;
  const label = side.toUpperCase();
  const candidates = comparableTabs(tabs.filter((t) => t.id !== tabId));

  const startQuery = (connectionId: string | null, sql: string) => {
    setEditing(false);
    setSide(tabId, side, { kind: 'query', connectionId, sql });
  };

  const chip = (
    <span
      aria-hidden
      className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] bg-[var(--wb-control)] text-[11px] font-semibold text-[var(--wb-text)]"
    >
      {label}
    </span>
  );

  return (
    <section
      aria-label={`Side ${label}`}
      data-testid={`compare-side-${side}`}
      data-status={data.status}
      className={cn(
        'flex min-w-0 flex-1 flex-col gap-1.5 rounded-[8px] px-3 py-2 shadow-[inset_0_0_0_1px_var(--wb-separator)]',
        data.status === 'empty' && 'bg-transparent',
      )}
    >
      <div className="flex min-h-[22px] items-center gap-2">
        {chip}
        <span className="truncate text-[13px] font-medium text-[var(--wb-text)]">
          {data.status === 'empty'
            ? `Side ${label}`
            : `${data.connectionName}${data.tabTitle ? ` · ${data.tabTitle}` : ''}`}
        </span>
        <span className="flex-1" />
        {data.status !== 'empty' && (
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <IconButton
                label={`Change side ${label}`}
                variant="plain"
                data-testid={`compare-${side}-menu`}
              >
                <MoreHorizontal />
              </IconButton>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[230px] p-1" role="menu">
              <MenuItem
                icon={<RotateCw />}
                label="Run again"
                disabled={!data.sql}
                onClick={() => {
                  setMenuOpen(false);
                  rerunSide(tabId, side);
                }}
              />
              <MenuItem
                icon={<Pencil />}
                label="Edit query…"
                onClick={() => {
                  setMenuOpen(false);
                  setEditing(true);
                }}
              />
              <MenuItem
                icon={<FileCode />}
                label="Use a different source…"
                onClick={() => {
                  setMenuOpen(false);
                  setChoosing(true);
                }}
              />
              <MenuItem
                icon={<X />}
                label="Clear"
                onClick={() => {
                  setMenuOpen(false);
                  clearSide(tabId, side);
                }}
              />
            </PopoverContent>
          </Popover>
        )}
      </div>

      {editing ? (
        <QueryEditor
          side={side}
          initial={{ connectionId: data.connectionId, sql: data.sql }}
          onRun={startQuery}
          onCancel={() => setEditing(false)}
        />
      ) : data.status === 'empty' || choosing ? (
        <div className="flex flex-col gap-2">
          <p className="text-[12px] text-[var(--wb-text-2)]">
            Take the rows from a result tab, or run a query on any saved connection.
          </p>
          <div className="flex items-center gap-2">
            <Popover open={pickOpen} onOpenChange={setPickOpen}>
              <PopoverTrigger asChild>
                <Pill data-testid={`compare-${side}-pick-tab`}>
                  <FileCode />
                  Result tab…
                </Pill>
              </PopoverTrigger>
              <TabPicker
                candidates={candidates}
                onPick={(id) => {
                  setPickOpen(false);
                  setChoosing(false);
                  const t = tabs.find((x) => x.id === id);
                  const seed = t ? seedForTab(t) : null;
                  if (seed) setSide(tabId, side, seed);
                }}
              />
            </Popover>
            <Pill
              onClick={() => {
                setChoosing(false);
                setEditing(true);
              }}
              data-testid={`compare-${side}-run-query`}
            >
              <Play />
              Run a query…
            </Pill>
            {choosing && <Pill onClick={() => setChoosing(false)}>Cancel</Pill>}
          </div>
        </div>
      ) : (
        <>
          {data.status === 'loading' && (
            <p className="flex items-center gap-1.5 text-[12px] text-[var(--wb-text-2)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Running on {data.connectionName}…{' '}
              <span className="font-mono tabular-nums">
                {(Math.max(0, now - (data.startedAt ?? now)) / 1000).toFixed(1)}s
              </span>
              <button
                type="button"
                onClick={() => clearSide(tabId, side)}
                data-testid={`compare-${side}-stop`}
                className="ml-1 text-[var(--wb-text-2)] underline-offset-2 hover:text-[var(--wb-text)] hover:underline"
                title="Stop waiting for this side. The server may finish the query on its own."
              >
                Stop waiting
              </button>
            </p>
          )}
          {data.status === 'error' && (
            <p
              role="alert"
              className="flex items-start gap-1.5 text-[12px] text-destructive"
              data-testid={`compare-${side}-error`}
            >
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">{data.error}</span>
            </p>
          )}
          {data.status === 'ready' && (
            <p
              className="flex flex-wrap items-center gap-x-1.5 text-[12px] tabular-nums text-[var(--wb-text-2)]"
              data-testid={`compare-${side}-meta`}
            >
              <span>
                {data.rowCount.toLocaleString()} row{data.rowCount === 1 ? '' : 's'}
              </span>
              <span aria-hidden>·</span>
              <span>captured {formatCaptured(data.capturedAt)}</span>
              {data.truncated && (
                <>
                  <span aria-hidden>·</span>
                  <span
                    className="text-[var(--status-warn)]"
                    data-testid={`compare-${side}-truncated`}
                  >
                    truncated
                  </span>
                </>
              )}
            </p>
          )}
          {data.sql && (
            <p
              className="truncate font-mono text-[11.5px] text-[var(--wb-text-2)]"
              title={data.sql}
              data-testid={`compare-${side}-sql-line`}
            >
              {data.sql.replace(/\s+/g, ' ')}
            </p>
          )}
          {data.status === 'error' && data.sql && (
            <div className="flex gap-2">
              <Pill onClick={() => rerunSide(tabId, side)}>
                <RotateCw />
                Try again
              </Pill>
              <Pill onClick={() => setEditing(true)}>
                <Pencil />
                Edit query…
              </Pill>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function TabPicker({
  candidates,
  onPick,
}: {
  candidates: ReturnType<typeof comparableTabs>;
  onPick(tabId: string): void;
}) {
  return (
    <PopoverContent align="start" className="w-[270px] p-1" role="menu">
      {candidates.length === 0 ? (
        <p className="px-2 py-2 text-[12px] text-[var(--wb-text-2)]">
          No tab has results yet. Run a query in another tab, or run one here.
        </p>
      ) : (
        candidates.map(({ tab, note }) => (
          <MenuItem
            key={tab.id}
            icon={tab.kind === 'table' ? <Table2 /> : <FileCode />}
            label={tab.title}
            hint={note}
            onClick={() => onPick(tab.id)}
          />
        ))
      )}
    </PopoverContent>
  );
}
