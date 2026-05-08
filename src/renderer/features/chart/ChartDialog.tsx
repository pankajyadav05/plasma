import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/cn';
import type { QueryResult } from '@shared/protocol';
import { useEffect, useMemo, useState } from 'react';

type ChartKind = 'bar' | 'line' | 'area';

/**
 * Lightweight chart visualizer over the active query result. We
 * deliberately don't pull in Recharts — the goal here is "screenshot-able
 * preview", not a charting library. SVG, ~250 LOC, no dep.
 *
 * X axis: any column. Categorical strings are rendered as labels;
 * numeric / date columns are sorted ascending so trends read left-to-right.
 *
 * Y axes: one or more numeric columns. We auto-pick the first two
 * numeric columns on open so the user usually doesn't have to configure
 * anything before seeing a chart.
 */
export function ChartDialog({
  result,
  open,
  onOpenChange,
  defaultTitle,
}: {
  result: QueryResult | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultTitle?: string;
}) {
  const numericCols = useMemo(() => (result ? findNumericColumns(result) : []), [result]);

  const [kind, setKind] = useState<ChartKind>('bar');
  const [xCol, setXCol] = useState<string>('');
  const [yCols, setYCols] = useState<string[]>([]);

  // Auto-pick reasonable defaults on first open.
  useEffect(() => {
    if (!open || !result) return;
    if (yCols.length === 0 && numericCols.length > 0) {
      setYCols([numericCols[0]]);
    }
    if (!xCol && result.columns.length > 0) {
      // Prefer first non-numeric column for the X axis (categorical reads
      // better as bars). Fall back to the first column otherwise.
      const firstNonNumeric =
        result.columns.find((c) => !numericCols.includes(c.name))?.name ?? result.columns[0].name;
      setXCol(firstNonNumeric);
    }
  }, [open, result, numericCols, xCol, yCols.length]);

  if (!result) return null;

  const series = buildSeries(result, xCol, yCols);
  const empty = series.length === 0 || yCols.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{defaultTitle ?? 'Chart'}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Type">
            <Select value={kind} onValueChange={(v) => setKind(v as ChartKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bar">Bar</SelectItem>
                <SelectItem value="line">Line</SelectItem>
                <SelectItem value="area">Area</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="X axis">
            <Select value={xCol} onValueChange={setXCol}>
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {result.columns.map((c) => (
                  <SelectItem key={c.name} value={c.name}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Y axis">
            <YPicker numericCols={numericCols} selected={yCols} onChange={setYCols} />
          </Field>
        </div>

        <div className="mt-3 rounded-md border border-border bg-background p-3">
          {empty ? (
            <div className="flex h-[280px] items-center justify-center font-display text-sm italic text-muted-foreground">
              {numericCols.length === 0
                ? 'No numeric columns to plot.'
                : 'Pick at least one numeric Y column.'}
            </div>
          ) : (
            <ChartSvg kind={kind} series={series} yLabels={yCols} />
          )}
        </div>

        <div className="flex justify-end pt-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-display text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function YPicker({
  numericCols,
  selected,
  onChange,
}: {
  numericCols: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (col: string) => {
    onChange(selected.includes(col) ? selected.filter((c) => c !== col) : [...selected, col]);
  };
  return (
    <div className="flex max-h-9 min-h-9 items-center gap-1 overflow-x-auto rounded-md border border-input bg-background px-2 text-xs">
      {numericCols.length === 0 && <span className="text-muted-foreground">none</span>}
      {numericCols.map((c) => {
        const on = selected.includes(c);
        return (
          <button
            key={c}
            type="button"
            onClick={() => toggle(c)}
            className={cn(
              'shrink-0 rounded-sm px-1.5 py-0.5 font-mono transition-colors',
              on
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}

interface SeriesPoint {
  label: string;
  values: number[];
}

function buildSeries(result: QueryResult, xCol: string, yCols: string[]): SeriesPoint[] {
  if (!xCol || yCols.length === 0) return [];
  const xIdx = result.columns.findIndex((c) => c.name === xCol);
  const yIdxs = yCols.map((y) => result.columns.findIndex((c) => c.name === y));
  if (xIdx === -1 || yIdxs.some((i) => i === -1)) return [];

  const points: SeriesPoint[] = result.rows.map((row) => ({
    label: formatLabel(row[xIdx]),
    values: yIdxs.map((i) => coerceNum(row[i])),
  }));
  // Cap: charts get unreadable past a few hundred bars.
  return points.slice(0, 200);
}

function formatLabel(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return v.toString();
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function coerceNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'bigint') return Number(v);
  return 0;
}

function findNumericColumns(result: QueryResult): string[] {
  // Sample the first N rows and call a column numeric if every non-null
  // sample looks like a number. Cheaper than asking the driver for type
  // OIDs and works for queries with computed columns.
  const SAMPLE = Math.min(50, result.rows.length);
  const out: string[] = [];
  for (let c = 0; c < result.columns.length; c++) {
    let any = false;
    let allNumeric = true;
    for (let r = 0; r < SAMPLE; r++) {
      const v = result.rows[r][c];
      if (v === null || v === undefined) continue;
      any = true;
      if (typeof v === 'number' || typeof v === 'bigint') continue;
      if (typeof v === 'string' && Number.isFinite(Number(v))) continue;
      allNumeric = false;
      break;
    }
    if (any && allNumeric) out.push(result.columns[c].name);
  }
  return out;
}

const PALETTE = [
  'oklch(0.7122 0.1809 21.6630)',
  'oklch(0.6500 0.1500 240)',
  'oklch(0.6500 0.1500 145)',
  'oklch(0.6500 0.1500 80)',
  'oklch(0.6500 0.1500 305)',
];

function ChartSvg({
  kind,
  series,
  yLabels,
}: {
  kind: ChartKind;
  series: SeriesPoint[];
  yLabels: string[];
}) {
  const W = 720;
  const H = 280;
  const PAD = { top: 12, right: 16, bottom: 36, left: 48 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  // Find max across all series for shared Y axis.
  let max = 0;
  let min = 0;
  for (const p of series) {
    for (const v of p.values) {
      if (v > max) max = v;
      if (v < min) min = v;
    }
  }
  if (max === min) max = max + 1;

  const xStep = innerW / Math.max(1, series.length - (kind === 'bar' ? 0 : 1));
  const yScale = (v: number) => PAD.top + innerH - ((v - min) / (max - min)) * innerH;

  // Pick ~5 evenly spaced X labels — printing every label produces a
  // chunky band when there are 100+ rows.
  const labelEvery = Math.max(1, Math.floor(series.length / 8));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[280px] w-full" role="img" aria-label="Chart">
      <title>Chart</title>
      {/* Y axis ticks */}
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = PAD.top + innerH - t * innerH;
        const v = min + (max - min) * t;
        return (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y}
              y2={y}
              className="stroke-border"
              strokeDasharray={t === 0 ? '0' : '2 3'}
            />
            <text
              x={PAD.left - 6}
              y={y + 3}
              className="fill-muted-foreground"
              textAnchor="end"
              fontSize={10}
              fontFamily="ui-monospace,monospace"
            >
              {fmtNum(v)}
            </text>
          </g>
        );
      })}

      {/* Series */}
      {yLabels.map((label, sIdx) => {
        const color = PALETTE[sIdx % PALETTE.length];
        if (kind === 'bar') {
          const groupWidth = xStep / yLabels.length - 2;
          return (
            <g key={label}>
              {series.map((p, i) => {
                const v = p.values[sIdx] ?? 0;
                const x = PAD.left + i * xStep + sIdx * (groupWidth + 1);
                const y = yScale(Math.max(0, v));
                const h = Math.abs(yScale(0) - yScale(v));
                return (
                  <rect
                    // biome-ignore lint/suspicious/noArrayIndexKey: index represents the row
                    key={i}
                    x={x + 2}
                    y={y}
                    width={Math.max(1, groupWidth)}
                    height={Math.max(1, h)}
                    fill={color}
                    opacity={0.85}
                  />
                );
              })}
            </g>
          );
        }
        // line / area
        const path = series
          .map((p, i) => {
            const x = PAD.left + i * xStep;
            const y = yScale(p.values[sIdx] ?? 0);
            return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(' ');
        const areaPath =
          kind === 'area'
            ? `${path} L${(PAD.left + (series.length - 1) * xStep).toFixed(1)},${yScale(0).toFixed(1)} L${PAD.left.toFixed(1)},${yScale(0).toFixed(1)} Z`
            : '';
        return (
          <g key={label}>
            {kind === 'area' && <path d={areaPath} fill={color} opacity={0.18} />}
            <path d={path} fill="none" stroke={color} strokeWidth={1.6} />
          </g>
        );
      })}

      {/* X labels */}
      {series.map((p, i) => {
        if (i % labelEvery !== 0) return null;
        return (
          <text
            // biome-ignore lint/suspicious/noArrayIndexKey: label position is stable
            key={i}
            x={PAD.left + i * xStep + (kind === 'bar' ? xStep / 2 : 0)}
            y={H - 14}
            textAnchor="middle"
            className="fill-muted-foreground"
            fontSize={10}
            fontFamily="ui-monospace,monospace"
          >
            {truncate(p.label, 14)}
          </text>
        );
      })}

      {/* Legend */}
      <g transform={`translate(${PAD.left}, ${H - 4})`}>
        {yLabels.map((label, i) => (
          <g key={label} transform={`translate(${i * 110}, 0)`}>
            <rect x={0} y={-8} width={10} height={3} fill={PALETTE[i % PALETTE.length]} rx={1} />
            <text
              x={14}
              y={-4}
              className="fill-foreground"
              fontSize={10}
              fontFamily="ui-monospace,monospace"
            >
              {label}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (Number.isInteger(v)) return v.toString();
  return v.toFixed(2);
}
