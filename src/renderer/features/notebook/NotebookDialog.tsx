import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { QueryResult } from '@shared/protocol';
import {
  BookText,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileCode,
  Hash,
  Loader2,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';

type CellKind = 'sql' | 'md';

interface Cell {
  id: string;
  kind: CellKind;
  content: string;
  result?: QueryResult;
  error?: string;
  running?: boolean;
}

const STORAGE_KEY = 'plasma:notebook:draft';

function freshId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Lightweight notebook view. Cells alternate between Markdown and SQL.
 * SQL cells run against the active connection (not the sideband — we
 * want history + transactions to mirror the user's expectations from
 * the main editor). Cells persist in localStorage so a refresh doesn't
 * lose work; "Export" emits a `.plasma.md` Markdown file with frontmatter
 * suitable for committing alongside the project.
 */
export function NotebookDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const activeConfig = useSession((s) => s.activeConfig);
  const [cells, setCells] = useState<Cell[]>(() => loadCells());

  useEffect(() => {
    if (!open) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cells.map(stripRuntime)));
    } catch {
      // Ignore quota / disabled storage — losing draft is acceptable.
    }
  }, [cells, open]);

  const addCell = (kind: CellKind, idx?: number) => {
    setCells((prev) => {
      const next = [...prev];
      const cell: Cell = { id: freshId(), kind, content: '' };
      if (idx === undefined) next.push(cell);
      else next.splice(idx + 1, 0, cell);
      return next;
    });
  };

  const updateCell = (id: string, patch: Partial<Cell>) => {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const removeCell = (id: string) => {
    setCells((prev) => prev.filter((c) => c.id !== id));
  };

  const moveCell = (id: string, delta: -1 | 1) => {
    setCells((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      const newIdx = idx + delta;
      if (idx === -1 || newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(idx, 1);
      next.splice(newIdx, 0, moved);
      return next;
    });
  };

  const runCell = async (id: string) => {
    const cell = cells.find((c) => c.id === id);
    if (!cell || cell.kind !== 'sql' || !cell.content.trim()) return;
    updateCell(id, { running: true, error: undefined, result: undefined });
    try {
      const result = await ipc.query.run(cell.content);
      updateCell(id, { running: false, result });
    } catch (err) {
      updateCell(id, {
        running: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const exportMarkdown = () => {
    const md = cellsToMarkdown(cells, activeConfig?.name);
    void navigator.clipboard?.writeText(md);
  };

  const downloadMarkdown = () => {
    const md = cellsToMarkdown(cells, activeConfig?.name);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notebook-${Date.now()}.plasma.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clear = () => {
    if (cells.length === 0) return;
    setCells([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // best-effort
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[90vh] w-[92vw] max-w-none p-0">
        <div className="flex h-full flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
            <BookText className="h-4 w-4 text-primary" />
            <span className="font-display text-sm italic text-foreground">Notebook</span>
            <span className="font-display text-xs italic text-muted-foreground">
              {activeConfig?.name ?? 'no connection'} · {cells.length} cell
              {cells.length === 1 ? '' : 's'}
            </span>
            <div className="flex-1" />
            <Button variant="ghost" size="xs" onClick={exportMarkdown} title="Copy as Markdown">
              <Copy />
              Copy
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={downloadMarkdown}
              title="Download .plasma.md"
            >
              <Download />
              Save
            </Button>
            <Button variant="ghost" size="xs" onClick={clear} title="Clear all cells">
              <Trash2 />
              Clear
            </Button>
            <Button variant="ghost" size="icon-xs" onClick={() => onOpenChange(false)}>
              <X />
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {cells.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <BookText className="h-8 w-8 text-muted-foreground" />
                <div className="font-display text-sm italic text-foreground">Start a notebook</div>
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" onClick={() => addCell('md')}>
                    <Hash />
                    Markdown
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => addCell('sql')}>
                    <FileCode />
                    SQL
                  </Button>
                </div>
              </div>
            )}
            {cells.map((cell, idx) => (
              <CellView
                key={cell.id}
                cell={cell}
                index={idx}
                total={cells.length}
                onChange={(content) => updateCell(cell.id, { content })}
                onRun={() => void runCell(cell.id)}
                onRemove={() => removeCell(cell.id)}
                onMoveUp={() => moveCell(cell.id, -1)}
                onMoveDown={() => moveCell(cell.id, 1)}
                onAddBelow={(kind) => addCell(kind, idx)}
              />
            ))}
            {cells.length > 0 && (
              <div className="mt-3 flex justify-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => addCell('md')}>
                  <Plus />
                  Markdown
                </Button>
                <Button variant="ghost" size="sm" onClick={() => addCell('sql')}>
                  <Plus />
                  SQL
                </Button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CellView({
  cell,
  index,
  total,
  onChange,
  onRun,
  onRemove,
  onMoveUp,
  onMoveDown,
  onAddBelow,
}: {
  cell: Cell;
  index: number;
  total: number;
  onChange: (s: string) => void;
  onRun: () => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAddBelow: (kind: CellKind) => void;
}) {
  const isSql = cell.kind === 'sql';
  return (
    <div className="group/cell mb-3 rounded-md border border-border bg-background">
      <div className="flex h-7 items-center gap-1.5 border-b border-border bg-muted/30 px-2 font-mono text-[10px] uppercase text-muted-foreground">
        <span
          className={
            isSql
              ? 'rounded-sm bg-primary px-1 py-0.5 text-[9px] text-primary-foreground'
              : 'rounded-sm bg-foreground/10 px-1 py-0.5 text-[9px]'
          }
        >
          {isSql ? 'sql' : 'md'}
        </span>
        <span>cell {index + 1}</span>
        <div className="flex-1" />
        {isSql && (
          <Button
            variant="primary"
            size="xs"
            className="h-5 px-1.5"
            onClick={onRun}
            disabled={cell.running}
            title="Run cell"
          >
            {cell.running ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Play className="fill-current" />
            )}
            Run
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onMoveUp}
          disabled={index === 0}
          title="Move up"
        >
          <ChevronUp />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onMoveDown}
          disabled={index === total - 1}
          title="Move down"
        >
          <ChevronDown />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={onRemove} title="Remove cell">
          <Trash2 />
        </Button>
      </div>
      <textarea
        value={cell.content}
        onChange={(e) => onChange(e.target.value)}
        rows={Math.max(3, Math.min(20, cell.content.split('\n').length + 1))}
        placeholder={
          isSql ? 'SELECT 1;' : '# Heading\n\nMarkdown text. Cell renders as plain text for now.'
        }
        className={cn(
          'w-full resize-none border-0 bg-background px-3 py-2 outline-none',
          isSql
            ? 'font-mono text-[12px] text-foreground'
            : 'font-display text-sm leading-relaxed text-foreground',
        )}
      />
      {isSql && cell.error && (
        <div className="border-t border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
          {cell.error}
        </div>
      )}
      {isSql && cell.result && <CellResult result={cell.result} />}
      <div className="flex items-center gap-1 border-t border-border/60 px-2 py-1">
        <span className="font-display text-[10px] italic text-muted-foreground">add below:</span>
        <Button variant="ghost" size="xs" className="h-5 px-1.5" onClick={() => onAddBelow('md')}>
          <Hash />
          md
        </Button>
        <Button variant="ghost" size="xs" className="h-5 px-1.5" onClick={() => onAddBelow('sql')}>
          <FileCode />
          sql
        </Button>
      </div>
    </div>
  );
}

function CellResult({ result }: { result: QueryResult }) {
  const rows = result.rows.slice(0, 50);
  return (
    <div className="overflow-x-auto border-t border-border bg-muted/20">
      <table className="w-full font-mono text-[11px]">
        <thead className="sticky top-0 bg-muted/40">
          <tr className="border-b border-border text-left text-muted-foreground">
            {result.columns.map((c) => (
              <th key={c.name} className="px-2 py-1 font-display italic">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: row identity comes from server order
              key={i}
              className="border-b border-border/60"
            >
              {row.map((v, j) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: column index is stable
                  key={j}
                  className="overflow-hidden truncate px-2 py-1"
                >
                  {fmtCell(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length > 50 && (
        <div className="border-t border-border bg-muted/40 px-2 py-1 font-display text-[11px] italic text-muted-foreground">
          showing first 50 of {result.rowCount.toLocaleString()} rows · open in a tab to see all
        </div>
      )}
    </div>
  );
}

function fmtCell(v: unknown): string {
  if (v === null) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function stripRuntime(c: Cell): Cell {
  return { id: c.id, kind: c.kind, content: c.content };
}

function loadCells(): Cell[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Cell[];
    return Array.isArray(parsed) ? parsed.map(stripRuntime) : [];
  } catch {
    return [];
  }
}

function cellsToMarkdown(cells: Cell[], connection?: string): string {
  const lines: string[] = [
    '---',
    `format: plasma-notebook`,
    `connection: ${connection ?? ''}`,
    `created: ${new Date().toISOString()}`,
    '---',
    '',
  ];
  for (const cell of cells) {
    if (cell.kind === 'md') {
      lines.push(cell.content);
      lines.push('');
    } else {
      lines.push('```sql');
      lines.push(cell.content);
      lines.push('```');
      lines.push('');
    }
  }
  return lines.join('\n');
}
