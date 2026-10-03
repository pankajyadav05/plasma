import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ViewTitle, ViewToolbar } from '@/components/ui/view-parts';
import { IconButton, Pill, Segmented } from '@/components/ui/workbench';
import { useSession } from '@/stores/session';
import { Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { AuditLog } from './AuditLog';
import { HistoryBrowser } from './HistoryBrowser';

/**
 * Full-window history view with server-side search + facets (U35) — the
 * single History surface (the ⌘H sheet is gone; ⌘H, the palette and the
 * rail all land here). Clicking an entry opens it in a new SQL tab, the
 * same as the sidebar History list (H2).
 */
export function HistoryCanvas() {
  const history = useSession((s) => s.history);
  const clearHistory = useSession((s) => s.clearHistory);
  const reuseHistoryQuery = useSession((s) => s.reuseHistoryQuery);
  const setCanvasMode = useSession((s) => s.setCanvasMode);

  const [confirmClear, setConfirmClear] = useState(false);
  const [view, setView] = useState<'queries' | 'audit'>('queries');

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <ViewToolbar>
        <ViewTitle
          title={view === 'audit' ? 'Audit log' : 'Query history'}
          meta={
            view === 'audit'
              ? 'Append-only record of statements run on audited connections'
              : 'Click an entry to open it in a new SQL tab'
          }
        />
        <Segmented
          ariaLabel="History view"
          variant="track"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'queries', label: 'Queries' },
            { value: 'audit', label: 'Audit' },
          ]}
        />
        <div className="flex-1" />
        {view === 'queries' && (
          <Pill onClick={() => setConfirmClear(true)} disabled={history.length === 0}>
            <Trash2 />
            Clear…
          </Pill>
        )}
        <IconButton
          variant="plain"
          label="Close history"
          title="Close (Esc)"
          onClick={() => setCanvasMode('database')}
        >
          <X />
        </IconButton>
      </ViewToolbar>

      {view === 'audit' ? (
        <AuditLog />
      ) : (
        <HistoryBrowser onReuse={(sql) => reuseHistoryQuery(sql)} />
      )}

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear all query history?"
        description={`${history.length.toLocaleString()} ${history.length === 1 ? 'entry' : 'entries'} will be removed from the local store. This cannot be undone.`}
        confirmLabel="Clear history"
        onConfirm={() => void clearHistory()}
      />
    </div>
  );
}
