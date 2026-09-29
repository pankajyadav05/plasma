/**
 * Open / save `.sql` files for SQL tabs (E3). Uses the File System Access
 * API (native dialogs in Electron, and "Save" writes back to the same
 * file) with an <input type=file> / download fallback when it is not
 * available. File handles live here, keyed by tab id — they can't be
 * serialised, so a relaunched tab remembers only the file name and the
 * next save asks for a location again.
 */

interface FileHandleLike {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

interface FsAccessWindow {
  showOpenFilePicker?: (opts: unknown) => Promise<FileHandleLike[]>;
  showSaveFilePicker?: (opts: unknown) => Promise<FileHandleLike>;
}

const SQL_TYPES = [{ description: 'SQL files', accept: { 'text/plain': ['.sql', '.txt'] } }];

const handles = new Map<string, FileHandleLike>();

function fsWindow(): FsAccessWindow {
  return (typeof window === 'undefined' ? {} : window) as unknown as FsAccessWindow;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export interface OpenedSqlFile {
  name: string;
  text: string;
  handle?: FileHandleLike;
}

/** Ask for a .sql file; null when the user cancels. */
export async function pickSqlFile(): Promise<OpenedSqlFile | null> {
  const w = fsWindow();
  if (w.showOpenFilePicker) {
    try {
      const [handle] = await w.showOpenFilePicker({ types: SQL_TYPES, multiple: false });
      if (!handle) return null;
      const file = await handle.getFile();
      return { name: handle.name, text: await file.text(), handle };
    } catch (err) {
      if (isAbort(err)) return null;
      // Fall through to the input picker (permission denied etc.).
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.sql,.txt,text/plain';
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, text: await file.text() } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Remember the file a tab was opened from so "Save" writes back to it. */
export function rememberFileHandle(tabId: string, handle: FileHandleLike | undefined): void {
  if (handle) handles.set(tabId, handle);
}

export function forgetFileHandle(tabId: string): void {
  handles.delete(tabId);
}

/** Suggested file name for a tab title ("query-2.sql", "orders report.sql"). */
export function fileNameForTitle(title: string): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'query';
  return /\.sql$/i.test(base) ? base : `${base}.sql`;
}

/**
 * Save `text` for `tabId`. Reuses the tab's file unless `saveAs`.
 * Returns the saved file name, or null when cancelled.
 */
export async function saveSqlFile(
  tabId: string,
  text: string,
  suggestedName: string,
  saveAs = false,
): Promise<string | null> {
  const w = fsWindow();
  let handle = saveAs ? undefined : handles.get(tabId);
  if (!handle && w.showSaveFilePicker) {
    try {
      handle = await w.showSaveFilePicker({ suggestedName, types: SQL_TYPES });
    } catch (err) {
      if (isAbort(err)) return null;
      handle = undefined;
    }
  }
  if (handle) {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    handles.set(tabId, handle);
    return handle.name;
  }
  // Fallback: a download (Electron shows its native save dialog).
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return suggestedName;
}
