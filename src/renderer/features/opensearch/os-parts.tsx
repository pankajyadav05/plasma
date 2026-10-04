import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge, EmptyState } from '@/components/ui/view-parts';
import { IconButton, MenuItem, Pill } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { cleanIpcError } from '@/lib/errors';
import { kbd } from '@/lib/platform';
import { useWorkbench } from '@/stores/workbench';
import {
  AlertCircle,
  Bookmark,
  Clock,
  History,
  Loader2,
  Play,
  SlidersHorizontal,
  Square,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { type OsHistoryEntry, type OsQueryKind, type OsSavedQuery, useOsStore } from './os-store';

/** Clean an IPC rejection for display (O9 — one cleaner everywhere). */
export function errMessage(err: unknown): string {
  return cleanIpcError(err instanceof Error ? err.message : String(err)).replace(/^Error:\s*/i, '');
}

/** OpenSearch alias of the shared sentence-case Badge (O23). */
export function OsBadge({
  children,
  tone,
  className,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'warn' | 'danger';
  className?: string;
}) {
  return (
    <Badge tone={tone} className={className}>
      {children}
    </Badge>
  );
}

/** 36px editor footer: sliders glyph + mono hint left, pills right (Postgres editor bar). */
export function EditorBar({ hint, right }: { hint: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="flex h-9 min-w-0 shrink-0 items-center gap-1.5 overflow-hidden border-t border-[var(--wb-separator)] bg-[var(--wb-content)] px-2.5">
      <SlidersHorizontal
        className="h-4 w-4 shrink-0 text-[var(--wb-text-2)]"
        strokeWidth={1.5}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-[12px] tabular-nums text-[var(--wb-text-2)]">
        {hint}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">{right}</div>
    </div>
  );
}

/** Neutral `Run ⌘↵` pill; while running it becomes Cancel (O6). */
export function RunPill({
  running,
  disabled,
  onRun,
  onCancel,
}: {
  running: boolean;
  disabled?: boolean;
  onRun: () => void;
  onCancel?: () => void;
}) {
  if (running && onCancel) {
    return (
      <Pill onClick={onCancel} title="Cancel the running request" aria-label="Cancel">
        <Square className="fill-current" />
        Cancel
      </Pill>
    );
  }
  return (
    <Pill
      onClick={onRun}
      disabled={running || disabled}
      title={`Run (${kbd('⏎')})`}
      aria-label="Run"
    >
      {running ? <Loader2 className="animate-spin" /> : <Play className="fill-current" />}
      <span className="whitespace-nowrap">{running ? 'Running' : 'Run'}</span>
      <span className="whitespace-nowrap font-mono text-[12px] text-[var(--wb-text-2)]">
        {kbd('⏎')}
      </span>
    </Pill>
  );
}

export const TIMEOUT_CHOICES = [10_000, 30_000, 60_000, 300_000, 900_000] as const;

function timeoutLabel(ms: number): string {
  return ms >= 60_000 ? `${ms / 60_000} min` : `${ms / 1000} s`;
}

/** Per-request timeout picker (O6). */
export function TimeoutMenu({
  value,
  onChange,
}: { value: number; onChange: (ms: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton label={`Timeout: ${timeoutLabel(value)}`} variant="plain">
          <Clock />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={6} className="w-[170px] p-1" role="menu">
        <div className="px-2 pb-1 pt-0.5 text-[12px] text-[var(--wb-text-2)]">Request timeout</div>
        {TIMEOUT_CHOICES.map((ms) => (
          <MenuItem
            key={ms}
            label={timeoutLabel(ms)}
            checked={value === ms}
            onClick={() => {
              onChange(ms);
              setOpen(false);
            }}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** Destructive "Query failed" panel, identical to the Postgres result grid's. */
export function QueryErrorPanel({
  message,
  title = 'Query failed',
}: { message: string; title?: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--wb-content)]">
      <div className="max-w-4xl p-5">
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-[8px] bg-destructive/10 px-3.5 py-3 ring-1 ring-inset ring-destructive/30"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <div className="mb-1 text-xs font-semibold text-destructive">{title}</div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[13px] text-[var(--wb-text)]">
              {cleanIpcError(message)}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

export function RunningState({ label }: { label: string }) {
  return (
    <EmptyState
      title={
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          {label}
        </span>
      }
    />
  );
}

/** Raw JSON body for the footer's "JSON" view. */
export function JsonBody({ value }: { value: unknown }) {
  // Text responses (_cat, plain-text APIs) come back as strings; show them verbatim.
  const text = useMemo(
    () => (typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    [value],
  );
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-[var(--wb-content)]">
      <pre className="p-3 font-mono text-[12px] leading-5 text-[var(--wb-text)]">{text}</pre>
    </div>
  );
}

export function clearInspected(tabId: string) {
  const wb = useWorkbench.getState();
  if (wb.inspectedRow?.tabId === tabId) wb.setInspectedRow(null);
}

/** True for ⌘⏎ / Ctrl+⏎ that nothing else handled (O8: scoped to the view). */
export function isRunShortcut(e: React.KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.defaultPrevented;
}

/**
 * History + saved queries menu for one query kind (O18). Picking an entry
 * loads it into the editor via `onPick`; "Save current…" stores the
 * current text under a name.
 */
export function QueryLibraryMenu({
  kinds,
  current,
  onPick,
}: {
  kinds: OsQueryKind[];
  current: Omit<OsSavedQuery, 'id' | 'savedAt' | 'name'> | null;
  onPick: (entry: OsHistoryEntry | OsSavedQuery) => void;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const history = useOsStore((s) => s.history);
  const saved = useOsStore((s) => s.saved);
  const saveQuery = useOsStore((s) => s.saveQuery);
  const deleteSaved = useOsStore((s) => s.deleteSaved);
  const clearHistory = useOsStore((s) => s.clearHistory);
  const mine = (e: { kind: OsQueryKind }) => kinds.includes(e.kind);
  const savedList = saved.filter(mine);
  const historyList = history.filter(mine).slice(0, 30);

  const label = (e: OsHistoryEntry | OsSavedQuery) => {
    const head = e.kind === 'console' ? `${e.method} ${e.path}` : e.text.replace(/\s+/g, ' ');
    return head.length > 70 ? `${head.slice(0, 70)}…` : head || '(empty)';
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setNaming(null);
      }}
    >
      <PopoverTrigger asChild>
        <IconButton label="Saved queries and history" variant="plain">
          <History />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={6} className="w-[380px] p-1" role="menu">
        {current &&
          (naming === null ? (
            <MenuItem
              icon={<Bookmark />}
              label="Save current query…"
              onClick={() => setNaming('')}
            />
          ) : (
            <form
              className="flex items-center gap-1 px-1 py-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (!naming.trim()) return;
                saveQuery({ ...current, name: naming.trim() });
                setNaming(null);
              }}
            >
              <input
                // biome-ignore lint/a11y/noAutofocus: inline name field opened on demand
                autoFocus
                value={naming}
                onChange={(e) => setNaming(e.target.value)}
                placeholder="Query name"
                aria-label="Query name"
                className="h-6 min-w-0 flex-1 rounded-[6px] bg-[var(--wb-field)] px-2 text-[13px] text-[var(--wb-text)] outline-none"
              />
              <Pill type="submit" disabled={!naming.trim()}>
                Save
              </Pill>
            </form>
          ))}
        <div className="px-2 pb-0.5 pt-1.5 text-[12px] text-[var(--wb-text-2)]">Saved</div>
        {savedList.length === 0 ? (
          <div className="px-2 pb-1 text-[12px] text-[var(--wb-text-3)]">No saved queries</div>
        ) : (
          savedList.map((q) => (
            <div key={q.id} className="group/saved flex items-center">
              <div className="min-w-0 flex-1">
                <MenuItem
                  label={
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0">{q.name}</span>
                      <span className="truncate font-mono text-[11px] opacity-60">{label(q)}</span>
                    </span>
                  }
                  onClick={() => {
                    onPick(q);
                    setOpen(false);
                  }}
                />
              </div>
              <IconButton
                variant="plain"
                label={`Delete saved query ${q.name}`}
                className="h-5 w-5 opacity-0 group-hover/saved:opacity-100 focus-visible:opacity-100"
                onClick={() => deleteSaved(q.id)}
              >
                <Trash2 />
              </IconButton>
            </div>
          ))
        )}
        <div className="my-1 h-px bg-[var(--wb-separator)]" />
        <div className="flex items-center px-2 pb-0.5 pt-0.5 text-[12px] text-[var(--wb-text-2)]">
          <span className="flex-1">History</span>
          {historyList.length > 0 && (
            <button
              type="button"
              className="text-[12px] text-[var(--wb-text-3)] hover:text-[var(--wb-text)]"
              onClick={clearHistory}
            >
              Clear
            </button>
          )}
        </div>
        <div className="max-h-[260px] overflow-y-auto">
          {historyList.length === 0 ? (
            <div className="px-2 pb-1 text-[12px] text-[var(--wb-text-3)]">Nothing run yet</div>
          ) : (
            historyList.map((h) => (
              <MenuItem
                key={h.id}
                label={
                  <span className={cn('font-mono text-[12px]', !h.ok && 'text-destructive')}>
                    {label(h)}
                  </span>
                }
                hint={new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                onClick={() => {
                  onPick(h);
                  setOpen(false);
                }}
              />
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
