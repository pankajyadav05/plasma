import { z } from 'zod';

/**
 * Crash recovery (B2): what Plasma writes down while it runs so that, after a
 * crash, a kill or a power cut, the next launch can bring the session back.
 *
 * The journal is a snapshot of ONE live connection's workspace: the tab strip
 * (open tabs and their unsaved SQL), the staged grid edits with the original
 * values they were staged against, and whether a transaction was open. The
 * renderer writes it (debounced, and on blur / hide / unload); main stores it
 * atomically (temp file, fsync, rename), so a kill mid-write leaves the
 * previous complete snapshot. It never contains results, Safe Run previews, or
 * anything that could be replayed: restoring only re-stages edits and reopens
 * tabs, it never runs a statement.
 *
 * Everything read back is untrusted (a file on disk): `parseJournal` validates
 * the whole envelope and drops what does not fit rather than guessing.
 */

export const RECOVERY_JOURNAL_VERSION = 1;
/** A journal larger than this is refused (a runaway buffer must not fill the disk). */
export const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;

const Text = z.string().max(4 * 1024 * 1024);
const NullableText = Text.nullable();

const ColumnValue = z.object({
  column: z.string().max(1024),
  value: NullableText,
  type: z.string().max(256).optional(),
  noEquality: z.boolean().optional(),
});

/** A staged grid edit, JSON-safe: text values only, keyed to a tab by its position in `tabs`. */
export const RecoveredEdit = z.object({
  tabIndex: z.number().int().nonnegative(),
  kind: z.enum(['update', 'delete', 'insert']),
  schema: z.string().max(1024),
  table: z.string().max(1024),
  pkValues: z.record(NullableText),
  column: z.string().max(1024),
  oldValue: NullableText,
  oldType: z.string().max(256).optional(),
  oldNoEquality: z.boolean().optional(),
  originalRow: z.array(ColumnValue).max(4096).optional(),
  newValue: NullableText,
  values: z.record(NullableText).optional(),
  /** A commit of this edit was in flight when the snapshot was taken: it may already be saved. */
  maybeCommitted: z.boolean().optional(),
});
export type RecoveredEdit = z.infer<typeof RecoveredEdit>;

/** Opaque here: the renderer validates the tab strip with its own `parsePersistedTabs`. */
const TabStrip = z.object({
  v: z.literal(1),
  activeIndex: z.number().int().nonnegative(),
  tabs: z.array(z.record(z.unknown())).max(500),
});

/** Where a snapshot was taken: restoring it against anything else is refused (never secrets). */
export const SnapshotTarget = z.object({
  engine: z.string().max(32),
  host: z.string().max(512),
  port: z.number().int(),
  database: z.string().max(1024),
  user: z.string().max(256),
});
export type SnapshotTarget = z.infer<typeof SnapshotTarget>;

/** What the snapshot could not hold, so the restore can say so. */
export const Omitted = z.object({
  /** Titles of SQL tabs too large to include. */
  tabs: z.array(z.string().max(200)).max(50),
  /** Staged edits too large (or too many) to include. */
  edits: z.number().int().nonnegative(),
});
export type Omitted = z.infer<typeof Omitted>;

export function targetOf(c: {
  engine?: string | null;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  user?: string | null;
}): SnapshotTarget {
  return {
    engine: c.engine ?? 'postgres',
    host: c.host ?? '',
    port: c.port ?? 0,
    database: c.database ?? '',
    user: c.user ?? '',
  };
}

export function sameTarget(a: SnapshotTarget, b: SnapshotTarget): boolean {
  return (
    a.engine === b.engine &&
    a.host === b.host &&
    a.port === b.port &&
    a.database === b.database &&
    a.user === b.user
  );
}

export const RecoveryJournal = z.object({
  v: z.literal(RECOVERY_JOURNAL_VERSION),
  /** Epoch ms of the snapshot. */
  savedAt: z.number().finite(),
  connectionId: z.string().min(1).max(512),
  connectionName: z.string().max(512).optional(),
  /** A transaction was open (it is gone with the session: the server rolled it back). */
  txnActive: z.boolean(),
  /** Absent in snapshots of connections that have no host/database to compare. */
  target: SnapshotTarget.optional(),
  omitted: Omitted.optional(),
  /** Set by main once this snapshot was announced on a launch, so it is offered only once. */
  offered: z.boolean().optional(),
  strip: TabStrip,
  edits: z.array(RecoveredEdit).max(100_000),
});
export type RecoveryJournal = z.infer<typeof RecoveryJournal>;

/**
 * Read a journal from untrusted text or an already-parsed value. Returns null
 * for anything unusable: not JSON, wrong shape, a newer format than this build
 * understands. Older formats are migrated here (none yet; v1 is the first).
 */
export function parseJournal(raw: unknown): RecoveryJournal | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const migrated = migrateJournal(value);
  if (migrated === null) return null;
  const parsed = RecoveryJournal.safeParse(migrated);
  return parsed.success ? parsed.data : null;
}

/** Bring an older journal to the current version; null for an unknown or newer one. */
export function migrateJournal(value: unknown): unknown | null {
  if (!value || typeof value !== 'object') return null;
  const v = (value as { v?: unknown }).v;
  if (v === RECOVERY_JOURNAL_VERSION) return value;
  return null;
}

/** Whether a journal holds anything worth restoring (tabs with text, or staged edits). */
export function journalHasContent(j: RecoveryJournal): boolean {
  if (j.edits.length > 0) return true;
  return j.strip.tabs.some((t) => {
    if (t.kind === 'table') return true;
    const sql = typeof t.sql === 'string' ? t.sql : '';
    return sql.trim().length > 0;
  });
}

// ─── Session marker (unclean-exit detection) ─────────────────────────

/**
 * Written when Plasma starts, removed on a clean quit. Finding one at the next
 * start means the last run never reached its clean exit.
 */
export const SessionMarker = z.object({
  v: z.literal(1),
  pid: z.number().int(),
  startedAt: z.number().finite(),
  version: z.string().max(64),
});
export type SessionMarker = z.infer<typeof SessionMarker>;

export type PreviousExit =
  /** First run, or the last run quit cleanly. */
  | { kind: 'clean' }
  /** The last run left its marker behind: crash, kill, power loss. */
  | { kind: 'unclean'; startedAt: number | null; version: string | null }
  /** The last run was an update restart (not a crash). */
  | { kind: 'update' };

/**
 * What the leftover marker means. `updateRestart` is true when a fresh update
 * restart marker exists (the installer may end the old process before it can
 * remove its own marker). An unreadable marker still counts as unclean: a file
 * that exists but cannot be understood is exactly what a kill mid-write leaves.
 */
export function judgePreviousExit(markerText: string | null, updateRestart: boolean): PreviousExit {
  if (markerText === null) return { kind: 'clean' };
  if (updateRestart) return { kind: 'update' };
  try {
    const parsed = SessionMarker.safeParse(JSON.parse(markerText));
    if (parsed.success) {
      return { kind: 'unclean', startedAt: parsed.data.startedAt, version: parsed.data.version };
    }
  } catch {
    // fall through
  }
  return { kind: 'unclean', startedAt: null, version: null };
}

/**
 * A window that keeps crashing must not reload forever: at most `max` reloads
 * inside `windowMs`. Returns whether this crash may reload, and the history to keep.
 */
export function mayReloadAfterCrash(
  history: readonly number[],
  now: number,
  max = 3,
  windowMs = 60_000,
): { reload: boolean; history: number[] } {
  const recent = history.filter((t) => now - t >= 0 && now - t < windowMs);
  if (recent.length >= max) return { reload: false, history: recent };
  return { reload: true, history: [...recent, now] };
}

// ─── Launch info handed to the renderer ───────────────────────────────

export interface RecoveryLaunchInfo {
  /** Plasma did not close cleanly last time (crash, kill, power loss) or the window crashed. */
  unclean: boolean;
  /** `renderer` = the window process died while the app stayed up. */
  cause: 'exit' | 'renderer' | null;
  /** Snapshots waiting to be restored, newest first (one per connection). */
  journals: RecoveryJournal[];
  /** Connection ids of snapshots not announced before: offer these (once) to restore or discard. */
  announce: string[];
  /** Whether a log file exists to show. */
  hasLog: boolean;
}

// ─── Tolerant ingest (what main stores) ──────────────────────────────

const MAX_TABS = 500;
const MAX_EDITS = 100_000;
const MAX_TAB_CHARS = 4 * 1024 * 1024;

const Envelope = RecoveryJournal.extend({
  strip: z.object({
    v: z.literal(1),
    activeIndex: z.number().int().nonnegative(),
    tabs: z.array(z.unknown()),
  }),
  edits: z.array(z.unknown()),
});

export interface Ingested {
  journal: RecoveryJournal;
  /** One note per thing left out, for the log. */
  dropped: string[];
}

function sizeOf(v: unknown): number {
  try {
    return JSON.stringify(v).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Turn what the renderer sent into a journal main can store. One bad or
 * oversized part must not cost the whole snapshot (a crash would then restore
 * an older one that looks complete): unusable edits and tabs are left out and
 * counted in `omitted`, everything else is kept. Returns null only when the
 * envelope itself is unusable (not a journal at all).
 */
export function ingestJournal(raw: unknown, maxBytes = MAX_JOURNAL_BYTES): Ingested | null {
  if (!raw || typeof raw !== 'object') return null;
  const env = Envelope.safeParse(migrateJournal(raw));
  if (!env.success) return null;
  const dropped: string[] = [];
  const omittedTabs = [...(env.data.omitted?.tabs ?? [])];
  let omittedEdits = env.data.omitted?.edits ?? 0;

  // Edits point at tabs by position: keep the old -> new position of every tab that stays.
  const tabs: Array<Record<string, unknown>> = [];
  const keptIndex = new Map<number, number>();
  env.data.strip.tabs.slice(0, MAX_TABS).forEach((t, i) => {
    if (!t || typeof t !== 'object' || Array.isArray(t) || sizeOf(t) > MAX_TAB_CHARS) {
      const title = (t as { title?: unknown } | null)?.title;
      omittedTabs.push(typeof title === 'string' ? title.slice(0, 200) : 'untitled');
      dropped.push(`tab ${i} too large or unusable`);
      return;
    }
    keptIndex.set(i, tabs.length);
    tabs.push(t as Record<string, unknown>);
  });
  if (env.data.strip.tabs.length > MAX_TABS) {
    dropped.push(`${env.data.strip.tabs.length - MAX_TABS} tabs over the limit`);
  }

  let edits: RecoveredEdit[] = [];
  for (const e of env.data.edits.slice(0, MAX_EDITS)) {
    const parsed = RecoveredEdit.safeParse(e);
    if (!parsed.success) {
      omittedEdits++;
      continue;
    }
    // An edit whose tab was left out still comes back: its table reopens.
    const idx = keptIndex.get(parsed.data.tabIndex);
    edits.push({ ...parsed.data, tabIndex: idx ?? Number.MAX_SAFE_INTEGER });
  }
  if (env.data.edits.length > MAX_EDITS) omittedEdits += env.data.edits.length - MAX_EDITS;

  const build = (): RecoveryJournal => ({
    ...env.data,
    strip: {
      v: 1,
      activeIndex: keptIndex.get(env.data.strip.activeIndex) ?? 0,
      tabs,
    },
    edits,
    ...(omittedTabs.length > 0 || omittedEdits > 0
      ? { omitted: { tabs: omittedTabs.slice(0, 50), edits: omittedEdits } }
      : {}),
  });

  // Still too big: shed the largest edits first, then say how many.
  let total = sizeOf(build());
  if (total > maxBytes) {
    const bySize = edits.map((e, i) => ({ i, n: sizeOf(e) })).sort((a, b) => b.n - a.n);
    const drop = new Set<number>();
    for (const { i, n } of bySize) {
      if (total <= maxBytes) break;
      drop.add(i);
      total -= n;
    }
    omittedEdits += drop.size;
    dropped.push(`${drop.size} edits to fit the size limit`);
    edits = edits.filter((_, i) => !drop.has(i));
  }
  const journal = RecoveryJournal.safeParse(build());
  if (!journal.success) return null;
  if (omittedEdits > 0 || omittedTabs.length > 0) {
    dropped.push(`left out ${omittedEdits} edits and ${omittedTabs.length} tabs in total`);
  }
  return { journal: journal.data, dropped };
}
