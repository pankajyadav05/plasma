import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, MenuItem, Pill } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { type CompareSession, DIFF_ONLY, savedList, useCompare } from '@/stores/compare';
import { useSession } from '@/stores/session';
import { type DiffKind, filterRows } from '@shared/result-compare';
import {
  AlertTriangle,
  ArrowLeftRight,
  Bookmark,
  ChevronDown,
  Download,
  GitCompare,
  KeyRound,
  Loader2,
  RotateCw,
  Save,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { DiffGrid, KIND_GLYPH } from './DiffGrid';
import { RowDetail } from './RowDetail';
import { SourceCard } from './SourceCard';

const KIND_ORDER: DiffKind[] = ['added', 'removed', 'changed', 'duplicate', 'unchanged'];
const KIND_NOUN: Record<DiffKind, string> = {
  added: 'added',
  removed: 'removed',
  changed: 'changed',
  duplicate: 'duplicate keys',
  unchanged: 'same',
};

function bareCount(n: number) {
  return n.toLocaleString();
}

/** Result Compare: two sides, the matching rules, a summary and the differences. */
export function CompareView({ tabId }: { tabId: string }) {
  const s = useCompare((st) => st.sessions[tabId]);
  if (!s) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center text-[13px] text-[var(--wb-text-2)]">
        This comparison was closed. Open a new one from a result's Compare button.
      </div>
    );
  }
  return <CompareBody s={s} />;
}

function CompareBody({ s }: { s: CompareSession }) {
  const tabId = s.tabId;
  const swap = useCompare((st) => st.swap);
  const rerunAll = useCompare((st) => st.rerunAll);
  const setShow = useCompare((st) => st.setShow);
  const [selected, setSelected] = useState<number | null>(null);
  const [detailOpen, setDetailOpen] = useState(true);

  const ready = s.a.status === 'ready' && s.b.status === 'ready';
  const diff = s.result;
  const left = s.resultFor?.a ?? null;
  const right = s.resultFor?.b ?? null;
  const shown = useMemo(() => (diff ? filterRows(diff.rows, new Set(s.show)) : []), [diff, s.show]);

  // Selection belongs to one set of rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the shown rows change
  useEffect(() => setSelected(null), [diff, s.show]);

  const row = selected !== null ? (shown[selected] ?? null) : null;
  const comparing = s.phase === 'comparing';

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-[var(--wb-content)]"
      data-testid="compare-view"
      data-phase={s.phase}
    >
      <div className="flex shrink-0 items-stretch gap-2 px-3 pb-2 pt-3">
        <SourceCard tabId={tabId} side="a" />
        <div className="flex items-center">
          <IconButton
            label="Swap A and B"
            onClick={() => swap(tabId)}
            disabled={s.a.status === 'empty' && s.b.status === 'empty'}
            data-testid="compare-swap"
          >
            <ArrowLeftRight />
          </IconButton>
        </div>
        <SourceCard tabId={tabId} side="b" />
      </div>

      <OptionsBar s={s} />

      {ready && (
        <SummaryBar
          s={s}
          shownCount={shown.length}
          onToggle={(kind) => {
            const next = s.show.includes(kind)
              ? s.show.filter((k) => k !== kind)
              : [...s.show, kind];
            setShow(tabId, next);
          }}
          onReset={() => setShow(tabId, DIFF_ONLY)}
          onRerun={() => rerunAll(tabId)}
        />
      )}
      <Notices s={s} />

      <div className="relative flex min-h-0 flex-1 flex-col border-t border-[var(--wb-separator)]">
        {comparing && (
          <div
            aria-hidden
            data-testid="compare-progress"
            className="absolute inset-x-0 top-0 z-40 h-[2px] bg-[var(--wb-control)]"
          >
            <div
              className="h-full bg-[var(--wb-accent)] transition-[width]"
              style={{ width: `${Math.round(s.progress * 100)}%` }}
            />
          </div>
        )}
        {diff && left && right ? (
          shown.length > 0 ? (
            <DiffGrid
              diff={diff}
              left={left}
              right={right}
              rows={shown}
              selected={selected}
              onSelect={setSelected}
            />
          ) : (
            <EmptyDiff s={s} />
          )
        ) : (
          <Waiting s={s} />
        )}
        {diff && left && right && row && detailOpen && (
          <RowDetail
            diff={diff}
            left={left}
            right={right}
            row={row}
            onClose={() => setDetailOpen(false)}
          />
        )}
        {row && !detailOpen && (
          <button
            type="button"
            onClick={() => setDetailOpen(true)}
            className="h-7 shrink-0 border-t border-[var(--wb-separator)] px-3 text-left text-[12px] text-[var(--wb-text-2)] hover:text-[var(--wb-text)]"
          >
            Show row detail
          </button>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── options ─────────────────────────────

function ColumnChecklist({
  columns,
  chosen,
  onToggle,
  hint,
}: {
  columns: string[];
  chosen: string[];
  onToggle(col: string): void;
  hint?: (col: string) => string | undefined;
}) {
  return (
    <div className="max-h-[260px] overflow-auto">
      {columns.map((c) => (
        // biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox is the control
        <label
          key={c}
          className="flex h-[24px] cursor-default items-center gap-2 rounded-[4px] px-2 text-[13px] text-[var(--wb-text)] hover:bg-[var(--wb-control-hover)]"
        >
          <Checkbox
            checked={chosen.some((x) => x.toLowerCase() === c.toLowerCase())}
            onCheckedChange={() => onToggle(c)}
            aria-label={c}
          />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{c}</span>
          {hint?.(c) && <span className="text-[11px] text-[var(--wb-text-2)]">{hint(c)}</span>}
        </label>
      ))}
    </div>
  );
}

function OptionsBar({ s }: { s: CompareSession }) {
  const tabId = s.tabId;
  const setOptions = useCompare((st) => st.setOptions);
  const exportDiff = useCompare((st) => st.exportDiff);
  const [keysOpen, setKeysOpen] = useState(false);
  const [ignoreOpen, setIgnoreOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const ready = s.a.status === 'ready' && s.b.status === 'ready';
  const o = s.options;

  // Columns both sides have, then the union for the ignore list.
  const shared = useMemo(() => {
    const a = s.a.source?.columns ?? [];
    const b = (s.b.source?.columns ?? []).map((c) => c.toLowerCase());
    return a.filter((c) => b.includes(c.toLowerCase()));
  }, [s.a.source, s.b.source]);
  const all = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of [...(s.a.source?.columns ?? []), ...(s.b.source?.columns ?? [])]) {
      if (!seen.has(c.toLowerCase())) {
        seen.add(c.toLowerCase());
        out.push(c);
      }
    }
    return out;
  }, [s.a.source, s.b.source]);

  const toggle = (list: string[], col: string) =>
    list.some((x) => x.toLowerCase() === col.toLowerCase())
      ? list.filter((x) => x.toLowerCase() !== col.toLowerCase())
      : [...list, col];

  const keyLabel =
    o.keys.length > 0 ? `Key: ${o.keys.join(', ')}` : ready ? 'No key (whole rows)' : 'Key';
  const reasonOf = (c: string) =>
    s.suggestions.find((x) => x.keys.length === 1 && x.keys[0]!.toLowerCase() === c.toLowerCase())
      ?.reason;

  return (
    <div
      className="@container flex min-h-[36px] shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--wb-separator)] px-3 py-1"
      data-testid="compare-options"
    >
      <Popover open={keysOpen} onOpenChange={setKeysOpen}>
        <PopoverTrigger asChild>
          <Pill
            disabled={!ready}
            data-testid="compare-keys"
            title="Columns that identify the same row on both sides"
          >
            <KeyRound />
            <span className="max-w-[260px] truncate">{keyLabel}</span>
            <ChevronDown className="!h-3 !w-3" />
          </Pill>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[290px] p-1.5">
          <p className="px-1.5 pb-1 text-[12px] text-[var(--wb-text-2)]">
            Rows match when these columns are equal. With none chosen, whole rows are compared.
          </p>
          {s.suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1 px-1.5 pb-1.5" data-testid="compare-suggestions">
              {s.suggestions.map((sg) => (
                <button
                  type="button"
                  key={sg.keys.join(',')}
                  onClick={() => setOptions(tabId, { keys: sg.keys })}
                  className="rounded-[10px] bg-[var(--wb-control)] px-2 py-0.5 text-[11.5px] text-[var(--wb-text)] hover:bg-[var(--wb-control-hover)]"
                  title={`Use ${sg.keys.join(' + ')} (${sg.reason})`}
                >
                  {sg.keys.join(' + ')}{' '}
                  <span className="text-[var(--wb-text-2)]">· {sg.reason}</span>
                </button>
              ))}
            </div>
          )}
          <ColumnChecklist
            columns={shared}
            chosen={o.keys}
            onToggle={(c) => setOptions(tabId, { keys: toggle(o.keys, c) })}
            hint={reasonOf}
          />
          {o.keys.length > 0 && (
            <button
              type="button"
              onClick={() => setOptions(tabId, { keys: [] })}
              className="mt-1 px-2 text-[12px] text-[var(--wb-text-2)] underline-offset-2 hover:text-[var(--wb-text)] hover:underline"
            >
              Clear key
            </button>
          )}
        </PopoverContent>
      </Popover>

      <Popover open={ignoreOpen} onOpenChange={setIgnoreOpen}>
        <PopoverTrigger asChild>
          <Pill
            disabled={!ready}
            data-testid="compare-ignore"
            title="Columns left out of the comparison, like updated_at"
          >
            {o.ignore.length > 0 ? `Ignoring ${o.ignore.length}` : 'Ignore columns'}
            <ChevronDown className="!h-3 !w-3" />
          </Pill>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[260px] p-1.5">
          <p className="px-1.5 pb-1 text-[12px] text-[var(--wb-text-2)]">
            Left out of the comparison, for example updated_at.
          </p>
          <ColumnChecklist
            columns={all}
            chosen={o.ignore}
            onToggle={(c) =>
              setOptions(tabId, {
                ignore: toggle(o.ignore, c),
                keys: o.keys.filter((k) => k.toLowerCase() !== c.toLowerCase()),
              })
            }
          />
        </PopoverContent>
      </Popover>

      <label
        htmlFor={`compare-tolerance-${tabId}`}
        className="flex items-center gap-1.5 text-[12px] text-[var(--wb-text-2)]"
      >
        <span title="Numbers closer than this count as equal">± tolerance</span>
        <Input
          id={`compare-tolerance-${tabId}`}
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          aria-label="Numeric tolerance"
          data-testid="compare-tolerance"
          className="h-[24px] w-[72px] px-1.5 text-right font-mono text-[12px] tabular-nums"
          value={o.tolerance === 0 ? '' : o.tolerance}
          placeholder="0"
          onChange={(e) => {
            const n = Number(e.target.value);
            setOptions(tabId, { tolerance: Number.isFinite(n) && n >= 0 ? n : 0 });
          }}
        />
      </label>

      <Pill
        aria-pressed={o.ignoreCase}
        onClick={() => setOptions(tabId, { ignoreCase: !o.ignoreCase })}
        data-testid="compare-ignore-case"
        title="Treat Alice and alice as equal"
        className={cn(o.ignoreCase && 'bg-[var(--wb-control-active)] text-[var(--wb-text)]')}
      >
        Ignore case
      </Pill>
      <Pill
        aria-pressed={o.trimWhitespace}
        onClick={() => setOptions(tabId, { trimWhitespace: !o.trimWhitespace })}
        data-testid="compare-trim"
        title="Ignore leading, trailing and repeated spaces in text"
        className={cn(o.trimWhitespace && 'bg-[var(--wb-control-active)] text-[var(--wb-text)]')}
      >
        Ignore spaces
      </Pill>

      <span className="flex-1" />

      <SavedMenu s={s} />

      <Popover open={exportOpen} onOpenChange={setExportOpen}>
        <PopoverTrigger asChild>
          <Pill disabled={!s.result} data-testid="compare-export">
            <Download />
            <span className="@max-[860px]:hidden">Export</span>
            <ChevronDown className="!h-3 !w-3 @max-[860px]:hidden" />
          </Pill>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[250px] p-1" role="menu">
          <MenuItem
            label="Differences as CSV…"
            onClick={() => {
              setExportOpen(false);
              void exportDiff(tabId, 'csv');
            }}
          />
          <MenuItem
            label="Differences as JSON…"
            onClick={() => {
              setExportOpen(false);
              void exportDiff(tabId, 'json');
            }}
          />
          <p className="px-2 pb-1 pt-1.5 text-[11px] text-[var(--wb-text-3)]">
            Exports the kinds shown below: {s.show.map((k) => KIND_NOUN[k]).join(', ') || 'none'}.
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SavedMenu({ s }: { s: CompareSession }) {
  const tabId = s.tabId;
  const save = useCompare((st) => st.save);
  const load = useCompare((st) => st.load);
  const remove = useCompare((st) => st.remove);
  // Re-read when settings change.
  useSession((st) => st.settings.savedComparisons);
  const list = savedList();
  const [open, setOpen] = useState(false);
  const ready = s.a.status === 'ready' && s.b.status === 'ready';
  const current = list.find((c) => c.id === s.savedId);
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) setName(current?.name ?? `${s.a.connectionName} vs ${s.b.connectionName}`);
  }, [open, current?.name, s.a.connectionName, s.b.connectionName]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Pill data-testid="compare-saved">
          <Bookmark />
          <span className="max-w-[160px] truncate @max-[860px]:hidden">
            {current ? current.name : 'Saved'}
          </span>
          <ChevronDown className="!h-3 !w-3 @max-[860px]:hidden" />
        </Pill>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-2">
        <div className="flex items-center gap-1.5">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Comparison name"
            data-testid="compare-save-name"
            className="h-[24px] text-[12px]"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) {
                save(tabId, name);
                setOpen(false);
              }
            }}
          />
          <Pill
            disabled={!ready || name.trim() === ''}
            data-testid="compare-save"
            onClick={() => {
              save(tabId, name);
              setOpen(false);
            }}
          >
            <Save />
            {current ? 'Update' : 'Save'}
          </Pill>
        </div>
        <p className="px-0.5 pb-1 pt-1.5 text-[11px] text-[var(--wb-text-3)]">
          Saves both queries, their connections, the key and the ignore rules. Not the rows.
        </p>
        {list.length > 0 && (
          <div className="mt-1 max-h-[220px] overflow-auto border-t border-[var(--wb-separator)] pt-1">
            {list.map((c) => (
              <div
                key={c.id}
                className="group flex items-center gap-1 rounded-[4px] hover:bg-[var(--wb-control-hover)]"
                data-testid="compare-saved-item"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 px-2 py-1 text-left"
                  onClick={() => {
                    load(tabId, c);
                    setOpen(false);
                  }}
                >
                  <span className="block truncate text-[13px] text-[var(--wb-text)]">{c.name}</span>
                  <span className="block truncate text-[11px] text-[var(--wb-text-2)]">
                    {c.a.connectionName ?? 'active'} → {c.b.connectionName ?? 'active'}
                  </span>
                </button>
                <IconButton
                  label={`Delete ${c.name}`}
                  variant="plain"
                  onClick={() => remove(c.id)}
                  className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <Trash2 />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ───────────────────────────── summary ─────────────────────────────

function SummaryBar({
  s,
  shownCount,
  onToggle,
  onReset,
  onRerun,
}: {
  s: CompareSession;
  shownCount: number;
  onToggle(k: DiffKind): void;
  onReset(): void;
  onRerun(): void;
}) {
  const sum = s.result?.summary;
  const total = sum ? sum.added + sum.removed + sum.changed + sum.unchanged + sum.duplicates : 0;
  const counts: Record<DiffKind, number> = {
    added: sum?.added ?? 0,
    removed: sum?.removed ?? 0,
    changed: sum?.changed ?? 0,
    duplicate: sum?.duplicates ?? 0,
    unchanged: sum?.unchanged ?? 0,
  };
  const identical =
    sum && sum.added === 0 && sum.removed === 0 && sum.changed === 0 && sum.duplicates === 0;
  return (
    <div
      className="flex min-h-[34px] shrink-0 flex-wrap items-center gap-1.5 border-t border-[var(--wb-separator)] px-3 py-1"
      data-testid="compare-summary"
    >
      {s.phase === 'comparing' && !sum ? (
        <span className="flex items-center gap-1.5 text-[12px] text-[var(--wb-text-2)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Comparing… {Math.round(s.progress * 100)}%
        </span>
      ) : (
        KIND_ORDER.map((kind) => {
          if (kind === 'duplicate' && counts.duplicate === 0) return null;
          const on = s.show.includes(kind);
          const g = KIND_GLYPH[kind];
          return (
            <button
              type="button"
              key={kind}
              aria-pressed={on}
              onClick={() => onToggle(kind)}
              data-testid={`compare-filter-${kind}`}
              data-count={counts[kind]}
              title={`${on ? 'Hide' : 'Show'} ${KIND_NOUN[kind]} rows`}
              className={cn(
                'flex h-[22px] items-center gap-1.5 rounded-[11px] px-2 text-[12px] tabular-nums transition-colors',
                on
                  ? 'bg-[var(--wb-control-active)] text-[var(--wb-text)]'
                  : 'bg-transparent text-[var(--wb-text-2)] shadow-[inset_0_0_0_1px_var(--wb-separator)] hover:text-[var(--wb-text)]',
              )}
            >
              <span
                aria-hidden
                className="w-3 text-center font-semibold"
                style={{ color: g.color }}
              >
                {g.glyph}
              </span>
              <span className="font-medium">{bareCount(counts[kind])}</span>
              <span>{KIND_NOUN[kind]}</span>
            </button>
          );
        })
      )}
      <span className="flex-1" />
      {sum && (
        <span
          className="text-[12px] tabular-nums text-[var(--wb-text-2)]"
          data-testid="compare-shown"
        >
          {identical && s.show.every((k) => DIFF_ONLY.includes(k))
            ? 'Identical'
            : `Showing ${bareCount(shownCount)} of ${bareCount(total)}`}
        </span>
      )}
      {sum && !s.show.every((k) => DIFF_ONLY.includes(k)) && (
        <button
          type="button"
          onClick={onReset}
          className="text-[12px] text-[var(--wb-text-2)] underline-offset-2 hover:text-[var(--wb-text)] hover:underline"
        >
          Differences only
        </button>
      )}
      <IconButton label="Run both sides again" onClick={onRerun} data-testid="compare-rerun">
        <RotateCw />
      </IconButton>
      {s.exportNote && (
        <output
          className="basis-full truncate text-[12px] text-[var(--wb-text-2)]"
          data-testid="compare-export-note"
        >
          {s.exportNote}
        </output>
      )}
    </div>
  );
}

// ───────────────────────────── notices & empty states ─────────────────────────────

function Notice({
  children,
  tone = 'warn',
  testid,
}: {
  children: React.ReactNode;
  tone?: 'warn' | 'error' | 'info';
  testid: string;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid={testid}
      className={cn(
        'flex items-start gap-2 border-t border-[var(--wb-separator)] px-3 py-1.5 text-[12px] leading-[17px]',
        tone === 'error' ? 'text-destructive' : 'text-[var(--wb-text-2)]',
      )}
    >
      <AlertTriangle
        className={cn(
          'mt-[2px] h-3.5 w-3.5 shrink-0',
          tone === 'warn' && 'text-[var(--status-warn)]',
          tone === 'error' && 'text-destructive',
        )}
        aria-hidden
      />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Notices({ s }: { s: CompareSession }) {
  const d = s.result;
  const out: React.ReactNode[] = [];
  if (s.phase === 'error' && s.error) {
    out.push(
      <Notice key="err" tone="error" testid="compare-error">
        {s.error}
      </Notice>,
    );
  }
  for (const side of ['a', 'b'] as const) {
    const x = s[side];
    if (x.status === 'ready' && x.truncated) {
      out.push(
        <Notice key={`t${side}`} testid={`compare-truncated-${side}`}>
          Side {side.toUpperCase()} stopped at {x.rowCount.toLocaleString()} rows, so rows past that
          were not compared. Some added or removed rows may only be missing from the other side's
          cut-off. Narrow the query to compare everything.
        </Notice>,
      );
    }
  }
  if (d && s.options.keys.length === 0 && s.phase !== 'comparing') {
    out.push(
      <Notice key="nokey" testid="compare-nokey">
        No key chosen, so whole rows are matched. A row that changed shows as one removed and one
        added. Pick a key to see changes cell by cell.
      </Notice>,
    );
  }
  if (d && (d.onlyLeft.length > 0 || d.onlyRight.length > 0)) {
    out.push(
      <Notice key="cols" testid="compare-columns-note">
        Not compared
        {d.onlyLeft.length > 0 && (
          <>
            {' '}
            · only in A: <span className="font-mono">{d.onlyLeft.join(', ')}</span>
          </>
        )}
        {d.onlyRight.length > 0 && (
          <>
            {' '}
            · only in B: <span className="font-mono">{d.onlyRight.join(', ')}</span>
          </>
        )}
      </Notice>,
    );
  }
  if (d && d.summary.duplicates > 0) {
    out.push(
      <Notice key="dups" testid="compare-dup-notice">
        {d.summary.duplicates.toLocaleString()} key
        {d.summary.duplicates === 1 ? '' : 's'} appear more than once on a side. Those rows are
        listed but not matched. Add a column to the key to tell them apart.
      </Notice>,
    );
  }
  if (out.length === 0) return null;
  return <div data-testid="compare-notices">{out}</div>;
}

function Waiting({ s }: { s: CompareSession }) {
  const need = [s.a.status !== 'ready' ? 'A' : null, s.b.status !== 'ready' ? 'B' : null].filter(
    Boolean,
  );
  const failed = s.a.status === 'error' || s.b.status === 'error';
  return (
    <div
      className="grid min-h-0 flex-1 place-items-center px-6 text-center"
      data-testid="compare-waiting"
    >
      <div className="flex max-w-[380px] flex-col items-center gap-2 text-[13px] text-[var(--wb-text-2)]">
        <GitCompare className="h-6 w-6 text-[var(--wb-text-3)]" strokeWidth={1.5} aria-hidden />
        <p className="text-[15px] font-semibold text-[var(--wb-text)]">
          {failed ? 'One side did not load' : 'Compare two results'}
        </p>
        <p>
          {failed
            ? 'Fix the query or pick another source, then the comparison runs by itself.'
            : s.a.status === 'loading' || s.b.status === 'loading'
              ? 'Waiting for the query to finish…'
              : `Choose where side ${need.join(' and ')} comes from. Staging against prod is one query on two connections.`}
        </p>
      </div>
    </div>
  );
}

function EmptyDiff({ s }: { s: CompareSession }) {
  const sum = s.result?.summary;
  const identical =
    sum && sum.added === 0 && sum.removed === 0 && sum.changed === 0 && sum.duplicates === 0;
  return (
    <div
      className="grid min-h-0 flex-1 place-items-center px-6 text-center"
      data-testid="compare-empty"
    >
      <div className="flex max-w-[380px] flex-col items-center gap-1.5 text-[13px] text-[var(--wb-text-2)]">
        <p className="text-[15px] font-semibold text-[var(--wb-text)]">
          {identical ? 'No differences' : 'Nothing to show'}
        </p>
        <p>
          {identical
            ? `All ${sum ? sum.unchanged.toLocaleString() : 0} rows match${s.options.ignore.length ? ' (ignored columns left out)' : ''}. Turn on "same" to see them.`
            : 'Every kind of row is hidden. Turn a filter on above.'}
        </p>
      </div>
    </div>
  );
}
