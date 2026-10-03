import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import {
  DUCKDB_PG_EXTENSION_MISSING,
  dataFileSessionConfig,
  isDataFileSession,
} from '@shared/data-files';
import type { DataFilePickResult } from '@shared/protocol';
import { create } from 'zustand';

/**
 * Renderer side of "Open data file…": the native picker and the window drop
 * both end in `openDataFiles`, which starts a DuckDB session over what main
 * accepted. Main validated and allowlisted every path before it got here.
 */

interface DataFilesState {
  /** Why some files were refused (or nothing opened); null when closed. */
  notice: { title: string; lines: string[] } | null;
  /** A drop waiting for the user to agree to replace the live connection. */
  pendingDrop: DataFilePickResult | null;
  attachOpen: boolean;
}

export const useDataFiles = create<DataFilesState>(() => ({
  notice: null,
  pendingDrop: null,
  attachOpen: false,
}));

const set = useDataFiles.setState;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Start a session over `result.files`; refused files are listed in a notice. */
export async function openDataFiles(
  result: DataFilePickResult,
  attachConnectionIds: readonly string[] = [],
  installPostgresExtension = false,
): Promise<void> {
  if (result.files.length === 0) {
    set({ notice: { title: 'Could not open the file', lines: result.problems } });
    return;
  }
  const base = dataFileSessionConfig(result.files, attachConnectionIds);
  const config = installPostgresExtension
    ? {
        ...base,
        duckdb: { ...base.duckdb, files: base.duckdb?.files ?? [], installPostgresExtension },
      }
    : base;
  await useSession.getState().connect(config);
  const { connectionState, connectionError } = useSession.getState();
  if (
    connectionState === 'error' &&
    !installPostgresExtension &&
    attachConnectionIds.length > 0 &&
    connectionError?.includes(DUCKDB_PG_EXTENSION_MISSING) &&
    window.confirm(
      "Attaching Postgres needs DuckDB's official Postgres extension. Download it once from extensions.duckdb.org (signed by DuckDB, about 10 MB)?",
    )
  ) {
    await openDataFiles(result, attachConnectionIds, true);
    return;
  }
  if (connectionState === 'error') {
    set({
      notice: {
        title: 'Could not open the data files',
        lines: [connectionError ?? 'Unknown error', ...result.problems],
      },
    });
  } else if (result.problems.length > 0) {
    set({ notice: { title: 'Some files were not opened', lines: result.problems } });
  }
}

/** "Open data file…" (palette, home screen, File menu). */
export async function pickAndOpenDataFiles(target: 'files' | 'database' = 'files'): Promise<void> {
  try {
    const picked = await ipc.conn.pickDataFiles(target);
    if (picked) await openDataFiles(picked);
  } catch (err) {
    set({ notice: { title: 'Could not open the file', lines: [message(err)] } });
  }
}

/** Files dropped on the window (already validated by main). */
export function handleDroppedDataFiles(result: DataFilePickResult): void {
  const s = useSession.getState();
  const live = s.connectionState === 'connected' && s.activeConfig !== null;
  // A drag across the window is easy to do by accident; do not silently drop a live session.
  if (live && result.files.length > 0) {
    set({ pendingDrop: result });
    return;
  }
  void openDataFiles(result);
}

export function confirmPendingDrop(): void {
  const drop = useDataFiles.getState().pendingDrop;
  set({ pendingDrop: null });
  if (drop) void openDataFiles(drop);
}

/** Attach saved Postgres connections (read-only) by reopening the same files with them. */
export async function reopenWithAttachments(ids: readonly string[]): Promise<void> {
  const config = useSession.getState().activeConfig;
  if (!config || !isDataFileSession(config)) return;
  const files = config.duckdb?.files ?? [];
  const db = config.database && config.database !== ':memory:' ? [config.database] : [];
  set({ attachOpen: false });
  await openDataFiles({ files: [...db, ...files], problems: [] }, ids);
}
