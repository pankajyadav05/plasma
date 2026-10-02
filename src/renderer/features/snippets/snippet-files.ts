/** Open / save a snippets `.json` file (File System Access API, with input/download fallbacks). */

interface Handle {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
interface FsWindow {
  showOpenFilePicker?: (opts: unknown) => Promise<Handle[]>;
  showSaveFilePicker?: (opts: unknown) => Promise<Handle>;
}

const TYPES = [{ description: 'Snippets (JSON)', accept: { 'application/json': ['.json'] } }];

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

export async function pickSnippetFile(): Promise<string | null> {
  const w = window as unknown as FsWindow;
  if (w.showOpenFilePicker) {
    try {
      const [handle] = await w.showOpenFilePicker({ types: TYPES, multiple: false });
      return handle ? await (await handle.getFile()).text() : null;
    } catch (err) {
      if (isAbort(err)) return null;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? await file.text() : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Returns false when the user cancels. */
export async function saveSnippetFile(text: string, suggestedName: string): Promise<boolean> {
  const w = window as unknown as FsWindow;
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName, types: TYPES });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return true;
    } catch (err) {
      if (isAbort(err)) return false;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
