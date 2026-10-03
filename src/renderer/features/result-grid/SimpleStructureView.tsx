import { Input } from '@/components/ui/input';
import { Pill } from '@/components/ui/workbench';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useActiveTab, useSession } from '@/stores/session';
import { dialectFor, engineCaps } from '@shared/sql-dialect';
import { Fragment, useMemo, useState } from 'react';
import { type ColumnProfile, parseSummarize, summarizeSql } from './column-profile';

/** Column types are typed by the user; keep them to what a type name can contain. */
const TYPE_RE = /^[A-Za-z][A-Za-z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?( unsigned)?$/i;

export interface AddColumnInput {
  name: string;
  type: string;
  notNull: boolean;
  defaultExpr: string;
}

/** `ALTER TABLE … ADD COLUMN …` for SQLite / MySQL (pure, unit-tested). */
export function buildAddColumnSql(
  engine: string | undefined,
  schema: string,
  table: string,
  col: AddColumnInput,
): string {
  const d = dialectFor(engine);
  const name = col.name.trim();
  const type = col.type.trim();
  if (!name) throw new Error('Column name is required');
  if (!TYPE_RE.test(type)) throw new Error(`"${type}" is not a valid column type`);
  const parts = [
    `ALTER TABLE ${d.qualify(schema, table)} ADD COLUMN ${d.quoteIdent(name)} ${type}`,
  ];
  if (col.notNull) parts.push('NOT NULL');
  if (col.defaultExpr.trim()) parts.push(`DEFAULT ${col.defaultExpr.trim()}`);
  else if (col.notNull) {
    throw new Error('A NOT NULL column needs a default so existing rows stay valid');
  }
  return `${parts.join(' ')};`;
}

export function buildRenameColumnSql(
  engine: string | undefined,
  schema: string,
  table: string,
  from: string,
  to: string,
): string {
  const d = dialectFor(engine);
  if (!to.trim()) throw new Error('New name is required');
  return `ALTER TABLE ${d.qualify(schema, table)} RENAME COLUMN ${d.quoteIdent(from)} TO ${d.quoteIdent(to.trim())};`;
}

export function buildRenameTableSql(
  engine: string | undefined,
  schema: string,
  table: string,
  to: string,
): string {
  const d = dialectFor(engine);
  if (!to.trim()) throw new Error('New name is required');
  return `ALTER TABLE ${d.qualify(schema, table)} RENAME TO ${d.quoteIdent(to.trim())};`;
}

/**
 * Read-only structure view for SQLite / MySQL / ClickHouse / DuckDB tables
 * (columns, keys, foreign keys, indexes, triggers, engine facts such as the
 * ClickHouse sorting key or the file behind a DuckDB view). Where rows can be
 * edited it also offers the two safe ALTERs: add a column and rename; every
 * change shows its SQL first and goes through the same prod / safe-mode gate
 * as a query typed in the editor. DuckDB adds a column profile.
 */
export function SimpleStructureView() {
  const tab = useActiveTab();
  const schemaInfo = useSession((s) => s.schema);
  const engine = useSession((s) => s.activeConfig?.engine);
  const readOnly = useSession(
    (s) => Boolean(s.activeConfig?.readOnly) || !engineCaps(s.activeConfig?.engine).rowEdits,
  );
  const canProfile = useSession((s) => engineCaps(s.activeConfig?.engine).columnProfile);
  const refreshSchema = useSession((s) => s.refreshSchema);
  const confirm = useSession((s) => s.confirmUserSqlDetailed);
  const schema = tab?.kind === 'table' ? (tab.tableSchema ?? '') : '';
  const table = tab?.kind === 'table' ? (tab.tableName ?? '') : '';

  const meta = schemaInfo?.tables.find((t) => t.schema === schema && t.name === table);
  const isTable = meta?.kind === 'table';
  const columns = useMemo(
    () =>
      (schemaInfo?.columns ?? [])
        .filter((c) => c.schema === schema && c.table === table)
        .sort((a, b) => a.ordinal - b.ordinal),
    [schemaInfo, schema, table],
  );
  const fks = (schemaInfo?.foreignKeys ?? []).filter(
    (f) => f.schema === schema && f.table === table,
  );
  const indexes = (schemaInfo?.indexes ?? []).filter(
    (i) => i.schema === schema && i.table === table,
  );
  const triggers = (schemaInfo?.triggers ?? []).filter(
    (t) => t.schema === schema && t.table === table,
  );

  const [draft, setDraft] = useState<AddColumnInput>({
    name: '',
    type: 'TEXT',
    notNull: false,
    defaultExpr: '',
  });
  const [renaming, setRenaming] = useState<{ from: string | null; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<{
    rows: ColumnProfile[];
    ms: number;
  } | null>(null);
  const [profiling, setProfiling] = useState(false);

  const preview = useMemo(() => {
    try {
      if (renaming) {
        return renaming.from
          ? buildRenameColumnSql(engine, schema, table, renaming.from, renaming.to)
          : buildRenameTableSql(engine, schema, table, renaming.to);
      }
      if (draft.name.trim()) return buildAddColumnSql(engine, schema, table, draft);
    } catch {
      return null;
    }
    return null;
  }, [engine, schema, table, draft, renaming]);

  const runProfile = async () => {
    setError(null);
    setProfiling(true);
    try {
      const started = Date.now();
      const res = await ipc.query.run(summarizeSql(schema, table), undefined, { internal: true });
      setProfile({ rows: parseSummarize(res), ms: Date.now() - started });
    } catch (err) {
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    } finally {
      setProfiling(false);
    }
  };

  const apply = async (build: () => string) => {
    setError(null);
    try {
      const sql = build();
      const outcome = await confirm(sql, { force: true, summary: sql });
      if (!outcome.ok) {
        if (outcome.reason === 'refused') setError(outcome.message);
        return;
      }
      setBusy(true);
      await ipc.query.run(sql, undefined, { internal: false });
      setDraft({ name: '', type: 'TEXT', notNull: false, defaultExpr: '' });
      setRenaming(null);
      await refreshSchema();
    } catch (err) {
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  if (!tab || tab.kind !== 'table') return null;
  const editable = !readOnly && isTable;
  const head = 'px-3 py-1.5 text-left text-[11px] font-semibold text-[var(--wb-text-2)]';
  const cell = 'px-3 py-1 text-[12px] text-[var(--wb-text)]';

  return (
    <div
      className="min-h-0 flex-1 overflow-auto bg-[var(--wb-content)] p-4"
      data-testid="simple-structure"
    >
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-mono text-[13px] font-semibold text-[var(--wb-text)]">{table}</h2>
        {editable && (
          <Pill onClick={() => setRenaming({ from: null, to: table })}>Rename table</Pill>
        )}
      </div>

      {meta?.details && meta.details.length > 0 && (
        <dl
          className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-[8px] bg-[var(--wb-sidebar)] p-3 text-[12px]"
          data-testid="structure-details"
        >
          {meta.details.map((d) => (
            <Fragment key={d.label}>
              <dt className="font-semibold text-[var(--wb-text-2)]">{d.label}</dt>
              <dd className="min-w-0 break-words font-mono text-[var(--wb-text)]">{d.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}

      <table className="mb-4 w-full border-collapse">
        <thead>
          <tr className="border-b border-[var(--wb-separator)]">
            <th className={head}>Column</th>
            <th className={head}>Type</th>
            <th className={head}>Null</th>
            <th className={head}>Default</th>
            <th className={head}>Key</th>
            <th className={head} />
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c.name} className="border-b border-[var(--wb-separator)]/50">
              <td className={`${cell} font-mono`}>{c.name}</td>
              <td className={`${cell} font-mono text-[var(--wb-text-2)]`}>{c.dataType}</td>
              <td className={cell}>{c.isNullable ? 'yes' : 'no'}</td>
              <td className={`${cell} font-mono text-[var(--wb-text-2)]`}>{c.defaultExpr ?? ''}</td>
              <td className={cell}>{c.isPrimaryKey ? 'PK' : ''}</td>
              <td className={cell}>
                {editable && (
                  <button
                    type="button"
                    className="text-[11px] text-[var(--wb-text-2)] underline"
                    onClick={() => setRenaming({ from: c.name, to: c.name })}
                  >
                    rename
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canProfile && (
        <div className="mb-4" data-testid="column-profile">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[11px] font-semibold text-[var(--wb-text-2)]">
              Column profile
            </span>
            <Pill disabled={profiling} onClick={() => void runProfile()}>
              {profiling ? 'Profiling…' : profile ? 'Refresh' : 'Profile columns'}
            </Pill>
            {profile && (
              <span className="text-[11px] text-[var(--wb-text-3)]">
                {profile.ms} ms · distinct counts are estimates
              </span>
            )}
          </div>
          {profile && (
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--wb-separator)]">
                  <th className={head}>Column</th>
                  <th className={head}>Type</th>
                  <th className={`${head} text-right`}>Null %</th>
                  <th className={`${head} text-right`}>Distinct ≈</th>
                  <th className={head}>Min</th>
                  <th className={head}>Max</th>
                </tr>
              </thead>
              <tbody>
                {profile.rows.map((p) => (
                  <tr key={p.column} className="border-b border-[var(--wb-separator)]/50">
                    <td className={`${cell} font-mono`}>{p.column}</td>
                    <td className={`${cell} font-mono text-[var(--wb-text-2)]`}>{p.type}</td>
                    <td className={`${cell} text-right tabular-nums`}>
                      {p.nullPercent === null ? '' : `${p.nullPercent}%`}
                    </td>
                    <td className={`${cell} text-right tabular-nums`}>
                      {p.distinct === null ? '' : p.distinct.toLocaleString()}
                    </td>
                    <td className={`${cell} max-w-[200px] truncate font-mono`} title={p.min ?? ''}>
                      {p.min ?? ''}
                    </td>
                    <td className={`${cell} max-w-[200px] truncate font-mono`} title={p.max ?? ''}>
                      {p.max ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {fks.length > 0 && (
        <Section title="Foreign keys">
          {fks.map((f) => (
            <li key={`${f.constraint}-${f.column}`} className="font-mono">
              {f.column} → {f.refTable}({f.refColumn}){' '}
              <span className="text-[var(--wb-text-3)]">on delete {f.onDelete?.toLowerCase()}</span>
            </li>
          ))}
        </Section>
      )}
      {indexes.length > 0 && (
        <Section title="Indexes">
          {indexes.map((i) => (
            <li key={i.name} className="font-mono">
              {i.name}
              {i.unique ? ' (unique)' : ''}
              {i.primary ? ' (primary)' : ''}
            </li>
          ))}
        </Section>
      )}
      {triggers.length > 0 && (
        <Section title="Triggers">
          {triggers.map((t) => (
            <li key={t.name} className="font-mono">
              {t.name}
            </li>
          ))}
        </Section>
      )}

      {editable && (
        <div className="mt-4 rounded-[8px] bg-[var(--wb-sidebar)] p-3">
          {renaming ? (
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-[var(--wb-text-2)]">
                Rename {renaming.from ? `column ${renaming.from}` : 'table'} to
              </span>
              <Input
                value={renaming.to}
                onChange={(e) => setRenaming({ ...renaming, to: e.target.value })}
                className="h-7 w-52 font-mono text-[12px]"
                aria-label="New name"
              />
              <Pill onClick={() => setRenaming(null)}>Cancel</Pill>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-semibold text-[var(--wb-text)]">Add column</span>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="name"
                aria-label="Column name"
                className="h-7 w-36 font-mono text-[12px]"
              />
              <Input
                value={draft.type}
                onChange={(e) => setDraft({ ...draft, type: e.target.value })}
                placeholder="type"
                aria-label="Column type"
                className="h-7 w-32 font-mono text-[12px]"
              />
              <Input
                value={draft.defaultExpr}
                onChange={(e) => setDraft({ ...draft, defaultExpr: e.target.value })}
                placeholder="default (SQL)"
                aria-label="Default"
                className="h-7 w-36 font-mono text-[12px]"
              />
              <label className="flex items-center gap-1 text-[12px] text-[var(--wb-text)]">
                <input
                  type="checkbox"
                  checked={draft.notNull}
                  onChange={(e) => setDraft({ ...draft, notNull: e.target.checked })}
                />
                NOT NULL
              </label>
            </div>
          )}
          {preview && (
            <pre className="mt-2 overflow-x-auto rounded bg-[var(--wb-content)] p-2 font-mono text-[12px] text-[var(--wb-text)]">
              {preview}
            </pre>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Pill
              disabled={busy || !preview}
              onClick={() =>
                void apply(() => {
                  if (renaming) {
                    return renaming.from
                      ? buildRenameColumnSql(engine, schema, table, renaming.from, renaming.to)
                      : buildRenameTableSql(engine, schema, table, renaming.to);
                  }
                  return buildAddColumnSql(engine, schema, table, draft);
                })
              }
            >
              Apply
            </Pill>
            {error && (
              <span className="text-[12px] text-destructive" role="alert">
                {error}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-[11px] font-semibold text-[var(--wb-text-2)]">{title}</div>
      <ul className="list-none space-y-0.5 text-[12px] text-[var(--wb-text)]">{children}</ul>
    </div>
  );
}
