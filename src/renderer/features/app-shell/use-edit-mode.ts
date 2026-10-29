import { useSession } from '@/stores/session';
import { engineCaps } from '@shared/sql-dialect';

/**
 * True while grid writes are actually enabled: edit mode is on, a session is
 * open, and neither the connection nor the engine is read-only. The connection
 * capsule's amber tint and EDITING tag key off this.
 */
export function useEditModeActive(): boolean {
  return useSession(
    (s) =>
      s.editMode &&
      s.connectionState === 'connected' &&
      !s.activeConfig?.readOnly &&
      engineCaps(s.activeConfig?.engine).rowEdits,
  );
}
