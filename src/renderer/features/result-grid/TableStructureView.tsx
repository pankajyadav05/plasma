import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
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
import { ArrowUpRight, KeyRound, Loader2, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Structure view for a table tab — the TablePlus "Structure" + "Index"
 * panes stacked on one scrollable page:
 *
 *   Columns      #, name, type, nullable, default, key / reference
 *   Constraints  name, type, definition
 *   Indexes      name, method, unique, columns, condition
 *
 * Read-only. Built from the same catalog query as the DDL view, so the
 * two never disagree. Foreign-key targets are clickable and open the
 * referenced table.
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
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [schemaName, tableName, reloadKey]);

  const columns = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = structure?.columns ?? [];
    return q ? all.filter((c) => c.name.toLowerCase().includes(q) || c.type.includes(q)) : all;
  }, [structure, filter]);

  if (!schemaName || !tableName) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search columns…"
            aria-label="Search columns"
            className="h-7 w-full rounded-md border border-border bg-background pl-8 pr-2 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
          />
        </div>
        {structure && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {structure.columns.length} columns · {structure.constraints.length} constraints ·{' '}
            {structure.indexes.length} indexes
          </span>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          aria-label="Reload structure"
          title="Reload structure"
        >
          <RefreshCw className={loading ? 'animate-spin' : ''} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !structure ? (
          <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="font-display text-sm italic">reading the catalog…</span>
          </div>
        ) : error ? (
          <div className="max-w-3xl p-8">
            <div className="font-display text-lg italic text-foreground">
              Couldn't read this table's structure
            </div>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-destructive">
              {error}
            </pre>
          </div>
        ) : structure ? (
          <>
            <Section title="Columns">
              <table className="w-full border-collapse font-mono text-xs">
                <thead>
                  <HeadRow cols={['#', 'column_name', 'data_type', 'nullable', 'default', 'key']} />
                </thead>
                <tbody>
                  {columns.map((c) => (
                    <tr key={c.name} className="border-b border-border/60 hover:bg-accent/50">
                      <Td className="w-10 text-right text-muted-foreground">{c.ordinal}</Td>
                      <Td className="font-medium text-foreground">
                        <span className="flex items-center gap-1.5">
                          {c.primaryKey && (
                            <KeyRound className="h-3 w-3 text-primary" aria-label="primary key" />
                          )}
                          {c.name}
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap text-[var(--type-num)]">{c.type}</Td>
                      <Td className={c.nullable ? 'text-foreground' : 'text-muted-foreground'}>
                        {c.nullable ? 'YES' : 'NO'}
                      </Td>
                      <Td
                        className="max-w-[280px] truncate text-muted-foreground"
                        title={c.defaultExpr}
                      >
                        {c.defaultExpr || <span className="text-[var(--type-null)]">NULL</span>}
                      </Td>
                      <Td className="whitespace-nowrap">
                        <span className="flex items-center gap-1">
                          {c.primaryKey && <Tag>PK</Tag>}
                          {c.unique && <Tag>UNIQUE</Tag>}
                          {c.references && <FkLink target={c.references} />}
                        </span>
                      </Td>
                    </tr>
                  ))}
                  {columns.length === 0 && (
                    <tr>
                      <Td className="font-display italic text-muted-foreground" colSpan={6}>
                        no column matches "{filter}"
                      </Td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Section>

            <Section title="Constraints" empty={structure.constraints.length === 0}>
              <table className="w-full border-collapse font-mono text-xs">
                <thead>
                  <HeadRow cols={['constraint_name', 'type', 'definition']} />
                </thead>
                <tbody>
                  {structure.constraints.map((c) => (
                    <tr key={c.name} className="border-b border-border/60 hover:bg-accent/50">
                      <Td className="font-medium text-foreground">{c.name}</Td>
                      <Td>
                        <Tag>{CONSTRAINT_LABEL[c.type]}</Tag>
                      </Td>
                      <Td className="whitespace-pre-wrap break-words text-muted-foreground">
                        {c.definition}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <Section title="Indexes" empty={structure.indexes.length === 0}>
              <table className="w-full border-collapse font-mono text-xs">
                <thead>
                  <HeadRow
                    cols={['index_name', 'algorithm', 'is_unique', 'columns', 'condition']}
                  />
                </thead>
                <tbody>
                  {structure.indexes.map((i) => (
                    <tr
                      key={i.name}
                      className="border-b border-border/60 hover:bg-accent/50"
                      title={i.definition}
                    >
                      <Td className="font-medium text-foreground">{i.name}</Td>
                      <Td className="text-muted-foreground">{i.method}</Td>
                      <Td
                        className={i.unique ? 'text-[var(--type-bool)]' : 'text-muted-foreground'}
                      >
                        {i.unique ? 'TRUE' : 'FALSE'}
                      </Td>
                      <Td className="text-foreground">{i.columns}</Td>
                      <Td className="text-muted-foreground">
                        {i.condition || <span className="text-[var(--type-null)]">—</span>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          </>
        ) : null}
      </div>
    </div>
  );
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
    <section className="border-b border-border">
      <h3 className="px-4 pb-1.5 pt-4 font-display text-base italic text-foreground">{title}</h3>
      {empty ? (
        <div className="px-4 pb-4 font-display text-sm italic text-muted-foreground">none</div>
      ) : (
        <div className="px-2 pb-3">{children}</div>
      )}
    </section>
  );
}

function HeadRow({ cols }: { cols: string[] }) {
  return (
    <tr className="border-b-2 border-foreground/80 text-left">
      {cols.map((c) => (
        <th
          key={c}
          className="whitespace-nowrap px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
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
    <td className={cn('px-2 py-1.5 align-top', className)} title={title} colSpan={colSpan}>
      {children}
    </td>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-sm border border-border px-1 py-px text-[9px] uppercase tracking-wider text-muted-foreground">
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
  if (!ref) return <span className="text-muted-foreground">→ {target}</span>;
  return (
    <button
      type="button"
      onClick={() => openTable(ref.schema, ref.name)}
      className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline"
      title={`Open ${ref.schema}.${ref.name}`}
    >
      → {target}
      <ArrowUpRight className="h-3 w-3" />
    </button>
  );
}
