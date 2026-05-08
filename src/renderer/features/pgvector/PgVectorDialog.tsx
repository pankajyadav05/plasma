import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useActiveTab, useSession } from '@/stores/session';
import type { QueryResult } from '@shared/protocol';
import { Brain, Check, Copy, Sigma } from 'lucide-react';
import { useMemo, useState } from 'react';

type Distance = 'cosine' | 'l2' | 'inner';
const OP_FOR: Record<Distance, string> = {
  cosine: '<=>',
  l2: '<->',
  inner: '<#>',
};

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
  const tab = useActiveTab();
  const setSql = useSession((s) => s.setSql);
  const addTab = useSession((s) => s.addTab);

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

  const [colName, setColName] = useState<string>(vectorCols[0]?.name ?? '');
  const [rowIdx, setRowIdx] = useState<number>(0);
  const [distance, setDistance] = useState<Distance>('cosine');
  const [limit, setLimit] = useState<number>(10);
  const [copied, setCopied] = useState(false);

  const anchor = useMemo(() => {
    if (!result || !colName) return '';
    const idx = result.columns.findIndex((c) => c.name === colName);
    if (idx === -1) return '';
    const v = result.rows[rowIdx]?.[idx];
    return typeof v === 'string' ? v : '';
  }, [result, colName, rowIdx]);

  const sql = useMemo(() => {
    if (!anchor || !colName) return '';
    const op = OP_FOR[distance];
    const target =
      tab?.kind === 'table' && tab.tableSchema && tab.tableName
        ? `"${tab.tableSchema}"."${tab.tableName}"`
        : '/* TODO: source table */ <table>';
    // Embed anchor as a literal — pg accepts the standard `[...]::vector` syntax.
    const literal = anchor.replace(/'/g, "''");
    return `SELECT *, "${colName}" ${op} '${literal}'::vector AS distance\nFROM ${target}\nORDER BY "${colName}" ${op} '${literal}'::vector\nLIMIT ${limit};`;
  }, [anchor, colName, distance, limit, tab]);

  const handleCopy = () => {
    if (!sql) return;
    void navigator.clipboard?.writeText(sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const insertIntoEditor = () => {
    if (!sql) return;
    if (tab?.kind === 'table') addTab();
    queueMicrotask(() => setSql(sql));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-primary" />
            pgvector
          </DialogTitle>
        </DialogHeader>

        {vectorCols.length === 0 ? (
          <div className="py-6 text-center font-display text-sm italic text-muted-foreground">
            No vector columns in this result.
          </div>
        ) : (
          <>
            <div className="rounded-md border border-border">
              <table className="w-full font-mono text-xs">
                <thead className="bg-muted/30">
                  <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-2 py-1.5">column</th>
                    <th className="px-2 py-1.5">type</th>
                    <th className="px-2 py-1.5">dimensions</th>
                  </tr>
                </thead>
                <tbody>
                  {vectorCols.map((c) => (
                    <tr key={c.name} className="border-b border-border/60 last:border-b-0">
                      <td className="px-2 py-1.5">{c.name}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{c.dataTypeName}</td>
                      <td className="px-2 py-1.5">
                        <span className="inline-flex items-center gap-1">
                          <Sigma className="h-3 w-3 text-muted-foreground" />
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
                  <SelectTrigger className="h-8 text-xs">
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
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cosine">cosine ({'<=>'})</SelectItem>
                    <SelectItem value="l2">L2 ({'<->'})</SelectItem>
                    <SelectItem value="inner">inner ({'<#>'})</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="LIMIT">
                <Input
                  type="number"
                  min={1}
                  max={1000}
                  value={limit}
                  onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 10))}
                />
              </Field>
            </div>

            <div className="rounded-md border border-border">
              <div className="flex items-center gap-2 border-b border-border px-2 py-1.5 font-display text-xs italic text-muted-foreground">
                <span>nearest-neighbor SQL</span>
                <div className="flex-1" />
                <Button variant="ghost" size="icon-xs" onClick={handleCopy}>
                  {copied ? <Check className="text-primary" /> : <Copy />}
                </Button>
              </div>
              <pre className="overflow-x-auto bg-muted/20 p-3 font-mono text-[11px] text-foreground">
                {sql || '-- pick an anchor row above'}
              </pre>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button variant="primary" size="sm" onClick={insertIntoEditor} disabled={!sql}>
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
      <span className="font-display text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
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
