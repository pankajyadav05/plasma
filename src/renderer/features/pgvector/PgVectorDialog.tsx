import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/ui/view-parts';
import { readableTypeName } from '@/lib/pg-types';
import { useActiveTabSansSql, useSession } from '@/stores/session';
import type { QueryResult } from '@shared/protocol';
import { Brain, Check, Copy, Sigma } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type Distance, buildNearestSql, parseTableRef } from './nearest-sql';

/**
 * pgvector helper. When a result contains `vector` columns, this dialog
 * surfaces:
 *   - dimensions per column (parsed from a sample row)
 *   - "find nearest" SQL builder using the chosen distance operator
 *
 * The generated SQL targets the active table tab when the user is on
 * one (so we know which table to ORDER BY from). For SQL tabs the user
 * gets a template they can paste + adjust.
 */
export function PgVectorDialog({
  result,
  open,
  onOpenChange,
}: {
  result: QueryResult | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const tab = useActiveTabSansSql();
  const openSqlInNewTab = useSession((s) => s.openSqlInNewTab);

  const vectorCols = useMemo(
    () =>
      (result?.columns ?? []).filter(
        (c) => c.dataTypeName === 'vector' || /vector/i.test(c.dataTypeName),
      ),
    [result],
  );

  const dims = useMemo(() => {
    const out: Record<string, number | null> = {};
    if (!result) return out;
    for (const c of vectorCols) {
      const idx = result.columns.findIndex((x) => x.name === c.name);
      let firstVec: string | null = null;
      for (const row of result.rows) {
        const v = row[idx];
        if (typeof v === 'string' && v.length > 0) {
          firstVec = v;
          break;
        }
      }
      out[c.name] = firstVec ? parseDim(firstVec) : null;
    }
    return out;
  }, [result, vectorCols]);

  const [pickedCol, setColName] = useState<string>('');
  const [pickedRow, setRowIdx] = useState<number>(0);
  const [distance, setDistance] = useState<Distance>('cosine');
  const [limit, setLimit] = useState<number>(10);
  const [copied, setCopied] = useState(false);
  const [tableText, setTableText] = useState('');

  // R-22: picks made for an earlier result must not leak into this one.
  const colName = vectorCols.some((c) => c.name === pickedCol)
    ? pickedCol
    : (vectorCols[0]?.name ?? '');
  const rowIdx = Math.max(0, Math.min(pickedRow, (result?.rows.length ?? 1) - 1));

  const anchor = useMemo(() => {
    if (!result || !colName) return '';
    const idx = result.columns.findIndex((c) => c.name === colName);
    if (idx === -1) return '';
    const v = result.rows[rowIdx]?.[idx];
    return typeof v === 'string' ? v : '';
  }, [result, colName, rowIdx]);

  // A table tab names its table; for a SQL tab the user must say which one.
  const fromTab =
    tab?.kind === 'table' && tab.tableSchema && tab.tableName
      ? { schema: tab.tableSchema as string, table: tab.tableName as string }
      : null;
  const table = fromTab ?? parseTableRef(tableText);

  const sql = useMemo(
    () => buildNearestSql({ anchor, column: colName, distance, limit, table }),
    [anchor, colName, distance, limit, table],
  );

  const handleCopy = () => {
    if (!sql) return;
    void navigator.clipboard?.writeText(sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const insertIntoEditor = () => {
    if (!sql) return;
    // Never clobbers the buffer the user is working in.
    openSqlInNewTab(sql);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-[var(--wb-text-2)]" />
            pgvector
          </DialogTitle>
          <DialogDescription>
            Vector dimensions and a nearest-neighbor query builder for this result.
          </DialogDescription>
        </DialogHeader>

        {vectorCols.length === 0 ? (
          <EmptyState
            title="No vector columns"
            hint="This result has no pgvector columns."
            className="min-h-[120px]"
          />
        ) : (
          <>
            <div className="overflow-hidden rounded-[7px] border border-[var(--wb-separator)]">
              <table className="w-full text-[12px]">
                <thead className="bg-[var(--wb-sidebar)]">
                  <tr className="border-b border-[var(--wb-separator)] text-left text-[12px] font-medium text-[var(--wb-text-2)]">
                    <th className="px-2 py-1.5 font-medium">Column</th>
                    <th className="px-2 py-1.5 font-medium">Type</th>
                    <th className="px-2 py-1.5 font-medium">Dimensions</th>
                  </tr>
                </thead>
                <tbody>
                  {vectorCols.map((c) => (
                    <tr
                      key={c.name}
                      className="border-b border-[var(--wb-separator)] font-mono text-[var(--wb-text)] last:border-b-0 even:bg-[var(--grid-row-a)]"
                    >
                      <td className="px-2 py-1.5">{c.name}</td>
                      <td className="px-2 py-1.5 text-[var(--wb-text-2)]">{readableTypeName(c)}</td>
                      <td className="px-2 py-1.5">
                        <span className="inline-flex items-center gap-1">
                          <Sigma className="h-3 w-3 text-[var(--wb-text-3)]" />
                          {dims[c.name] ?? '?'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-4 gap-3">
              <Field label="Anchor column">
                <Select value={colName} onValueChange={setColName}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {vectorCols.map((c) => (
                      <SelectItem key={c.name} value={c.name}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Anchor row">
                <Input
                  type="number"
                  value={rowIdx}
                  min={0}
                  max={(result?.rows.length ?? 1) - 1}
                  onChange={(e) => setRowIdx(Number(e.target.value) || 0)}
                />
              </Field>
              <Field label="Distance">
                <Select value={distance} onValueChange={(v) => setDistance(v as Distance)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cosine">cosine ({'<=>'})</SelectItem>
                    <SelectItem value="l2">L2 ({'<->'})</SelectItem>
                    <SelectItem value="inner">inner ({'<#>'})</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Limit">
                <Input
                  type="number"
                  min={1}
                  max={1000}
                  value={limit}
                  onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 10))}
                />
              </Field>
            </div>

            {!fromTab && (
              <Field label="Source table (required for a SQL result)">
                <Input
                  value={tableText}
                  onChange={(e) => setTableText(e.target.value)}
                  placeholder="schema.table"
                  aria-invalid={tableText !== '' && !table}
                />
              </Field>
            )}

            <div className="overflow-hidden rounded-[7px] border border-[var(--wb-separator)]">
              <div className="flex items-center gap-2 border-b border-[var(--wb-separator)] bg-[var(--wb-sidebar)] px-2 py-1 text-[12px] font-medium text-[var(--wb-text-2)]">
                <span>Nearest-neighbor SQL</span>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleCopy}
                  aria-label="Copy SQL"
                  title="Copy SQL"
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              </div>
              <pre className="overflow-x-auto bg-[var(--wb-content)] p-3 font-mono text-[12px] text-[var(--wb-text)]">
                {sql || (table ? '-- pick an anchor row above' : '-- enter the source table above')}
              </pre>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button variant="primary" onClick={insertIntoEditor} disabled={!sql}>
                Insert into editor
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-[var(--wb-text-2)]">{label}</span>
      {children}
    </div>
  );
}

function parseDim(literal: string): number | null {
  // pgvector renders as `[1,2,3]`. Count commas + 1.
  const inside = literal.match(/^\s*\[([^\]]*)\]/);
  if (!inside) return null;
  const body = inside[1].trim();
  if (!body) return 0;
  return body.split(',').length;
}
