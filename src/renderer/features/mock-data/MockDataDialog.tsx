import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ipc } from '@/lib/ipc';
import { quoteIdent } from '@/lib/table-query';
import { useActiveTab, useSession } from '@/stores/session';
import type { SchemaInfo } from '@shared/protocol';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

/**
 * Mock data generator. Pick a row count, hit Generate, and Plasma
 * builds a single multi-row INSERT statement using a per-column data
 * generator chosen from data type + name heuristics. Edit-mode-gated
 * so users can't blow real data into a connection by accident.
 *
 * No `faker` dep — the built-in generators cover text / numeric /
 * timestamp / uuid / boolean / json. Per-column overrides let users
 * pin specific values (great for FK columns that have to match).
 */
type GenKind =
  | 'auto'
  | 'name-first'
  | 'name-last'
  | 'name-full'
  | 'email'
  | 'url'
  | 'lorem'
  | 'word'
  | 'int'
  | 'numeric'
  | 'bool'
  | 'timestamp'
  | 'date'
  | 'uuid'
  | 'json'
  | 'fixed'
  | 'null';

interface ColPlan {
  name: string;
  dataType: string;
  isNullable: boolean;
  hasDefault: boolean;
  isPrimaryKey: boolean;
  kind: GenKind;
  fixedValue: string;
  enabled: boolean;
}

export function MockDataDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const tab = useActiveTab();
  const schema = useSession((s) => s.schema);
  const refreshTable = useSession((s) => s.refreshTable);
  const [count, setCount] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColPlan[]>([]);

  const tableSchema = tab?.kind === 'table' ? tab.tableSchema : undefined;
  const tableName = tab?.kind === 'table' ? tab.tableName : undefined;
  const cols = useMemo(
    () => (schema && tableSchema && tableName ? columnsFor(schema, tableSchema, tableName) : []),
    [schema, tableSchema, tableName],
  );

  useEffect(() => {
    if (!open) return;
    setColumns(
      cols.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        isNullable: c.isNullable,
        hasDefault: c.hasDefault,
        isPrimaryKey: c.isPrimaryKey,
        kind: defaultKind(c),
        fixedValue: '',
        // Skip serial-style PKs and columns with defaults by default —
        // letting Postgres compute them is almost always what you want.
        enabled: !(c.isPrimaryKey && c.hasDefault) && !c.hasDefault,
      })),
    );
    setError(null);
  }, [open, cols]);

  const update = (idx: number, patch: Partial<ColPlan>) => {
    setColumns((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };

  const onGenerate = async () => {
    if (!tableSchema || !tableName) return;
    setBusy(true);
    setError(null);
    try {
      const enabled = columns.filter((c) => c.enabled);
      if (enabled.length === 0) {
        setError('Select at least one column.');
        setBusy(false);
        return;
      }
      const params: unknown[] = [];
      const valueRows: string[] = [];
      for (let r = 0; r < count; r++) {
        const cells: string[] = [];
        for (const col of enabled) {
          const v = generate(col, r);
          if (v === undefined) {
            cells.push('DEFAULT');
            continue;
          }
          if (v === null) {
            cells.push('NULL');
            continue;
          }
          params.push(v);
          cells.push(`$${params.length}`);
        }
        valueRows.push(`(${cells.join(', ')})`);
      }
      const colList = enabled.map((c) => quoteIdent(c.name)).join(', ');
      const sql = `INSERT INTO ${quoteIdent(tableSchema)}.${quoteIdent(tableName)} (${colList}) VALUES\n${valueRows.join(',\n')}`;
      await ipc.query.run(sql, params, { internal: true });
      onOpenChange(false);
      void refreshTable();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Generate mock rows
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <div className="text-sm text-muted-foreground">
            <span className="font-mono text-foreground">
              {tableSchema}.{tableName}
            </span>{' '}
            · {columns.length} columns detected
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="mock-count" className="text-xs">
              Rows
            </Label>
            <Input
              id="mock-count"
              type="number"
              min={1}
              max={5000}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))}
              className="w-24"
            />
          </div>
        </div>

        <div className="-mx-2 max-h-[420px] overflow-y-auto px-2">
          <table className="w-full font-mono text-xs">
            <thead className="sticky top-0 bg-background">
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="w-8" />
                <th className="px-2 py-1.5">column</th>
                <th className="px-2 py-1.5">type</th>
                <th className="px-2 py-1.5">generator</th>
                <th className="px-2 py-1.5">fixed value</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c, idx) => (
                <tr key={c.name} className="border-b border-border/60 align-top">
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={(e) => update(idx, { enabled: e.target.checked })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    {c.name}
                    {c.isPrimaryKey && (
                      <span className="ml-1 text-[9px] uppercase text-primary">PK</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">{c.dataType}</td>
                  <td className="px-2 py-1.5">
                    <Select
                      value={c.kind}
                      onValueChange={(v) => update(idx, { kind: v as GenKind })}
                    >
                      <SelectTrigger className="h-7 w-[140px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {GENERATOR_CHOICES.map((g) => (
                          <SelectItem key={g} value={g}>
                            {g}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-2 py-1.5">
                    {c.kind === 'fixed' && (
                      <Input
                        value={c.fixedValue}
                        onChange={(e) => update(idx, { fixedValue: e.target.value })}
                        className="h-7 text-xs"
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 font-mono text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void onGenerate()} disabled={busy}>
            Generate {count} rows
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const GENERATOR_CHOICES: GenKind[] = [
  'auto',
  'name-first',
  'name-last',
  'name-full',
  'email',
  'url',
  'lorem',
  'word',
  'int',
  'numeric',
  'bool',
  'timestamp',
  'date',
  'uuid',
  'json',
  'fixed',
  'null',
];

function columnsFor(
  schema: SchemaInfo,
  tableSchema: string,
  tableName: string,
): SchemaInfo['columns'] {
  return schema.columns
    .filter((c) => c.schema === tableSchema && c.table === tableName)
    .sort((a, b) => a.ordinal - b.ordinal);
}

function defaultKind(col: { name: string; dataType: string }): GenKind {
  const t = col.dataType.toLowerCase();
  const n = col.name.toLowerCase();
  if (t.includes('uuid')) return 'uuid';
  if (t.includes('json')) return 'json';
  if (t.includes('timestamp')) return 'timestamp';
  if (t.includes('date')) return 'date';
  if (t === 'boolean' || t === 'bool') return 'bool';
  if (t.includes('int')) return 'int';
  if (t.includes('numeric') || t.includes('float') || t.includes('double') || t.includes('real'))
    return 'numeric';
  if (n === 'email' || n.endsWith('_email')) return 'email';
  if (n.endsWith('_url') || n === 'url') return 'url';
  if (n === 'first_name' || n === 'firstname' || n === 'given_name') return 'name-first';
  if (n === 'last_name' || n === 'lastname' || n === 'family_name' || n === 'surname')
    return 'name-last';
  if (n === 'name' || n === 'full_name' || n === 'fullname') return 'name-full';
  if (n.endsWith('_at') || n.endsWith('_time')) return 'timestamp';
  return 'lorem';
}

const FIRST_NAMES = [
  'Ada',
  'Linus',
  'Grace',
  'Alan',
  'Margaret',
  'Donald',
  'Edsger',
  'Barbara',
  'Tony',
  'Niklaus',
  'John',
  'Karen',
  'Brian',
  'Anita',
  'Dennis',
  'Vint',
  'Radia',
  'Frances',
  'Tim',
  'Sandi',
];
const LAST_NAMES = [
  'Lovelace',
  'Torvalds',
  'Hopper',
  'Turing',
  'Hamilton',
  'Knuth',
  'Dijkstra',
  'Liskov',
  'Hoare',
  'Wirth',
  'Carmack',
  'Sandberg',
  'Kernighan',
  'Borg',
  'Ritchie',
  'Cerf',
  'Perlman',
  'Allen',
  'Berners-Lee',
  'Metz',
];
const WORDS = [
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'sed',
  'tempor',
  'incididunt',
  'ut',
  'labore',
  'magna',
  'aliqua',
];

function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)];
}

function randInt(lo: number, hi: number): number {
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

/**
 * Returns the value to bind for this column.
 *  - `undefined` → emit `DEFAULT` (skip the param)
 *  - `null` → emit `NULL` literal
 *  - any other value is bound via `$N` to keep the SQL injection-free
 */
function generate(col: ColPlan, idx: number): unknown {
  if (col.kind === 'null') return null;
  if (col.kind === 'fixed') return col.fixedValue;
  const kind = col.kind === 'auto' ? defaultKind(col) : col.kind;
  switch (kind) {
    case 'name-first':
      return pick(FIRST_NAMES);
    case 'name-last':
      return pick(LAST_NAMES);
    case 'name-full':
      return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    case 'email':
      return `${pick(FIRST_NAMES).toLowerCase()}.${idx}@example.com`;
    case 'url':
      return `https://example.com/${randInt(1000, 9999)}`;
    case 'lorem':
      return Array.from({ length: randInt(3, 8) }, () => pick(WORDS)).join(' ');
    case 'word':
      return pick(WORDS);
    case 'int':
      return randInt(0, 10000);
    case 'numeric':
      return Math.round(Math.random() * 10000) / 100;
    case 'bool':
      return Math.random() < 0.5;
    case 'timestamp': {
      const d = new Date(Date.now() - randInt(0, 365 * 24 * 3600 * 1000));
      return d.toISOString();
    }
    case 'date': {
      const d = new Date(Date.now() - randInt(0, 365 * 24 * 3600 * 1000));
      return d.toISOString().slice(0, 10);
    }
    case 'uuid':
      return crypto.randomUUID?.() ?? `${randInt(1, 1e9)}-${idx}`;
    case 'json':
      return JSON.stringify({ idx, sample: pick(WORDS) });
    default:
      return pick(WORDS);
  }
}
