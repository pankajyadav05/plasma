import { useSession } from '@/stores/session';

/**
 * S1 — one write-safety policy for every Redis view:
 *
 *   canWrite = edit mode is on AND the connection is not read-only.
 *
 * Write affordances are hidden/disabled unless `canWrite`; destructive
 * actions additionally confirm, and on prod-tagged connections (`prod`)
 * every write from the CLI confirms. main + the worker enforce read-only
 * again, so this is the UX layer, not the only guard.
 */
export function useRedisWriteGate(): {
  canWrite: boolean;
  readOnly: boolean;
  editMode: boolean;
  prod: boolean;
  /** Why writing is off, for tooltips. null when canWrite. */
  reason: string | null;
} {
  const readOnly = useSession((s) => Boolean(s.activeConfig?.readOnly));
  const editMode = useSession((s) => s.editMode as boolean);
  const prod = useSession((s) => {
    const id = s.activeConfig?.id;
    return id ? s.settings.connectionTags?.[id] === 'prod' : false;
  });
  const canWrite = editMode && !readOnly;
  return {
    canWrite,
    readOnly,
    editMode,
    prod,
    reason: canWrite
      ? null
      : readOnly
        ? 'This connection is read-only'
        : 'Turn on edit mode (the pencil in the top bar) to change data',
  };
}
