import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/ui/view-parts';
import { formatDuration } from '@/lib/format';
import { useSession } from '@/stores/session';
import type { HistoryDurationFacet, HistoryEntry, HistoryStatusFacet } from '@shared/protocol';
import { BookmarkPlus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

/** History list + server-side facets (U35), shown on the History canvas. */
export function HistoryBrowser({
  onReuse,
  compact = false,
}: {
  onReuse: (sql: string) => void;
  compact?: boolean;
}) {
  const history = useSession((s) => s.history);
  const filter = useSession((s) => s.historyFilter);
  const loadHistory = useSession((s) => s.loadHistory);
  const setHistoryFilter = useSession((s) => s.setHistoryFilter);
  const saveHistoryAsSnippet = useSession((s) => s.saveHistoryAsSnippet);
  const savedConnections = useSession((s) => s.savedConnections);
  const activeConfigId = useSession((s) => s.activeConfig?.id);

  const [searchDraft, setSearchDraft] = useState(filter.search ?? '');
  const [namingId, setNamingId] = useState<number | null>(null);
  const [snippetName, setSnippetName] = useState('');

  // Debounce search → server-side LIKE.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const next = searchDraft.trim();
      if ((filter.search ?? '') === next) return;
      setHistoryFilter({ search: next || undefined });
      void loadHistory({ search: next || undefined });
    }, 200);
    return () => window.clearTimeout(handle);
  }, [searchDraft, filter.search, loadHistory, setHistoryFilter]);

  const connectionValue = useMemo(() => {
    if (filter.connectionId === '') return 'all';
    const id = filter.connectionId ?? activeConfigId;
    if (!id) return 'all';
    if (savedConnections.some((c) => c.id === id) || id === activeConfigId) return id;
    return 'all';
  }, [filter.connectionId, activeConfigId, savedConnections]);

  const connName = useMemo(() => {
    const map = new Map(savedConnections.map((c) => [c.id, c.name]));
    return (id: string | null) => (id ? (map.get(id) ?? id.slice(0, 8)) : 'unknown');
  }, [savedConnections]);

  const setFacet = (patch: Parameters<typeof setHistoryFilter>[0]) => {
    setHistoryFilter(patch);
    void loadHistory(patch);
  };

  const previewLen = compact ? 400 : 800;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--wb-separator)] px-2.5 py-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--wb-text-2)]" />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search SQL…"
            className="pl-7"
            aria-label="Search query history"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={connectionValue}
            onValueChange={(v) => {
              const connectionId = v === 'all' ? '' : v;
              setFacet({ connectionId });
            }}
          >
            <SelectTrigger className="w-[160px]" aria-label="Connection facet">
              <SelectValue placeholder="Connection" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All connections</SelectItem>
              {activeConfigId && !savedConnections.some((c) => c.id === activeConfigId) && (
                <SelectItem value={activeConfigId}>Current connection</SelectItem>
              )}
              {savedConnections.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={(filter.status as HistoryStatusFacet | undefined) ?? 'all'}
            onValueChange={(v) => setFacet({ status: v as HistoryStatusFacet })}
          >
            <SelectTrigger className="w-[120px]" aria-label="Status facet">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              <SelectItem value="ok">Succeeded</SelectItem>
              <SelectItem value="error">Errors</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={(filter.duration as HistoryDurationFacet | undefined) ?? 'all'}
            onValueChange={(v) => setFacet({ duration: v as HistoryDurationFacet })}
          >
            <SelectTrigger className="w-[130px]" aria-label="Duration facet">
              <SelectValue placeholder="Duration" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any duration</SelectItem>
              <SelectItem value="fast">Fast (&lt;100ms)</SelectItem>
              <SelectItem value="medium">Medium (100ms–1s)</SelectItem>
              <SelectItem value="slow">Slow (&gt;1s)</SelectItem>
            </SelectContent>
          </Select>

          <span className="text-[12px] text-[var(--wb-text-2)]" aria-live="polite">
            {history.length.toLocaleString()} shown
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {history.length === 0 ? (
          <EmptyState
            title="No matching history"
            hint="Run a query, or clear the search and filters."
          />
        ) : (
          <ul className="flex flex-col">
            {history.map((entry) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                previewLen={previewLen}
                connLabel={connName(entry.connectionId)}
                naming={namingId === entry.id}
                snippetName={namingId === entry.id ? snippetName : ''}
                onSnippetName={setSnippetName}
                onStartSave={() => {
                  setNamingId(entry.id);
                  setSnippetName(defaultSnippetName(entry.sql));
                }}
                onCancelSave={() => {
                  setNamingId(null);
                  setSnippetName('');
                }}
                onConfirmSave={() => {
                  void saveHistoryAsSnippet(entry.sql, snippetName, entry.connectionId).then(() => {
                    setNamingId(null);
                    setSnippetName('');
                  });
                }}
                onReuse={() => onReuse(entry.sql)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function defaultSnippetName(sql: string): string {
  const line = sql.trim().split(/\r?\n/, 1)[0] ?? 'query';
  return line.slice(0, 60) || 'query';
}

function HistoryRow({
  entry,
  previewLen,
  connLabel,
  naming,
  snippetName,
  onSnippetName,
  onStartSave,
  onCancelSave,
  onConfirmSave,
  onReuse,
}: {
  entry: HistoryEntry;
  previewLen: number;
  connLabel: string;
  naming: boolean;
  snippetName: string;
  onSnippetName: (v: string) => void;
  onStartSave: () => void;
  onCancelSave: () => void;
  onConfirmSave: () => void;
  onReuse: () => void;
}) {
  return (
    <li className="group/hist border-b border-[var(--wb-separator)] hover:bg-[color-mix(in_srgb,var(--wb-text)_4%,transparent)]">
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onReuse}
          title="Open in a new SQL tab"
          className="min-w-0 flex-1 cursor-pointer rounded-[5px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex flex-wrap items-center gap-3 text-[12px] text-[var(--wb-text-2)]">
            <span>{new Date(entry.executedAt).toLocaleString()}</span>
            <span className="rounded-[4px] bg-[var(--wb-control)] px-1.5 py-0.5 text-[11px]">
              {connLabel}
            </span>
            {entry.error ? (
              <span className="text-destructive">Error</span>
            ) : (
              <>
                {entry.rowCount !== null && <span>{entry.rowCount.toLocaleString()} rows</span>}
                {entry.durationMs !== null && <span>{formatDuration(entry.durationMs)}</span>}
              </>
            )}
          </div>
          <pre className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap break-words font-mono text-[12px] text-[var(--wb-text)]">
            {entry.sql.slice(0, previewLen)}
            {entry.sql.length > previewLen ? '…' : ''}
          </pre>
          {entry.error && (
            <div className="mt-1 font-mono text-[12px] text-destructive">{entry.error}</div>
          )}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-24"
          className="opacity-0 group-hover/hist:opacity-100 focus-visible:opacity-100"
          title="Save as snippet"
          aria-label="Save as snippet"
          onClick={(e) => {
            e.stopPropagation();
            onStartSave();
          }}
        >
          <BookmarkPlus />
        </Button>
      </div>
      {naming && (
        <div className="flex items-center gap-2 border-t border-[var(--wb-separator)] bg-[var(--wb-sidebar)] px-3 py-2">
          <Input
            autoFocus
            value={snippetName}
            onChange={(e) => onSnippetName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onConfirmSave();
              else if (e.key === 'Escape') onCancelSave();
            }}
            placeholder="Snippet name…"
            className="max-w-[360px]"
            aria-label="Snippet name"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={!snippetName.trim()}
            onClick={onConfirmSave}
          >
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancelSave}>
            Cancel
          </Button>
        </div>
      )}
    </li>
  );
}
