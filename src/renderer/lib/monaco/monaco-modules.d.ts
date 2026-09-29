/**
 * Type shims for the deep imports used by `monaco-react.ts`. The real
 * `@monaco-editor/react` entry is aliased to that shim in the renderer
 * build, so the shim reaches the package through its dist file.
 */
declare module '@monaco-editor/react/dist/index.mjs' {
  export * from '@monaco-editor/react';
  export { default } from '@monaco-editor/react';
}

declare module 'monaco-editor/esm/vs/editor/edcore.main' {
  export * from 'monaco-editor';
}

declare module 'monaco-editor/esm/vs/editor/editor.worker?worker&inline' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
declare module 'monaco-editor/esm/vs/language/json/json.worker?worker&inline' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
