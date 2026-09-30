/**
 * Per-connection safe mode (TablePlus-style), consumed by the prod gate.
 *
 * Levels (Settings → Security sets the default, the connection dialog's
 * Advanced section overrides it per connection):
 *   - `off`               run everything without asking
 *   - `confirm-dangerous` DROP / TRUNCATE / DELETE, UPDATE without WHERE… ask first
 *   - `confirm-writes`    every statement that may write asks first
 *   - `confirm-all`       every statement asks first
 *   - `read-only`         writes are refused (session statements still run)
 *
 * A connection tagged PROD keeps its own confirmation on top: destructive
 * statements always ask there, whatever the level. A connection saved as
 * read-only is enforced by the server / main and is not modelled here.
 */
import type { Settings } from '@shared/protocol';
import {
  leadingKeyword,
  looksDestructiveSql,
  looksLikeWriteSql,
  splitSqlStatements,
} from '@shared/sql-statements';

export type SafeModeLevel = Settings['safeModeDefault'];

export const SAFE_MODE_LEVELS: readonly SafeModeLevel[] = [
  'off',
  'confirm-dangerous',
  'confirm-writes',
  'confirm-all',
  'read-only',
];

/** Human labels + hints, shared by Settings and the connection dialog. */
export const SAFE_MODE_LABEL: Record<SafeModeLevel, { label: string; hint: string }> = {
  off: { label: 'Off', hint: 'Run everything without asking.' },
  'confirm-dangerous': {
    label: 'Confirm dangerous statements',
    hint: 'DROP, TRUNCATE, DELETE and UPDATE without WHERE ask first.',
  },
  'confirm-writes': {
    label: 'Confirm every write',
    hint: 'Any statement that may write asks first.',
  },
  'confirm-all': { label: 'Confirm every statement', hint: 'Every statement asks first.' },
  'read-only': { label: 'Read-only', hint: 'Statements that write are refused.' },
};

/** The level in force for a connection: its own choice, else the default. */
export function effectiveSafeMode(
  settings: Pick<Settings, 'safeModeDefault' | 'connectionSafeMode'> | undefined,
  connectionId: string | null | undefined,
): SafeModeLevel {
  const own = connectionId ? settings?.connectionSafeMode?.[connectionId] : undefined;
  return own ?? settings?.safeModeDefault ?? 'confirm-dangerous';
}

/**
 * Session / transaction-control statements. They change no data, so
 * "confirm writes" doesn't ask and "read-only" doesn't refuse them.
 */
const SESSION_HEADS = new Set([
  'set',
  'reset',
  'begin',
  'start',
  'commit',
  'end',
  'rollback',
  'abort',
  'savepoint',
  'release',
  'listen',
  'unlisten',
  'discard',
  'deallocate',
  'fetch',
  'move',
  'close',
]);

function statementWrites(sql: string): boolean {
  if (SESSION_HEADS.has(leadingKeyword(sql))) return false;
  return looksLikeWriteSql(sql);
}

export type GateDecision =
  | { kind: 'run' }
  | { kind: 'confirm'; reason: 'prod' | 'safe-mode'; level: SafeModeLevel }
  | { kind: 'refuse'; message: string };

export const SAFE_MODE_READ_ONLY_MESSAGE =
  'Safe mode is set to read-only for this connection, so statements that write are refused. ' +
  'Change it in the connection’s Advanced settings.';

/**
 * Decide what the gate does with `sql`.
 *
 * `force` marks SQL the caller already knows writes (mock rows, EXPLAIN
 * ANALYZE of a DML statement, a grid commit) — it always confirms on a
 * prod-tagged connection and counts as a write for the safe-mode levels,
 * but is not "dangerous" by itself.
 */
export function safeModeDecision(input: {
  sql: string;
  level: SafeModeLevel;
  prodTagged: boolean;
  force?: boolean;
}): GateDecision {
  const { level, prodTagged, force } = input;
  const statements = splitSqlStatements(input.sql).filter((s) => s.trim().length > 0);
  const writes = force === true || statements.some(statementWrites);
  const destructive = statements.some((s) => looksDestructiveSql(s));

  if (level === 'read-only' && writes) {
    return { kind: 'refuse', message: SAFE_MODE_READ_ONLY_MESSAGE };
  }
  const bySafeMode =
    (level === 'confirm-all' && (force === true || statements.length > 0)) ||
    (level === 'confirm-writes' && writes) ||
    (level === 'confirm-dangerous' && destructive);
  if (prodTagged && (destructive || force === true))
    return { kind: 'confirm', reason: 'prod', level };
  if (bySafeMode) return { kind: 'confirm', reason: 'safe-mode', level };
  return { kind: 'run' };
}
