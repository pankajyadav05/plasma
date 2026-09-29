/**
 * Local-Monaco shim for `@monaco-editor/react` (C16).
 *
 * `electron.vite.config.ts` aliases the bare `@monaco-editor/react`
 * specifier to this file, so every existing `import('@monaco-editor/react')`
 * gets a loader that uses the bundled `monaco-editor` package instead of
 * injecting a <script> from cdn.jsdelivr.net. The CSP can then drop the
 * CDN and `unsafe-eval`, and the editor works offline.
 *
 * Only the editor core plus the SQL and JSON languages are bundled; the
 * workers are inlined as blob: URLs (allowed by `worker-src blob:`), which
 * avoids file:// worker-origin issues in packaged builds.
 */
import { loader } from '@monaco-editor/react/dist/index.mjs';
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker&inline';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker&inline';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new JsonWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });

export * from '@monaco-editor/react/dist/index.mjs';
export { default } from '@monaco-editor/react/dist/index.mjs';
