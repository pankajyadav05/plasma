import { useSession } from '@/stores/session';
import { useOsStore } from './os-store';

/**
 * OpenSearch write safety in the renderer (S1 / O1).
 *
 * Writes need edit mode on and a connection that isn't read-only (the
 * same rule as Postgres grid edits); main and the worker refuse writes
 * on read-only connections regardless. On prod-tagged connections every
 * write asks for confirmation; elsewhere only destructive ones do.
 */

export interface OsWriteAccess {
  canWrite: boolean;
  /** Why writes are blocked, for button titles; null when allowed. */
  reason: string | null;
  prod: boolean;
}

export function osWriteAccess(input: {
  connected: boolean;
  readOnly: boolean;
  editMode: boolean;
  tag: string | undefined;
}): OsWriteAccess {
  const prod = input.tag === 'prod';
  if (!input.connected) return { canWrite: false, reason: 'Not connected', prod };
  if (input.readOnly) {
    return { canWrite: false, reason: 'Read-only connection — writes are disabled', prod };
  }
  if (!input.editMode) {
    return {
      canWrite: false,
      reason: 'Safe mode — turn on edit mode (lock button in the toolbar) to write',
      prod,
    };
  }
  return { canWrite: true, reason: null, prod };
}

export function useOsWriteAccess(): OsWriteAccess {
  const connected = useSession((s) => s.activeConfig !== null);
  const readOnly = useSession((s) => s.activeConfig?.readOnly === true);
  const editMode = useSession((s) => s.editMode);
  const tag = useSession((s) =>
    s.activeConfig ? s.settings.connectionTags?.[s.activeConfig.id] : undefined,
  );
  return osWriteAccess({ connected, readOnly, editMode, tag });
}

function currentAccess(): OsWriteAccess {
  const s = useSession.getState();
  return osWriteAccess({
    connected: s.activeConfig !== null,
    readOnly: s.activeConfig?.readOnly === true,
    editMode: s.editMode,
    tag: s.activeConfig ? s.settings.connectionTags?.[s.activeConfig.id] : undefined,
  });
}

/**
 * Gate one write: resolves false when writes are blocked or the user
 * cancels. Asks for confirmation when `destructive` or on prod.
 */
export async function confirmOsWrite(opts: {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  typeToConfirm?: string;
}): Promise<boolean> {
  const access = currentAccess();
  if (!access.canWrite) return false;
  const destructive = opts.destructive === true;
  if (!destructive && !access.prod) return true;
  return new Promise<boolean>((resolve) => {
    useOsStore.getState().setConfirm({
      title: opts.title,
      description: opts.description,
      confirmLabel: opts.confirmLabel,
      destructive,
      typeToConfirm: opts.typeToConfirm,
      prod: access.prod,
      resolve,
    });
  });
}
