import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useActiveTab, useSession } from '@/stores/session';
import type { SchemaInfo } from '@shared/protocol';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { GENERATOR_CHOICES, type GenKind, defaultKind, generate } from './mock-generators';
import { buildMockInserts } from './mock-insert';

/**
 * Mock data generator. Pick a row count, hit Generate, and Plasma
 * builds a single multi-row INSERT statement using a per-column data
 * generator chosen from data type + name heuristics. Edit-mode-gated
 * so users can't blow real data into a connection by accident.
 *
 * Generators live in `mock-generators.ts` (no `faker` dep) and respect
 * `char(n)` / `varchar(n)` widths. Per-column overrides let users pin
 * specific values (great for FK columns that have to match).
 */
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
      // R-23: batches stay under Postgres' bind-parameter limit.
      const batches = buildMockInserts({
        schema: tableSchema,
        table: tableName,
        columns: enabled.map((c) => c.name),
        count,
        cell: (ci, r) => generate(enabled[ci]!, r),
      });
      // A7: mock rows are writes — refuse on read-only connections and
      // confirm on prod-tagged ones.
      const session = useSession.getState();
      if (session.activeConfig?.readOnly) {
        throw new Error('This connection is read-only.');
      }
      const outcome = await session.confirmUserSqlDetailed(batches[0]?.sql ?? '', {
        force: true,
        summary: `Insert ${count} mock rows into ${tableSchema}.${tableName}`,
      });
      if (!outcome.ok) {
        // R-09: say why nothing happened (safe mode) instead of just stopping.
        if (outcome.reason === 'refused') setError(outcome.message);
        setBusy(false);
        return;
      }
      // One transaction for all batches (unless the user already has one open).
      const ownTxn = session.txnState === 'none';
      if (ownTxn) useSession.setState({ txnState: await ipc.txn.begin() });
      try {
        for (const batch of batches) {
          await ipc.query.run(batch.sql, batch.params, { internal: true });
        }
        if (ownTxn) useSession.setState({ txnState: await ipc.txn.commit() });
      } catch (err) {
        if (ownTxn) {
          try {
            useSession.setState({ txnState: await ipc.txn.rollback() });
          } catch {
            /* connection already gone */
          }
        }
        throw err;
      }
      onOpenChange(false);
      void refreshTable();
    } catch (err) {
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[var(--wb-text-2)]" aria-hidden />
            Generate mock rows
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            <span className="font-mono text-[var(--wb-text)]">
              {tableSchema}.{tableName}
            </span>{' '}
            · {columns.length} columns detected
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-end gap-2">
          <Label htmlFor="mock-count" className="text-[12px] font-medium text-[var(--wb-text-2)]">
            Rows
          </Label>
          <Input
            id="mock-count"
            type="number"
            inputMode="numeric"
            min={1}
            max={5000}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))}
            className="w-24"
          />
        </div>

        <div className="-mx-2 max-h-[420px] overflow-y-auto px-2">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 z-10 bg-[var(--wb-content)]">
              <tr className="border-b border-[var(--wb-separator)] text-left text-[12px] font-medium text-[var(--wb-text-2)]">
                <th className="w-8" />
                <th className="px-2 py-1.5 font-medium">Column</th>
                <th className="px-2 py-1.5 font-medium">Type</th>
                <th className="px-2 py-1.5 font-medium">Generator</th>
                <th className="px-2 py-1.5 font-medium">Fixed value</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c, idx) => (
                <tr key={c.name} className="border-b border-[var(--wb-separator)] align-middle">
                  <td className="px-2 py-1.5">
                    <Checkbox
                      checked={c.enabled}
                      onCheckedChange={(v) => update(idx, { enabled: v === true })}
                      aria-label={`Include ${c.name}`}
                    />
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[12px] text-[var(--wb-text)]">
                    {c.name}
                    {c.isPrimaryKey && (
                      <span className="ml-1.5 rounded-[4px] bg-[var(--wb-control)] px-1 py-0.5 font-sans text-[11px] text-[var(--wb-text-2)]">
                        PK
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[12px] text-[var(--wb-text-2)]">
                    {c.dataType}
                  </td>
                  <td className="px-2 py-1.5">
                    <Select
                      value={c.kind}
                      onValueChange={(v) => update(idx, { kind: v as GenKind })}
                      disabled={!c.enabled}
                    >
                      <SelectTrigger className="w-[140px]" aria-label={`Generator for ${c.name}`}>
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
                    {/* Always editable: typing a value switches the column to "fixed". */}
                    <Input
                      value={c.fixedValue}
                      onChange={(e) =>
                        update(idx, {
                          fixedValue: e.target.value,
                          ...(e.target.value !== '' ? { kind: 'fixed' as const } : {}),
                        })
                      }
                      disabled={!c.enabled}
                      placeholder={c.kind === 'fixed' ? 'Empty string' : 'Generated'}
                      aria-label={`Fixed value for ${c.name}`}
                      className="min-w-[120px]"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-[6px] border border-destructive/40 bg-destructive/10 p-2 text-[12px] text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void onGenerate()} disabled={busy}>
            Generate {count} rows
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function columnsFor(
  schema: SchemaInfo,
  tableSchema: string,
  tableName: string,
): SchemaInfo['columns'] {
  return schema.columns
    .filter((c) => c.schema === tableSchema && c.table === tableName)
    .sort((a, b) => a.ordinal - b.ordinal);
}
