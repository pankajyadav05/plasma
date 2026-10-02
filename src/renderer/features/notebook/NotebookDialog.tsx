import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { pickDisplayResult, runStatements } from '@/lib/run-statements';
import { useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import type { QueryResult } from '@shared/protocol';
import {
  BookText,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileCode,
  Hash,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownView } from './MarkdownView';
import {
  type NotebookCellKind,
  type StoredCell,
  hasCellContent,
  loadDraft,
  saveDraft,
} from './notebook-storage';

type CellKind = NotebookCellKind;

interface Cell extends StoredCell {
  result?: QueryResult;
  /** Statements in the cell's last run (a multi-statement cell shows its last result). */
  statements?: number;
  error?: string;
  running?: boolean;
  /** Markdown cells: rendered (true) or the raw text editor (false). */
  preview?: boolean;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function loadCells(connectionId: string | undefined): Cell[] {
  const s = storage();
  // Saved notes open rendered; new empty ones open in the editor.
  return s
    ? loadDraft(s, connectionId).map((c) => ({
        ...c,
        preview: c.kind === 'md' && c.content.trim().length > 0,
      }))
    : [];
}

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
 * the main editor). Cells persist in localStorage per connection so a
 * refresh doesn't lose work; "Export" emits a `.plasma.md` Markdown file
 * with frontmatter suitable for committing alongside the project.
 */
export function NotebookDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const activeConfig = useSession((s) => s.activeConfig);
  const connectionId = useSession((s) => s.activeConfig?.id);
  // The draft remembers which connection it was loaded for, so a
  // connection switch never writes the old cells under the new key.
  const [draft, setDraft] = useState<{ connectionId: string | undefined; cells: Cell[] }>(() => ({
    connectionId,
    cells: loadCells(connectionId),
  }));
  const cells = draft.cells;
  const contentRef = useRef<HTMLDivElement>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // R-09: a safe-mode refusal is shown on the cell instead of doing nothing.

  const setCells = useCallback((fn: (prev: Cell[]) => Cell[]) => {
    setDraft((d) => ({ ...d, cells: fn(d.cells) }));
  }, []);

  useEffect(() => {
    if (draft.connectionId === connectionId) return;
    setDraft({ connectionId, cells: loadCells(connectionId) });
  }, [connectionId, draft.connectionId]);

  useEffect(() => {
    if (!open) return;
    const s = storage();
    if (s) saveDraft(s, draft.connectionId, draft.cells);
  }, [draft, open]);

  const hasContent = hasCellContent(cells);

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
    // A7: notebook SQL goes through the same prod-tag / safe-mode gate as
    // the editor (read-only connections are enforced by the server).
    const outcome = await useSession.getState().confirmUserSqlDetailed(cell.content);
    if (!outcome.ok) {
      if (outcome.reason === 'refused') updateCell(id, { error: outcome.message });
      return;
    }
    updateCell(id, { running: true, error: undefined, result: undefined, statements: undefined });
    // R-12: same pipeline as the editor — statement splitting, unsupported
    // statement check, the editor's row limit, stop if the connection changes.
    const startGen = useSession.getState().connectionGen;
    const out = await runStatements(cell.content, {
      rowLimit: useWorkbench.getState().rowLimit,
      run: (sql, maxRows) =>
        maxRows === undefined ? ipc.query.run(sql) : ipc.query.run(sql, undefined, { maxRows }),
      shouldStop: () => useSession.getState().connectionGen !== startGen,
    });
    const last = out.results[out.results.length - 1];
    if (last?.txnState && useSession.getState().connectionGen === startGen) {
      useSession.setState({ txnState: last.txnState });
    }
    const tag =
      out.error && out.error.total > 1
        ? ` (statement ${out.error.statementIndex + 1} of ${out.error.total})`
        : '';
    updateCell(id, {
      running: false,
      result: pickDisplayResult(out.results),
      statements: out.results.length,
      error: out.error ? `${cleanIpcError(out.error.message)}${tag}` : undefined,
    });
  };

  /** "Open in a tab": the cell's SQL in a new editor tab, run there with the full grid. */
  const openInTab = (id: string) => {
    const cell = cells.find((c) => c.id === id);
    if (!cell || !cell.content.trim()) return;
    useSession.getState().openSqlInNewTab(cell.content);
    onOpenChange(false);
    void useSession.getState().runQuery({ all: true });
  };

  const exportMarkdown = () => {
    if (!hasContent) return;
    const md = cellsToMarkdown(cells, activeConfig?.name);
    void navigator.clipboard?.writeText(md);
  };

  const downloadMarkdown = () => {
    if (!hasContent) return;
    const md = cellsToMarkdown(cells, activeConfig?.name);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notebook-${Date.now()}.plasma.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // R-11: Clear wipes an auto-saved draft with no undo — always ask first.
  const clear = () => {
    if (cells.length === 0) return;
    setConfirmClear(true);
  };

  // F34: don't land focus (and a focus ring) on the Copy button. Focus the
  // first cell editor when there is one, otherwise the dialog itself.
  const onOpenAutoFocus = (e: Event) => {
    e.preventDefault();
    const root = contentRef.current;
    const first = root?.querySelector<HTMLTextAreaElement>('textarea');
    (first ?? root)?.focus({ preventScroll: true });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        hideClose
        onOpenAutoFocus={onOpenAutoFocus}
        className="h-[90vh] w-[92vw] max-w-none gap-0 p-0"
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] px-3">
            <BookText className="h-4 w-4 text-[var(--wb-text-2)]" aria-hidden />
            <DialogTitle>Notebook</DialogTitle>
            <span className="truncate text-[12px] text-[var(--wb-text-2)]">
              {activeConfig?.name ?? 'No connection'} · {cells.length} cell
              {cells.length === 1 ? '' : 's'}
            </span>
            <DialogDescription className="sr-only">
              Markdown and SQL cells run against the active connection. Drafts are saved per
              connection.
            </DialogDescription>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="xs"
              onClick={exportMarkdown}
              disabled={!hasContent}
              title="Copy as Markdown"
            >
              <Copy />
              Copy
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={downloadMarkdown}
              disabled={!hasContent}
              title="Download .plasma.md"
            >
              <Download />
              Save
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={clear}
              disabled={!hasContent}
              title="Clear all cells"
            >
              <Trash2 />
              Clear
            </Button>
            <DialogClose asChild>
              <IconButton label="Close notebook" variant="plain" className="ml-1">
                <X />
              </IconButton>
            </DialogClose>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {cells.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <BookText className="h-8 w-8 text-[var(--wb-text-3)]" aria-hidden />
                <div className="text-[13px] font-medium text-[var(--wb-text)]">
                  Start a notebook
                </div>
                <div className="text-[12px] text-[var(--wb-text-2)]">
                  Add a Markdown note or a SQL cell to begin.
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => addCell('md')}>
                    <Hash />
                    Markdown
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => addCell('sql')}>
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
                onOpenInTab={() => openInTab(cell.id)}
                onTogglePreview={() => updateCell(cell.id, { preview: !cell.preview })}
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
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={`Clear ${cells.length} cell${cells.length === 1 ? '' : 's'}?`}
        description="This removes every cell from the notebook for this connection. It cannot be undone."
        confirmLabel="Clear notebook"
        variant="destructive"
        onConfirm={() => {
          setCells(() => []);
          setConfirmClear(false);
        }}
      />
    </Dialog>
  );
}

function CellView({
  cell,
  index,
  total,
  onChange,
  onRun,
  onOpenInTab,
  onTogglePreview,
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
  onOpenInTab: () => void;
  onTogglePreview: () => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAddBelow: (kind: CellKind) => void;
}) {
  const isSql = cell.kind === 'sql';
  return (
    <div className="group/cell mb-3 overflow-hidden rounded-[8px] border border-[var(--wb-separator)] bg-[var(--wb-content)] focus-within:border-[var(--wb-accent)]">
      <div className="flex h-8 items-center gap-1.5 border-b border-[var(--wb-separator)] bg-[var(--wb-sidebar)] px-2 text-[12px] text-[var(--wb-text-2)]">
        <span className="rounded-[4px] bg-[var(--wb-control)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--wb-text-2)]">
          {isSql ? 'SQL' : 'Markdown'}
        </span>
        <span>Cell {index + 1}</span>
        <div className="flex-1" />
        {isSql && (
          <Button
            variant="secondary"
            size="xs"
            onClick={onRun}
            disabled={cell.running || !cell.content.trim()}
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
        {!isSql && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onTogglePreview}
            disabled={!cell.preview && !cell.content.trim()}
            title={cell.preview ? 'Edit this note' : 'Preview the rendered note'}
          >
            {cell.preview ? <Pencil /> : <Eye />}
            {cell.preview ? 'Edit' : 'Preview'}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onMoveUp}
          disabled={index === 0}
          title="Move up"
          aria-label="Move up"
        >
          <ChevronUp />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onMoveDown}
          disabled={index === total - 1}
          title="Move down"
          aria-label="Move down"
        >
          <ChevronDown />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onRemove}
          title="Remove cell"
          aria-label="Remove cell"
        >
          <Trash2 />
        </Button>
      </div>
      {!isSql && cell.preview ? (
        <MarkdownView source={cell.content} />
      ) : (
        <textarea
          value={cell.content}
          onChange={(e) => onChange(e.target.value)}
          rows={Math.max(3, Math.min(20, cell.content.split('\n').length + 1))}
          aria-label={`Cell ${index + 1} (${isSql ? 'SQL' : 'Markdown'})`}
          placeholder={
            isSql ? 'SELECT 1;' : '# Heading\n\nMarkdown: **bold**, *italic*, `code`, lists, links.'
          }
          className={cn(
            'block w-full resize-none border-0 bg-[var(--wb-content)] px-3 py-2 text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-text-3)]',
            isSql ? 'font-mono text-[12px]' : 'text-[13px] leading-relaxed',
          )}
        />
      )}
      {isSql && cell.error && (
        <div className="border-t border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[12px] text-destructive">
          {cell.error}
        </div>
      )}
      {isSql && cell.result && (
        <CellResult result={cell.result} statements={cell.statements} onOpenInTab={onOpenInTab} />
      )}
      <div className="flex items-center gap-1 border-t border-[var(--wb-separator)] px-2 py-1">
        <span className="text-[12px] text-[var(--wb-text-3)]">Add below</span>
        <Button variant="ghost" size="xs" onClick={() => onAddBelow('md')}>
          <Hash />
          Markdown
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onAddBelow('sql')}>
          <FileCode />
          SQL
        </Button>
      </div>
    </div>
  );
}

function CellResult({
  result,
  statements,
  onOpenInTab,
}: {
  result: QueryResult;
  statements?: number;
  onOpenInTab: () => void;
}) {
  const rows = result.rows.slice(0, 50);
  return (
    <div className="overflow-x-auto border-t border-[var(--wb-separator)] bg-[var(--wb-content)]">
      <table className="w-full font-mono text-[12px] text-[var(--wb-text)]">
        <thead className="sticky top-0 bg-[var(--wb-sidebar)]">
          <tr className="border-b border-[var(--wb-separator)] text-left text-[var(--wb-text-2)]">
            {result.columns.map((c) => (
              <th key={c.name} className="px-2 py-1 font-sans text-[12px] font-medium">
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
              className="border-b border-[var(--wb-separator)] even:bg-[var(--grid-row-a)]"
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
      {(result.rows.length > 50 || result.truncated || (statements ?? 1) > 1) && (
        <div className="flex items-center gap-2 border-t border-[var(--wb-separator)] bg-[var(--wb-sidebar)] px-2 py-1 text-[12px] text-[var(--wb-text-2)]">
          <span className="min-w-0 flex-1 truncate">
            {(statements ?? 1) > 1 ? `Last of ${statements} results. ` : ''}
            {result.rows.length > 50
              ? `Showing first 50 of ${result.rowCount.toLocaleString()} rows.`
              : result.truncated
                ? 'Result hit the row limit.'
                : ''}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={onOpenInTab}
            title="Run this cell in a new editor tab"
          >
            <ExternalLink />
            Open in a tab
          </Button>
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

function cellsToMarkdown(cells: Cell[], connection?: string): string {
  const lines: string[] = [
    '---',
    'format: plasma-notebook',
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
