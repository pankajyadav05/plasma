import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import {
  DUCKDB_EXCEL_EXTENSION_MISSING,
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

/** DuckDB extensions the user agreed to download for this open. */
interface ExtensionConsent {
  postgres?: boolean;
  excel?: boolean;
}

/**
 * DuckDB's official extensions are not bundled. When opening needs one that
 * is not installed yet, the driver fails with a marker; ask once, then retry
 * with consent. Sizes are the downloaded extension files.
 */
const EXTENSION_PROMPTS: ReadonlyArray<{
  key: keyof ExtensionConsent;
  marker: string;
  question: string;
}> = [
  {
    key: 'excel',
    marker: DUCKDB_EXCEL_EXTENSION_MISSING,
    question:
      "Opening Excel files needs DuckDB's official Excel extension. Download it once from extensions.duckdb.org (signed by DuckDB, about 12 MB)?",
  },
  {
    key: 'postgres',
    marker: DUCKDB_PG_EXTENSION_MISSING,
    question:
      "Attaching Postgres needs DuckDB's official Postgres extension. Download it once from extensions.duckdb.org (signed by DuckDB, about 40 MB)?",
  },
];

/** Start a session over `result.files`; refused files are listed in a notice. */
export async function openDataFiles(
  result: DataFilePickResult,
  attachConnectionIds: readonly string[] = [],
  consent: ExtensionConsent = {},
): Promise<void> {
  if (result.files.length === 0) {
    set({ notice: { title: 'Could not open the file', lines: result.problems } });
    return;
  }
  const base = dataFileSessionConfig(result.files, attachConnectionIds);
  const config = {
    ...base,
    duckdb: {
      ...base.duckdb,
      files: base.duckdb?.files ?? [],
      ...(consent.postgres ? { installPostgresExtension: true } : {}),
      ...(consent.excel ? { installExcelExtension: true } : {}),
    },
  };
  await useSession.getState().connect(config);
  const { connectionState, connectionError } = useSession.getState();
  if (connectionState === 'error' && connectionError) {
    const needed = EXTENSION_PROMPTS.find(
      (p) => !consent[p.key] && connectionError.includes(p.marker),
    );
    if (needed) {
      if (window.confirm(needed.question)) {
        await openDataFiles(result, attachConnectionIds, { ...consent, [needed.key]: true });
        return;
      }
    }
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
