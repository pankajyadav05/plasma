import { parseServerMajor } from './pg-backup';
/**
 * Glue between the migration linter, the lock preview and live catalog
 * context: derive `LintOptions` from fetched table context, and bundle one
 * "check" (findings + per-statement locks) for the UI.
 */
import {
  type LockContext,
  type StatementLock,
  analyzeLocks,
  lockTargetNames,
} from './pg-lock-preview';
import {
  type LintFinding,
  type LintOptions,
  type LintSeverity,
  lintMigration,
  worstSeverity,
} from './pg-migration-lint';

/** The slice of Settings the linter reads. */
export interface LintSettingsLike {
  migrationLintEnabled?: boolean;
  migrationLintMinSeverity?: LintSeverity;
  migrationLintMuted?: string[];
}

export function lintOptionsFromSettings(s: LintSettingsLike | undefined): LintOptions {
  return {
    enabled: s?.migrationLintEnabled !== false,
    minSeverity: s?.migrationLintMinSeverity ?? 'info',
    muted: s?.migrationLintMuted ?? [],
  };
}

/** `public.orders` → `orders`, matching `tableKey`. */
function keyOf(display: string): string {
  return display.startsWith('public.') ? display.slice('public.'.length) : display;
}

/** Live context (rows, column types, indexes) → the linter's lookup callbacks. */
export function lintOptionsFromContext(
  locks: readonly StatementLock[],
  ctx: ReadonlyMap<string, LockContext> | undefined,
  base: LintOptions,
): LintOptions {
  if (!ctx || ctx.size === 0) return base;
  const byKey = new Map<string, LockContext>();
  for (const l of locks) {
    for (const t of l.targets) {
      if (t.kind !== 'table') continue;
      const c = ctx.get(t.raw);
      if (c && c.resolved !== null) byKey.set(keyOf(t.display), c);
    }
  }
  return {
    ...base,
    tableRows: (key) => byKey.get(key)?.estRows ?? undefined,
    columnType: (key, col) => byKey.get(key)?.columns.find((c) => c.name === col)?.type,
    hasIndex: (key, cols) => {
      const c = byKey.get(key);
      if (!c) return undefined;
      return c.indexes.some(
        (ix) => ix.length >= cols.length && cols.every((x) => ix.slice(0, cols.length).includes(x)),
      );
    },
  };
}

export interface MigrationCheck {
  findings: LintFinding[];
  suppressed: number;
  locks: StatementLock[];
  /** Relation names to look up live (empty → nothing to fetch). */
  names: string[];
  worst: LintSeverity | null;
}

/** Lint + lock analysis in one pass (live context optional). */
export function checkMigration(
  sql: string,
  base: LintOptions,
  ctx?: ReadonlyMap<string, LockContext>,
  serverVersion?: string | null,
): MigrationCheck {
  const locks = analyzeLocks(sql);
  const major = serverVersion ? parseServerMajor(serverVersion) : null;
  const opts = lintOptionsFromContext(locks, ctx, {
    ...base,
    ...(major ? { pgVersion: major } : {}),
  });
  const { findings, suppressed } = lintMigration(sql, opts);
  return {
    findings,
    suppressed,
    locks,
    names: lockTargetNames(locks),
    worst: worstSeverity(findings),
  };
}
