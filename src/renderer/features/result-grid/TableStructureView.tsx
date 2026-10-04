import { Checkbox } from '@/components/ui/checkbox';
import { IconButton, Pill } from '@/components/ui/workbench';
import { MigrationCheckPanel } from '@/features/migration/MigrationCheckPanel';
import { AddConstraintDialog, AddIndexDialog } from '@/features/structure/StructureAddDialogs';
import { applyStructurePlan } from '@/features/structure/apply-structure';
import {
  type ColumnState,
  EMPTY_MODEL,
  type EditModel,
  changeCount,
  diffToChanges,
  effectiveColumns,
  setColumnEdit,
  usingHint,
  withSchema,
} from '@/features/structure/structure-edits';
import {
  CellInput,
  CheckRow,
  PgTypeDatalist,
  SqlPreview,
  TypeInput,
} from '@/features/structure/structure-parts';
import { cn } from '@/lib/cn';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { buildDefinitionQuerySql } from '@/lib/table-query';
import {
  type DefinitionRow,
  type StructureConstraint,
  type TableStructure,
  buildTableStructure,
  splitIdentList,
} from '@/lib/table-structure';
import { useActiveTab, useSession } from '@/stores/session';
import { buildAlterPlan, formatPlan, qualifiedName } from '@shared/pg-ddl';
import { ArrowUpRight, KeyRound, Loader2, Plus, RefreshCw, Search, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Structure view for a table tab — the TablePlus "Structure" + "Index"
 * panes stacked on one scrollable page:
 *
 *   Columns      #, name, type, nullable, default, key / reference
 *   Constraints  name, type, definition
 *   Indexes      name, method, unique, columns, condition
 *
 * Built from the same catalog query as the DDL view, so the two never
 * disagree. Foreign-key targets are clickable and open the referenced
 * table.
 *
 * Editable on writable connections (TablePlus style): column edits, added
 * / dropped columns, indexes and constraints are staged like pending grid
 * edits, shown as SQL in the Preview panel and applied together — one
 * transaction, CONCURRENTLY index statements on their own — through the
 * prod gate. Read-only connections and views get the static view.
 */
export function TableStructureView() {
  const tab = useActiveTab();
  const schemaName = tab?.kind === 'table' ? tab.tableSchema : undefined;
  const tableName = tab?.kind === 'table' ? tab.tableName : undefined;
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const readOnly = useSession((s) => Boolean(s.activeConfig?.readOnly));
  const relKind = useSession(
    (s) => s.schema?.tables.find((t) => t.schema === schemaName && t.name === tableName)?.kind,
  );
  const editable =
    !readOnly && (relKind === undefined || relKind === 'table' || relKind === 'partitioned');
  const [comments, setComments] = useState<Record<string, string>>({});
  const [model, setModel] = useState<EditModel>(EMPTY_MODEL);
  const [addIndexOpen, setAddIndexOpen] = useState(false);
  const [addConstraintOpen, setAddConstraintOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [lintBlocked, setLintBlocked] = useState(false);

  // `reloadKey` is a deliberate re-fetch trigger for the Reload button.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey forces a re-query
  useEffect(() => {
    if (!schemaName || !tableName) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const { sql, params } = buildDefinitionQuerySql(schemaName, tableName);
        const res = await ipc.query.run(sql, params, { internal: true });
        if (cancelled) return;
        const rows: DefinitionRow[] = res.rows.map((r) => ({
          kind: String(r[0]) as DefinitionRow['kind'],
          c1: String(r[2] ?? ''),
          c2: String(r[3] ?? ''),
          c3: String(r[4] ?? ''),
          c4: String(r[5] ?? ''),
        }));
        setStructure(buildTableStructure(rows));
        try {
          const cm = await ipc.query.run(
            'SELECT a.attname, col_description(a.attrelid, a.attnum) FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped',
            [qualifiedName(schemaName, tableName)],
            { internal: true },
          );
          if (!cancelled) {
            setComments(
              Object.fromEntries(
                cm.rows.filter((r) => r[1] != null).map((r) => [String(r[0]), String(r[1])]),
              ),
            );
          }
        } catch {
          // comments are optional; editing still works without them
        }
      } catch (err) {
        if (!cancelled) setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [schemaName, tableName, reloadKey]);

  // Reset staged edits when the table changes or was reloaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keys
  useEffect(() => {
    setModel(EMPTY_MODEL);
    setApplyError(null);
  }, [schemaName, tableName, reloadKey]);

  const original = useMemo<ColumnState[]>(
    () =>
      (structure?.columns ?? []).map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        default: c.defaultExpr,
        comment: comments[c.name] ?? '',
        primaryKey: c.primaryKey,
      })),
    [structure, comments],
  );
  const effective = useMemo(() => effectiveColumns(original, model), [original, model]);
  const staged = changeCount(model);
  const built = useMemo(() => {
    if (!schemaName || !tableName || staged === 0)
      return { plan: null, sql: '', problem: null as string | null };
    try {
      const plan = buildAlterPlan(
        schemaName,
        tableName,
        withSchema(diffToChanges(original, model), schemaName),
      );
      return { plan, sql: formatPlan(plan), problem: null as string | null };
    } catch (err) {
      return { plan: null, sql: '', problem: err instanceof Error ? err.message : String(err) };
    }
  }, [schemaName, tableName, staged, original, model]);

  const apply = async () => {
    if (!built.plan || !schemaName || !tableName || lintBlocked) return;
    setApplying(true);
    setApplyError(null);
    const out = await applyStructurePlan(built.plan, `alter table ${schemaName}.${tableName}`);
    setApplying(false);
    if (out.ok) {
      setModel(EMPTY_MODEL);
      setReloadKey((k) => k + 1);
    } else if (!out.cancelled) {
      setApplyError(out.statement ? `${out.message}\n\nStatement: ${out.statement}` : out.message);
    }
  };

  const constraintNames = useMemo(
    () => new Set((structure?.constraints ?? []).map((c) => c.name)),
    [structure],
  );

  if (!schemaName || !tableName) return null;

  const setEdit = <K extends keyof import('@/features/structure/structure-edits').ColumnEdit>(
    col: ColumnState,
    key: K,
    value: import('@/features/structure/structure-edits').ColumnEdit[K],
  ) => setModel((m) => setColumnEdit(m, col, key, value));
  const q = filter.trim().toLowerCase();
  const matches = (name: string, type: string) =>
    !q || name.toLowerCase().includes(q) || type.toLowerCase().includes(q);
  const pkColumns = (structure?.columns ?? []).filter((c) => c.primaryKey);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-[var(--wb-content)]"
      data-testid="table-structure"
    >
      <PgTypeDatalist />
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] px-2">
        <div className="relative w-48 shrink-0">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--wb-text-2)]" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search columns…"
            aria-label="Search columns"
            className="h-[26px] w-full rounded-[7px] border-0 bg-[var(--wb-field)] pl-8 pr-2 text-[13px] text-[var(--wb-text)] outline-none transition-colors placeholder:text-[var(--wb-text-3)] focus:ring-2 focus:ring-[var(--wb-accent)]"
          />
        </div>
        {structure && (
          <span className="min-w-0 truncate whitespace-nowrap font-mono text-[12px] text-[var(--wb-text-2)]">
            {plural(structure.columns.length, 'column')} ·{' '}
            {plural(structure.constraints.length, 'constraint')} ·{' '}
            {plural(structure.indexes.length, 'index', 'indexes')}
          </span>
        )}
        <div className="flex-1" />
        {editable && structure && (
          <>
            <Pill
              onClick={() =>
                setModel((m) => ({
                  ...m,
                  addedColumns: [...m.addedColumns, { name: '', type: 'text', nullable: true }],
                }))
              }
              data-testid="structure-add-column"
            >
              <Plus />
              Column
            </Pill>
            <Pill onClick={() => setAddIndexOpen(true)} data-testid="structure-add-index">
              <Plus />
              Index
            </Pill>
            <Pill onClick={() => setAddConstraintOpen(true)} data-testid="structure-add-constraint">
              <Plus />
              Constraint
            </Pill>
          </>
        )}
        {readOnly && (
          <span className="text-[12px] text-[var(--wb-text-2)]" title="Read-only connection">
            read-only
          </span>
        )}
        <IconButton
          label="Reload structure"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
        >
          <RefreshCw className={loading ? 'animate-spin' : ''} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !structure ? (
          <div className="flex h-full items-center justify-center gap-2 text-[var(--wb-text-2)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-[13px]">reading the catalog…</span>
          </div>
        ) : error ? (
          <div className="max-w-3xl p-8">
            <div className="text-[15px] font-semibold text-[var(--wb-text)]">
              Couldn't read this table's structure
            </div>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-destructive">
              {error}
            </pre>
          </div>
        ) : structure ? (
          <>
            <Section title="Columns">
              <table className="w-full border-collapse font-mono text-[13px] text-[var(--grid-text)]">
                <thead>
                  <HeadRow
                    cols={
                      editable
                        ? [
                            '#',
                            'column_name',
                            'data_type',
                            'nullable',
                            'default',
                            'comment',
                            'key',
                            '',
                          ]
                        : ['#', 'column_name', 'data_type', 'nullable', 'default', 'key']
                    }
                  />
                </thead>
                <tbody>
                  {original.map((col, idx) => {
                    const c = structure.columns[idx];
                    if (!c || !matches(col.name, col.type)) return null;
                    const dropped = model.droppedColumns.includes(col.name);
                    const e = model.columnEdits[col.name] ?? {};
                    const nameNow = e.name ?? col.name;
                    const typeNow = e.type ?? col.type;
                    const nullableNow = e.nullable ?? col.nullable;
                    const defaultNow = e.default ?? col.default;
                    const commentNow = e.comment ?? col.comment;
                    const changed = Object.keys(e).length > 0;
                    return (
                      <tr
                        key={c.name}
                        data-testid="structure-column-row"
                        className={cn(
                          'even:bg-[var(--grid-row-b)] odd:bg-[var(--grid-row-a)]',
                          dropped && 'opacity-50',
                          changed && 'shadow-[inset_2px_0_0_var(--wb-accent)]',
                        )}
                      >
                        <Td className="w-10 text-right text-[var(--wb-text-2)]">{c.ordinal}</Td>
                        {editable && !dropped ? (
                          <>
                            <Td className="min-w-[140px] font-medium text-[var(--wb-text)]">
                              <span className="flex items-center gap-1.5">
                                {c.primaryKey && (
                                  <KeyRound
                                    className="h-3 w-3 shrink-0 text-[var(--icon-star)]"
                                    aria-label="primary key"
                                  />
                                )}
                                <CellInput
                                  value={nameNow}
                                  aria-label={`Name of column ${col.name}`}
                                  onChange={(ev) => setEdit(col, 'name', ev.target.value)}
                                />
                              </span>
                            </Td>
                            <Td className="min-w-[150px]">
                              <TypeInput
                                value={typeNow}
                                aria-label={`Type of column ${col.name}`}
                                onChange={(ev) => {
                                  const v = ev.target.value;
                                  setModel((m) => {
                                    let next = setColumnEdit(m, col, 'type', v);
                                    next = setColumnEdit(
                                      next,
                                      col,
                                      'using',
                                      v === col.type
                                        ? undefined
                                        : usingHint(col.name, col.type, v) || undefined,
                                    );
                                    return next;
                                  });
                                }}
                              />
                              {e.type !== undefined && (
                                <CellInput
                                  className="mt-1"
                                  value={e.using ?? ''}
                                  placeholder="USING expression"
                                  aria-label={`USING for column ${col.name}`}
                                  title="Optional USING clause for the conversion, e.g. col::integer"
                                  onChange={(ev) => setEdit(col, 'using', ev.target.value)}
                                />
                              )}
                            </Td>
                            <Td className="text-center">
                              <Checkbox
                                aria-label={`${col.name} nullable`}
                                checked={nullableNow}
                                onCheckedChange={(v) => setEdit(col, 'nullable', v === true)}
                              />
                            </Td>
                            <Td className="min-w-[130px]">
                              <CellInput
                                value={defaultNow}
                                placeholder="NULL"
                                aria-label={`Default of column ${col.name}`}
                                onChange={(ev) => setEdit(col, 'default', ev.target.value)}
                              />
                            </Td>
                            <Td className="min-w-[120px]">
                              <CellInput
                                value={commentNow}
                                aria-label={`Comment of column ${col.name}`}
                                onChange={(ev) => setEdit(col, 'comment', ev.target.value)}
                              />
                            </Td>
                          </>
                        ) : (
                          <>
                            <Td className="font-medium text-[var(--wb-text)]">
                              <span
                                className={cn(
                                  'flex items-center gap-1.5',
                                  dropped && 'line-through',
                                )}
                              >
                                {c.primaryKey && (
                                  <KeyRound
                                    className="h-3 w-3 text-[var(--icon-star)]"
                                    aria-label="primary key"
                                  />
                                )}
                                {c.name}
                              </span>
                            </Td>
                            <Td className="whitespace-nowrap text-[var(--wb-text-2)]">{c.type}</Td>
                            <Td
                              className={
                                c.nullable ? 'text-[var(--wb-text)]' : 'text-[var(--wb-text-2)]'
                              }
                            >
                              {c.nullable ? 'YES' : 'NO'}
                            </Td>
                            <Td
                              className="max-w-[280px] truncate text-[var(--wb-text-2)]"
                              title={c.defaultExpr}
                            >
                              {c.defaultExpr || (
                                <span className="text-[var(--grid-null)]">NULL</span>
                              )}
                            </Td>
                            {editable && (
                              <Td className="max-w-[200px] truncate text-[var(--wb-text-2)]">
                                {col.comment}
                              </Td>
                            )}
                          </>
                        )}
                        <Td className="whitespace-nowrap">
                          <span className="flex items-center gap-1">
                            {c.primaryKey && <Tag>PK</Tag>}
                            {c.unique && <Tag>UNIQUE</Tag>}
                            {c.references && <FkLink target={c.references} />}
                          </span>
                        </Td>
                        {editable && (
                          <Td className="w-8 text-center">
                            {dropped ? (
                              <IconButton
                                label={`Keep column ${col.name}`}
                                onClick={() =>
                                  setModel((m) => ({
                                    ...m,
                                    droppedColumns: m.droppedColumns.filter((n) => n !== col.name),
                                  }))
                                }
                              >
                                <Undo2 />
                              </IconButton>
                            ) : (
                              <IconButton
                                label={`Drop column ${col.name}`}
                                onClick={() =>
                                  setModel((m) => ({
                                    ...m,
                                    droppedColumns: [...m.droppedColumns, col.name],
                                  }))
                                }
                              >
                                <X />
                              </IconButton>
                            )}
                          </Td>
                        )}
                      </tr>
                    );
                  })}
                  {editable &&
                    model.addedColumns.map((a, i) => (
                      <tr
                        // biome-ignore lint/suspicious/noArrayIndexKey: staged rows have no id; removal re-keys
                        key={`new-${i}`}
                        data-testid="structure-new-column-row"
                        className="bg-[var(--grid-row-a)] shadow-[inset_2px_0_0_var(--wb-accent)]"
                      >
                        <Td className="w-10 text-right text-[var(--wb-text-2)]">new</Td>
                        <Td>
                          <CellInput
                            value={a.name}
                            placeholder="column_name"
                            aria-label={`New column ${i + 1} name`}
                            onChange={(ev) => patchAdded(i, { name: ev.target.value })}
                          />
                        </Td>
                        <Td>
                          <TypeInput
                            value={a.type}
                            aria-label={`New column ${i + 1} type`}
                            onChange={(ev) => patchAdded(i, { type: ev.target.value })}
                          />
                        </Td>
                        <Td className="text-center">
                          <Checkbox
                            aria-label={`New column ${i + 1} nullable`}
                            checked={a.nullable && !a.primaryKey}
                            disabled={a.primaryKey === true}
                            onCheckedChange={(v) => patchAdded(i, { nullable: v === true })}
                          />
                        </Td>
                        <Td>
                          <CellInput
                            value={a.default ?? ''}
                            placeholder="NULL"
                            aria-label={`New column ${i + 1} default`}
                            onChange={(ev) => patchAdded(i, { default: ev.target.value })}
                          />
                        </Td>
                        <Td>
                          <CellInput
                            value={a.comment ?? ''}
                            aria-label={`New column ${i + 1} comment`}
                            onChange={(ev) => patchAdded(i, { comment: ev.target.value })}
                          />
                        </Td>
                        <Td>
                          <CheckRow
                            className="font-sans text-[12px]"
                            checked={a.primaryKey === true}
                            disabled={pkColumns.length > 0}
                            onChange={(v) => patchAdded(i, { primaryKey: v })}
                          >
                            PK
                          </CheckRow>
                        </Td>
                        <Td className="w-8 text-center">
                          <IconButton
                            label={`Remove new column ${i + 1}`}
                            onClick={() =>
                              setModel((m) => ({
                                ...m,
                                addedColumns: m.addedColumns.filter((_, j) => j !== i),
                              }))
                            }
                          >
                            <X />
                          </IconButton>
                        </Td>
                      </tr>
                    ))}
                  {original.length > 0 && !original.some((c) => matches(c.name, c.type)) && (
                    <tr>
                      <Td className="text-[var(--wb-text-2)]" colSpan={editable ? 8 : 6}>
                        no column matches "{filter}"
                      </Td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Section>

            <Section
              title="Constraints"
              empty={structure.constraints.length === 0 && model.addedConstraints.length === 0}
            >
              <table className="w-full border-collapse font-mono text-[13px] text-[var(--grid-text)]">
                <thead>
                  <HeadRow
                    cols={
                      editable
                        ? ['constraint_name', 'type', 'definition', '']
                        : ['constraint_name', 'type', 'definition']
                    }
                  />
                </thead>
                <tbody>
                  {structure.constraints.map((c) => {
                    const dropped = model.droppedConstraints.includes(c.name);
                    return (
                      <tr
                        key={c.name}
                        className={cn(
                          'even:bg-[var(--grid-row-b)] odd:bg-[var(--grid-row-a)]',
                          dropped && 'opacity-50',
                        )}
                      >
                        <Td
                          className={cn(
                            'font-medium text-[var(--wb-text)]',
                            dropped && 'line-through',
                          )}
                        >
                          {c.name}
                        </Td>
                        <Td className="whitespace-nowrap">
                          <Tag>{CONSTRAINT_LABEL[c.type]}</Tag>
                        </Td>
                        <Td className="whitespace-pre-wrap break-words text-[var(--wb-text-2)]">
                          {c.definition}
                        </Td>
                        {editable && (
                          <Td className="w-8 text-center">
                            <IconButton
                              label={
                                dropped ? `Keep constraint ${c.name}` : `Drop constraint ${c.name}`
                              }
                              onClick={() =>
                                setModel((m) => ({
                                  ...m,
                                  droppedConstraints: dropped
                                    ? m.droppedConstraints.filter((n) => n !== c.name)
                                    : [...m.droppedConstraints, c.name],
                                }))
                              }
                            >
                              {dropped ? <Undo2 /> : <X />}
                            </IconButton>
                          </Td>
                        )}
                      </tr>
                    );
                  })}
                  {model.addedConstraints.map((c, i) => (
                    <tr
                      // biome-ignore lint/suspicious/noArrayIndexKey: staged rows have no id
                      key={`newcon-${i}`}
                      className="bg-[var(--grid-row-a)] shadow-[inset_2px_0_0_var(--wb-accent)]"
                    >
                      <Td className="text-[var(--wb-text-2)]">
                        {('name' in c && c.name) || 'new'}
                      </Td>
                      <Td>
                        <Tag>{CONSTRAINT_LABEL[c.type]}</Tag>
                      </Td>
                      <Td className="whitespace-pre-wrap break-words text-[var(--wb-text-2)]">
                        {describeConstraint(c)}
                      </Td>
                      <Td className="w-8 text-center">
                        <IconButton
                          label="Remove staged constraint"
                          onClick={() =>
                            setModel((m) => ({
                              ...m,
                              addedConstraints: m.addedConstraints.filter((_, j) => j !== i),
                            }))
                          }
                        >
                          <X />
                        </IconButton>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <Section
              title="Indexes"
              empty={structure.indexes.length === 0 && model.addedIndexes.length === 0}
            >
              <table className="w-full border-collapse font-mono text-[13px] text-[var(--grid-text)]">
                <thead>
                  <HeadRow
                    cols={
                      editable
                        ? ['index_name', 'algorithm', 'is_unique', 'columns', 'condition', '']
                        : ['index_name', 'algorithm', 'is_unique', 'columns', 'condition']
                    }
                  />
                </thead>
                <tbody>
                  {structure.indexes.map((i) => {
                    const owned = constraintNames.has(i.name);
                    const dropped =
                      model.droppedIndexes.includes(i.name) ||
                      (owned && model.droppedConstraints.includes(i.name));
                    return (
                      <tr
                        key={i.name}
                        className={cn(
                          'even:bg-[var(--grid-row-b)] odd:bg-[var(--grid-row-a)]',
                          dropped && 'opacity-50',
                        )}
                        title={i.definition}
                      >
                        <Td
                          className={cn(
                            'font-medium text-[var(--wb-text)]',
                            dropped && 'line-through',
                          )}
                        >
                          {i.name}
                        </Td>
                        <Td className="text-[var(--wb-text-2)]">{i.method}</Td>
                        <Td
                          className={i.unique ? 'text-[var(--wb-text)]' : 'text-[var(--wb-text-2)]'}
                        >
                          {i.unique ? 'TRUE' : 'FALSE'}
                        </Td>
                        <Td className="text-[var(--wb-text)]">{i.columns}</Td>
                        <Td className="text-[var(--wb-text-2)]">
                          {i.condition || <span className="text-[var(--grid-null)]">—</span>}
                        </Td>
                        {editable && (
                          <Td className="w-8 text-center">
                            {owned ? (
                              <span
                                className="font-sans text-[11px] text-[var(--wb-text-3)]"
                                title="Drop the constraint of the same name instead"
                              >
                                constraint
                              </span>
                            ) : (
                              <IconButton
                                label={dropped ? `Keep index ${i.name}` : `Drop index ${i.name}`}
                                onClick={() =>
                                  setModel((m) => ({
                                    ...m,
                                    droppedIndexes: dropped
                                      ? m.droppedIndexes.filter((n) => n !== i.name)
                                      : [...m.droppedIndexes, i.name],
                                  }))
                                }
                              >
                                {dropped ? <Undo2 /> : <X />}
                              </IconButton>
                            )}
                          </Td>
                        )}
                      </tr>
                    );
                  })}
                  {model.addedIndexes.map((ix, i) => (
                    <tr
                      // biome-ignore lint/suspicious/noArrayIndexKey: staged rows have no id
                      key={`newidx-${i}`}
                      className="bg-[var(--grid-row-a)] shadow-[inset_2px_0_0_var(--wb-accent)]"
                    >
                      <Td className="text-[var(--wb-text-2)]">{ix.name || 'new'}</Td>
                      <Td className="text-[var(--wb-text-2)]">{ix.method ?? 'btree'}</Td>
                      <Td>{ix.unique ? 'TRUE' : 'FALSE'}</Td>
                      <Td>{ix.columns.join(', ')}</Td>
                      <Td className="text-[var(--wb-text-2)]">
                        {ix.where || '—'}
                        {ix.concurrently ? ' · concurrently' : ''}
                      </Td>
                      <Td className="w-8 text-center">
                        <IconButton
                          label="Remove staged index"
                          onClick={() =>
                            setModel((m) => ({
                              ...m,
                              addedIndexes: m.addedIndexes.filter((_, j) => j !== i),
                            }))
                          }
                        >
                          <X />
                        </IconButton>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          </>
        ) : null}
      </div>

      {editable && staged > 0 && (
        <div
          className="flex max-h-[45%] shrink-0 flex-col gap-2 border-t border-[var(--wb-separator)] bg-[var(--wb-content)] p-2"
          data-testid="structure-staged"
        >
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-[var(--wb-text)]">
              {staged} staged change{staged === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              className="text-[12px] text-[var(--wb-text-2)] underline-offset-2 hover:underline"
              onClick={() => setShowPreview((v) => !v)}
            >
              {showPreview ? 'Hide' : 'Preview'} SQL
            </button>
            <div className="flex-1" />
            <Pill
              onClick={() => {
                setModel(EMPTY_MODEL);
                setApplyError(null);
              }}
              disabled={applying}
            >
              Discard
            </Pill>
            <Pill
              onClick={() => void apply()}
              disabled={applying || built.problem !== null || !built.plan || lintBlocked}
              data-testid="structure-apply"
            >
              {applying ? 'Applying…' : 'Apply'}
            </Pill>
          </div>
          {!built.problem && built.sql.trim() !== '' && (
            <MigrationCheckPanel sql={built.sql} onBlockedChange={setLintBlocked} />
          )}
          {showPreview && (
            <SqlPreview className="min-h-0" sql={built.sql} error={built.problem} lint={false} />
          )}
          {applyError && (
            <pre
              className="whitespace-pre-wrap font-mono text-[12px] text-destructive"
              data-testid="structure-apply-error"
            >
              {applyError}
            </pre>
          )}
        </div>
      )}

      <AddIndexDialog
        open={addIndexOpen}
        schema={schemaName}
        table={tableName}
        columns={effective.map((c) => c.name).filter(Boolean)}
        onCancel={() => setAddIndexOpen(false)}
        onAdd={(spec) => {
          setModel((m) => ({ ...m, addedIndexes: [...m.addedIndexes, spec] }));
          setAddIndexOpen(false);
        }}
      />
      <AddConstraintDialog
        open={addConstraintOpen}
        schema={schemaName}
        table={tableName}
        columns={effective.map((c) => c.name).filter(Boolean)}
        hasPrimaryKey={
          (structure?.constraints ?? []).some(
            (c) => c.type === 'primary' && !model.droppedConstraints.includes(c.name),
          ) || model.addedConstraints.some((c) => c.type === 'primary')
        }
        onCancel={() => setAddConstraintOpen(false)}
        onAdd={(spec) => {
          setModel((m) => ({ ...m, addedConstraints: [...m.addedConstraints, spec] }));
          setAddConstraintOpen(false);
        }}
      />
    </div>
  );

  function patchAdded(i: number, patch: Partial<EditModel['addedColumns'][number]>) {
    setModel((m) => ({
      ...m,
      addedColumns: m.addedColumns.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    }));
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function describeConstraint(c: EditModel['addedConstraints'][number]): string {
  if (c.type === 'check') return `CHECK (${c.expression})`;
  if (c.type === 'foreign') {
    return `FOREIGN KEY (${c.columns.join(', ')}) REFERENCES ${c.refSchema}.${c.refTable} (${c.refColumns.join(', ')})${
      c.onDelete && c.onDelete !== 'NO ACTION' ? ` ON DELETE ${c.onDelete}` : ''
    }${c.onUpdate && c.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${c.onUpdate}` : ''}`;
  }
  return `${c.type === 'primary' ? 'PRIMARY KEY' : 'UNIQUE'} (${c.columns.join(', ')})`;
}

const CONSTRAINT_LABEL: Record<StructureConstraint['type'], string> = {
  primary: 'PRIMARY KEY',
  foreign: 'FOREIGN KEY',
  unique: 'UNIQUE',
  check: 'CHECK',
  exclude: 'EXCLUDE',
  other: 'OTHER',
};

function Section({
  title,
  empty = false,
  children,
}: {
  title: string;
  empty?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-[var(--wb-separator)]">
      <h3 className="px-3 pb-1.5 pt-4 text-[13px] font-semibold text-[var(--wb-text)]">{title}</h3>
      {empty ? (
        <div className="px-3 pb-4 text-[13px] text-[var(--wb-text-2)]">none</div>
      ) : (
        <div className="px-2 pb-3">{children}</div>
      )}
    </section>
  );
}

function HeadRow({ cols }: { cols: string[] }) {
  return (
    <tr className="bg-[var(--wb-content)] text-left shadow-[inset_0_-1px_0_var(--wb-separator)]">
      {cols.map((c) => (
        <th
          key={c}
          className="h-[26px] whitespace-nowrap border-r border-[var(--grid-line)] px-2 font-sans text-[13px] font-semibold text-[var(--grid-text)]"
        >
          {c}
        </th>
      ))}
    </tr>
  );
}

function Td({
  children,
  className,
  title,
  colSpan,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
  colSpan?: number;
}) {
  return (
    <td
      className={cn('border-r border-[var(--grid-line)] px-2 py-[3px] align-top', className)}
      title={title}
      colSpan={colSpan}
    >
      {children}
    </td>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block whitespace-nowrap rounded-[4px] bg-[var(--wb-control)] px-1 py-px font-sans text-[11px] text-[var(--wb-text-2)]">
      {children}
    </span>
  );
}

/** `public.users(id)` → clickable link that opens the referenced table. */
function FkLink({ target }: { target: string }) {
  const schema = useSession((s) => s.schema);
  const openTable = useSession((s) => s.openTable);

  const resolve = useCallback(() => {
    const rel = target.slice(0, target.indexOf('(')).trim();
    const parts = splitIdentList(rel.replace(/\./g, ','));
    const [refSchema, refTable] = parts.length > 1 ? parts : [null, parts[0]];
    const hit = schema?.tables.find(
      (t) => t.name === refTable && (refSchema ? t.schema === refSchema : true),
    );
    return hit ? { schema: hit.schema, name: hit.name } : null;
  }, [schema, target]);

  const ref = resolve();
  if (!ref) return <span className="text-[var(--wb-text-2)]">→ {target}</span>;
  return (
    <button
      type="button"
      onClick={() => openTable(ref.schema, ref.name)}
      className="inline-flex items-center gap-0.5 text-[var(--wb-accent-text)] underline-offset-2 hover:underline"
      title={`Open ${ref.schema}.${ref.name}`}
    >
      → {target}
      <ArrowUpRight className="h-3 w-3" />
    </button>
  );
}
