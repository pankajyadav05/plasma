import { useSession } from '@/stores/session';
import { engineCaps } from '@shared/sql-dialect';

/**
 * True while grid writes are actually enabled: edit mode is on, a session is
 * open, and neither the connection nor the engine is read-only. Every edit-mode
 * cue (toolbar pill, window stripe, pane frame, footer badge) keys off this so
 * they appear and disappear together.
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
