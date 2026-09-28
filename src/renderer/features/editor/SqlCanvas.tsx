import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ExplainDialog } from '@/features/explain/ExplainDialog';
import { kbd } from '@/lib/platform';
import { useActiveTab, useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import { ChevronDown, Gauge, ListOrdered, Play, Sparkles, Square, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MonacoEditor } from './MonacoEditor';

/**
 * Full-canvas SQL editor. Monaco fills the pane; a slim action bar along
 * its bottom edge carries the caret position on the left and Beautify /
 * Ask AI / Run on the right (the TablePlus "editor settings strip"
 * layout — the tab title already lives in the TabStrip above, so there
 * is no header row). When `expanded` is true the editor takes all
 * remaining space — used for SQL tabs that haven't run yet. When false
 * it keeps the user-sized height so the result grid below has room.
 */
export function SqlCanvas({ expanded = false }: { expanded?: boolean }) {
  const tab = useActiveTab();
  const setSql = useSession((s) => s.setSql);
  const runQuery = useSession((s) => s.runQuery);
  const cancelQuery = useSession((s) => s.cancelQuery);
  const refreshTable = useSession((s) => s.refreshTable);
  const formatActiveSql = useSession((s) => s.formatActiveSql);
  const setRightPanelMode = useSession((s) => s.setRightPanelMode);
  const aiAsk = useSession((s) => s.aiAsk);
  const theme = useSession((s) => s.settings.theme);
  const fontSize = useSession((s) => s.settings.editorFontSize);
  const editorHeightPx = useSession((s) => s.settings.editorHeightPx);
  const setEditorCursor = useWorkbench((s) => s.setEditorCursor);
  const [explainOpen, setExplainOpen] = useState(false);

  // If the right-rail query panel is open, close it — Monaco is now
  // rendered inline here and the side pane would be a duplicate. Other
  // right-rail panes (Details, Assistant, Role, RLS) stay untouched.
  const rightPanelMode = useSession((s) => s.rightPanelMode);
  useEffect(() => {
    if (rightPanelMode === 'query') setRightPanelMode(null);
  }, [rightPanelMode, setRightPanelMode]);

  // The caret readout belongs to this editor only — clear it on unmount
  // so a stale "Ln 40" never lingers after switching to a table tab.
  useEffect(() => () => setEditorCursor(null), [setEditorCursor]);

  if (!tab) return null;

  const isTable = tab.kind === 'table';

  const handleAction = () => {
    if (tab.queryRunState === 'running') void cancelQuery();
    else if (isTable) void refreshTable();
    else void runQuery(); // smart: selection, else statement at cursor
  };

  const handleRunAll = () => {
    if (tab.queryRunState === 'running' || isTable) return;
    void runQuery({ all: true });
  };

  const askAi = (text: string) => {
    setRightPanelMode('ai');
    const seed = text.trim() ? `Explain or improve this SQL:\n\n\`\`\`sql\n${text}\n\`\`\`` : '';
    if (seed) void aiAsk(seed);
  };

  return (
    <div
      className={
        expanded
          ? 'flex min-h-0 flex-1 flex-col bg-background'
          : 'flex shrink-0 flex-col bg-background'
      }
    >
      <div
        className={expanded ? 'relative min-h-0 flex-1' : 'relative shrink-0'}
        style={expanded ? undefined : { height: `${editorHeightPx}px`, minHeight: 120 }}
      >
        <MonacoEditor
          value={tab.sql}
          onChange={isTable ? () => {} : setSql}
          onRun={handleAction}
          onRunAll={handleRunAll}
          onToggle={() => {}}
          runningRange={tab.queryRunningRange}
          errorRange={tab.queryErrorRange}
          errorMessage={tab.queryError}
          theme={theme}
          fontSize={fontSize}
          readOnly={isTable}
          onFormat={isTable ? undefined : () => void formatActiveSql()}
          onAskAi={isTable ? undefined : askAi}
          onCursorChange={setEditorCursor}
        />
      </div>

      <EditorActionBar
        isTable={isTable}
        onRun={handleAction}
        onRunAll={handleRunAll}
        onExplain={() => setExplainOpen(true)}
        onAskAi={() => askAi(tab.sql)}
      />

      {!isTable && <ExplainDialog open={explainOpen} onOpenChange={setExplainOpen} sql={tab.sql} />}
    </div>
  );
}

/**
 * Bottom strip of the SQL editor:
 *
 *   Ln 12, Col 4 · 34 selected          [Beautify] [Ask AI] [▶ Run current | ▾]
 *
 * The Run split-button's menu holds the whole-buffer and EXPLAIN
 * variants so the primary action stays a single, predictable click.
 */
function EditorActionBar({
  isTable,
  onRun,
  onRunAll,
  onExplain,
  onAskAi,
}: {
  isTable: boolean;
  onRun: () => void;
  onRunAll: () => void;
  onExplain: () => void;
  onAskAi: () => void;
}) {
  const tab = useActiveTab();
  const connectionState = useSession((s) => s.connectionState);
  const formatActiveSql = useSession((s) => s.formatActiveSql);
  const cursor = useWorkbench((s) => s.editorCursor);
  const [menuOpen, setMenuOpen] = useState(false);

  if (!tab) return null;

  const running = tab.queryRunState === 'running';
  const hasSql = tab.sql.trim().length > 0;
  const canRun = connectionState === 'connected' && (isTable || hasSql);

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1.5 border-y border-border bg-sidebar px-2"
      data-testid="editor-action-bar"
    >
      <span className="px-1 font-mono text-[11px] tabular-nums text-muted-foreground">
        {cursor ? `Ln ${cursor.line}, Col ${cursor.column}` : '—'}
        {cursor && cursor.selectionLength > 0 && (
          <span className="text-foreground">
            {' '}
            · {cursor.selectionLength.toLocaleString()} selected
          </span>
        )}
      </span>
      {isTable && (
        <span className="font-display text-xs italic text-muted-foreground">
          compiled from the table browser — read-only
        </span>
      )}

      <div className="flex-1" />

      {!isTable && (
        <>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void formatActiveSql()}
            disabled={!hasSql}
            title={`Beautify SQL (${kbd('⇧F')})`}
          >
            <Wand2 />
            Beautify
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={onAskAi}
            title={`Ask the assistant about this SQL (${kbd('I')})`}
          >
            <Sparkles />
            Ask AI
          </Button>
        </>
      )}

      {running ? (
        <Button variant="destructive" size="xs" onClick={onRun}>
          <Square className="fill-current" />
          Cancel
          <Kbd className="border-0 bg-transparent text-destructive-foreground/80">{kbd('.')}</Kbd>
        </Button>
      ) : (
        <div className="flex items-stretch">
          <Button
            variant="primary"
            size="xs"
            onClick={onRun}
            disabled={!canRun}
            className="rounded-r-none"
            title={
              isTable
                ? 'Refresh the table query'
                : `Run the selection, or the statement at the caret (${kbd('⏎')})`
            }
          >
            <Play className="fill-current" />
            {isTable ? 'Refresh' : 'Run current'}
            <Kbd className="border-0 bg-transparent text-primary-foreground/80">{kbd('⏎')}</Kbd>
          </Button>
          {!isTable && (
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="primary"
                  size="xs"
                  disabled={!canRun}
                  className="rounded-l-none border-l border-primary-foreground/20 px-1.5"
                  aria-label="More run options"
                  title="More run options"
                >
                  <ChevronDown />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" side="top" sideOffset={6} className="w-[240px] p-1">
                <RunMenuItem
                  icon={<Play className="h-3.5 w-3.5" />}
                  label="Run current"
                  hint={kbd('⏎')}
                  onClick={() => {
                    setMenuOpen(false);
                    onRun();
                  }}
                />
                <RunMenuItem
                  icon={<ListOrdered className="h-3.5 w-3.5" />}
                  label="Run all statements"
                  hint={kbd('⇧⏎')}
                  onClick={() => {
                    setMenuOpen(false);
                    onRunAll();
                  }}
                />
                <div className="my-1 h-px bg-border" />
                <RunMenuItem
                  icon={<Gauge className="h-3.5 w-3.5" />}
                  label="Explain analyze…"
                  hint="runs for real"
                  onClick={() => {
                    setMenuOpen(false);
                    onExplain();
                  }}
                />
              </PopoverContent>
            </Popover>
          )}
        </div>
      )}
    </div>
  );
}

function RunMenuItem({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1">{label}</span>
      <span className="font-mono text-[10px] text-muted-foreground">{hint}</span>
    </button>
  );
}
