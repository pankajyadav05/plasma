import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { fileBaseName } from '@/lib/engine-meta';
import { confirmPendingDrop, reopenWithAttachments, useDataFiles } from '@/stores/data-files';
import { useSession } from '@/stores/session';
import { useEffect, useState } from 'react';

/** Dialogs of "Open data file…", mounted once in App. */
export function DataFilesDialogs() {
  return (
    <>
      <NoticeDialog />
      <DropConfirm />
      <AttachDialog />
    </>
  );
}

function NoticeDialog() {
  const notice = useDataFiles((s) => s.notice);
  return (
    <Dialog
      open={notice !== null}
      onOpenChange={(o) => !o && useDataFiles.setState({ notice: null })}
    >
      <DialogContent className="max-w-[460px]" data-testid="data-files-notice">
        <DialogHeader>
          <DialogTitle>{notice?.title}</DialogTitle>
          <DialogDescription>
            DuckDB opens CSV, TSV, Parquet, JSON and NDJSON files, and .duckdb databases.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-[12px] text-[var(--wb-text)]">
          {notice?.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="primary" onClick={() => useDataFiles.setState({ notice: null })}>
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DropConfirm() {
  const drop = useDataFiles((s) => s.pendingDrop);
  const active = useSession((s) => s.activeConfig);
  const names = drop?.files.map(fileBaseName).join(', ') ?? '';
  return (
    <ConfirmDialog
      open={drop !== null}
      onOpenChange={(o) => !o && useDataFiles.setState({ pendingDrop: null })}
      title="Open these files in DuckDB?"
      description={`${names} will open in a new DuckDB session and disconnect ${active?.name ?? 'the current connection'}.`}
      confirmLabel="Open"
      variant="primary"
      onConfirm={confirmPendingDrop}
    />
  );
}

function AttachDialog() {
  const open = useDataFiles((s) => s.attachOpen);
  const saved = useSession((s) => s.savedConnections);
  const active = useSession((s) => s.activeConfig);
  const [picked, setPicked] = useState<string[]>([]);
  const candidates = saved.filter((c) => (c.engine ?? 'postgres') === 'postgres');

  useEffect(() => {
    if (open) setPicked(active?.duckdb?.attachConnectionIds ?? []);
  }, [open, active]);

  return (
    <Dialog open={open} onOpenChange={(o) => useDataFiles.setState({ attachOpen: o })}>
      <DialogContent className="max-w-[480px]" data-testid="attach-postgres">
        <DialogHeader>
          <DialogTitle>Attach a Postgres connection</DialogTitle>
          <DialogDescription>
            Attached read-only, so you can join your files with live tables. The session reopens
            with the same files; queries run in DuckDB, nothing is written to Postgres.
          </DialogDescription>
        </DialogHeader>
        {candidates.length === 0 ? (
          <p className="py-3 text-[12px] text-[var(--wb-text-2)]">
            No saved Postgres connections yet.
          </p>
        ) : (
          <ul className="max-h-[260px] space-y-1 overflow-y-auto py-2">
            {candidates.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] text-[var(--wb-text)] hover:bg-[var(--wb-control)]">
                  <input
                    type="checkbox"
                    checked={picked.includes(c.id)}
                    onChange={(e) =>
                      setPicked(
                        e.target.checked ? [...picked, c.id] : picked.filter((p) => p !== c.id),
                      )
                    }
                  />
                  <span className="truncate">{c.name}</span>
                  <span className="truncate font-mono text-[11px] text-[var(--wb-text-2)]">
                    {c.host}:{c.port}/{c.database}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => useDataFiles.setState({ attachOpen: false })}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void reopenWithAttachments(picked)}>
            Reopen with {picked.length} attached
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
