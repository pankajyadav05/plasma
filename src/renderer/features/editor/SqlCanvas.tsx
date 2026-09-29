import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MenuItem, Pill, PillChevron, SplitPill } from '@/components/ui/workbench';
import { ExplainDialog } from '@/features/explain/ExplainDialog';
import { kbd } from '@/lib/platform';
import { type RunMode, resolveRunTarget, statementPosition } from '@/lib/sql-split';
import { useActiveTab, useSession } from '@/stores/session';
import { ROW_LIMIT_CHOICES, useWorkbench } from '@/stores/workbench';
import {
  ChevronDown,
  Gauge,
  ListOrdered,
  Play,
  SlidersHorizontal,
  Sparkles,
  Square,
  TextSelect,
  Wand2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { MonacoEditor } from './MonacoEditor';

const MODEL_PREFIX = '/plasma-tab-';

/** Monaco model path for a SQL tab — one model per tab. */
function modelPathForTab(tabId: string): string {
  return `${MODEL_PREFIX}${tabId}.sql`;
}

function tabIdFromModelPath(path: string): string | null {
  if (!path.startsWith(MODEL_PREFIX) || !path.endsWith('.sql')) return null;
  return path.slice(MODEL_PREFIX.length, -'.sql'.length);
}

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
  const setCaret = useWorkbench((s) => s.setCaret);
  const tabIds = useSession((s) => s.tabs.map((t) => t.id).join('|'));
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

  // Each tab owns a Monaco model (see `path` below). Dispose models and
  // saved carets of tabs that have been closed.
  useEffect(() => {
    const open = new Set(tabIds.split('|'));
    const { carets, setCaret: drop } = useWorkbench.getState();
    for (const id of Object.keys(carets)) if (!open.has(id)) drop(id, null);
    void import('@monaco-editor/react')
      .then((m) => m.loader.init())
      .then((monaco) => {
        for (const model of monaco.editor.getModels()) {
          const id = tabIdFromModelPath(model.uri.path);
          if (id && !open.has(id)) model.dispose();
        }
      })
      .catch(() => {
        /* Monaco not loaded yet — nothing to clean up */
      });
  }, [tabIds]);

  if (!tab) return null;

  const isTable = tab.kind === 'table';

  const handleAction = () => {
    if (tab.queryRunState === 'running') void cancelQuery();
    else if (isTable) void refreshTable();
    else void runQuery(); // smart: selection, else statement at cursor
  };

  const run = (mode: RunMode) => {
    if (tab.queryRunState === 'running' || isTable) return;
    void runQuery({ mode });
  };

  const handleRunAll = () => run('buffer');

  // What Explain analyses: the same target Run Current would execute.
  const caret = useWorkbench.getState().carets[tab.id];
  const explainSql =
    resolveRunTarget(
      tab.sql,
      'smart',
      caret && caret.bufferLength === tab.sql.length ? caret : null,
    )?.sql ?? tab.sql;

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
          path={modelPathForTab(tab.id)}
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
          onCaret={(c) => setCaret(tab.id, c)}
          highlightCurrentStatement={!isTable}
        />
      </div>

      <EditorActionBar
        isTable={isTable}
        onRun={handleAction}
        onRunMode={run}
        onExplain={() => setExplainOpen(true)}
        onAskAi={() => askAi(tab.sql)}
      />

      {!isTable && explainOpen && (
        <ExplainDialog open={explainOpen} onOpenChange={setExplainOpen} sql={explainSql} />
      )}
    </div>
  );
}

/**
 * Bottom strip of the SQL editor (TablePlus layout):
 *
 *   line 12, column 4, location 318 · statement 2 of 3    [No limit ▾] [Beautify ▾] [▶ Run Current ⌘⏎ ▾]
 *
 * The primary button follows the editor: "Run Selected" while text is
 * selected, otherwise "Run Current" (the statement tinted in the editor).
 * Its menu holds every explicit variant. The row limit is enforced by the
 * worker's cursor read — the SQL itself is never rewritten.
 */
function EditorActionBar({
  isTable,
  onRun,
  onRunMode,
  onExplain,
  onAskAi,
}: {
  isTable: boolean;
  onRun: () => void;
  onRunMode: (mode: RunMode) => void;
  onExplain: () => void;
  onAskAi: () => void;
}) {
  const tab = useActiveTab();
  const connectionState = useSession((s) => s.connectionState);
  const formatActiveSql = useSession((s) => s.formatActiveSql);
  const cursor = useWorkbench((s) => s.editorCursor);
  const rowLimit = useWorkbench((s) => s.rowLimit);
  const setRowLimit = useWorkbench((s) => s.setRowLimit);
  const [runMenu, setRunMenu] = useState(false);
  const [beautifyMenu, setBeautifyMenu] = useState(false);
  const [limitMenu, setLimitMenu] = useState(false);

  if (!tab) return null;

  const running = tab.queryRunState === 'running';
  const hasSql = tab.sql.trim().length > 0;
  const canRun = connectionState === 'connected' && (isTable || hasSql);
  const hasSelection = Boolean(cursor && cursor.selectionLength > 0);
  const position = cursor && !isTable ? statementPosition(tab.sql, cursor.offset) : null;
  const primaryLabel = isTable ? 'Refresh' : hasSelection ? 'Run Selected' : 'Run Current';

  const pick = (mode: RunMode) => {
    setRunMenu(false);
    onRunMode(mode);
  };

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1.5 border-t border-[var(--wb-separator)] bg-[var(--wb-content)] px-2.5"
      data-testid="editor-action-bar"
    >
      <SlidersHorizontal
        className="h-4 w-4 shrink-0 text-[var(--wb-text-2)]"
        strokeWidth={1.5}
        aria-hidden
      />
      {hasSelection && cursor ? (
        <span className="shrink-0 font-mono text-[12px] tabular-nums text-[var(--wb-text)]">
          {cursor.selectionLength.toLocaleString()} selected
        </span>
      ) : position && position.total > 1 ? (
        <span
          className="shrink-0 font-mono text-[12px] tabular-nums text-[var(--wb-text)]"
          data-testid="current-statement"
        >
          statement {position.index} of {position.total}
        </span>
      ) : null}
      <span className="min-w-0 truncate font-mono text-[12px] tabular-nums text-[var(--wb-text-2)]">
        {(hasSelection || (position && position.total > 1)) && cursor ? '· ' : ''}
        {cursor
          ? `line ${cursor.line}, column ${cursor.column}, location ${cursor.offset}`
          : isTable
            ? 'compiled from the table browser — read-only'
            : ''}
      </span>

      <div className="flex-1" />

      {!isTable && (
        <>
          <Popover open={limitMenu} onOpenChange={setLimitMenu}>
            <PopoverTrigger asChild>
              <Pill title="Row limit for results — enforced while reading, SQL is not rewritten">
                {rowLimit === null ? 'No limit' : `Limit ${rowLimit.toLocaleString()}`}
                <ChevronDown className="!h-3.5 !w-3.5 opacity-70" />
              </Pill>
            </PopoverTrigger>
            <PopoverContent align="end" side="top" sideOffset={6} className="w-[180px] p-1" role="menu">
              {ROW_LIMIT_CHOICES.map((n) => (
                <MenuItem
                  key={String(n)}
                  label={n === null ? 'No limit' : `${n.toLocaleString()} rows`}
                  checked={rowLimit === n}
                  onClick={() => {
                    setRowLimit(n);
                    setLimitMenu(false);
                  }}
                />
              ))}
            </PopoverContent>
          </Popover>

          <SplitPill>
            <Pill onClick={() => void formatActiveSql()} disabled={!hasSql} title="Beautify SQL">
              Beautify
              <span className="font-mono text-[12px] opacity-70">{kbd('⇧F')}</span>
            </Pill>
            <Popover open={beautifyMenu} onOpenChange={setBeautifyMenu}>
              <PopoverTrigger asChild>
                <PillChevron aria-label="More editor actions" title="More editor actions" />
              </PopoverTrigger>
              <PopoverContent align="end" side="top" sideOffset={6} className="w-[230px] p-1" role="menu">
                <MenuItem
                  icon={<Wand2 />}
                  label="Beautify"
                  hint={kbd('⇧F')}
                  disabled={!hasSql}
                  onClick={() => {
                    setBeautifyMenu(false);
                    void formatActiveSql();
                  }}
                />
                <MenuItem
                  icon={<Sparkles />}
                  label="Ask AI about this SQL"
                  hint={kbd('I')}
                  onClick={() => {
                    setBeautifyMenu(false);
                    onAskAi();
                  }}
                />
              </PopoverContent>
            </Popover>
          </SplitPill>
        </>
      )}

      {running ? (
        <Pill onClick={onRun} className="bg-destructive text-white hover:bg-destructive/90">
          <Square className="fill-current" />
          Cancel
          <span className="font-mono text-[10px] opacity-75">{kbd('.')}</span>
        </Pill>
      ) : (
        <SplitPill>
          <Pill
            onClick={onRun}
            disabled={!canRun}
            data-testid="run-primary"
            title={
              isTable
                ? 'Refresh the table query'
                : hasSelection
                  ? `Run the selected text (${kbd('⏎')})`
                  : `Run the highlighted statement at the cursor (${kbd('⏎')})`
            }
          >
            {primaryLabel}
            <span className="font-mono text-[12px] opacity-70">{kbd('⏎')}</span>
          </Pill>
          {!isTable && (
            <Popover open={runMenu} onOpenChange={setRunMenu}>
              <PopoverTrigger asChild>
                <PillChevron
                  disabled={!canRun}
                  aria-label="More run options"
                  title="More run options"
                />
              </PopoverTrigger>
              <PopoverContent align="end" side="top" sideOffset={6} className="w-[260px] p-1" role="menu">
                <MenuItem
                  icon={<TextSelect />}
                  label="Run Selected"
                  hint={hasSelection ? kbd('⏎') : 'select text first'}
                  disabled={!hasSelection}
                  onClick={() => pick('selection')}
                />
                <MenuItem
                  icon={<Play />}
                  label={
                    position && position.total > 1
                      ? `Run Current (statement ${position.index})`
                      : 'Run Current'
                  }
                  hint={hasSelection ? undefined : kbd('⏎')}
                  onClick={() => pick('current')}
                />
                <MenuItem
                  icon={<ListOrdered />}
                  label={
                    position && position.total > 1
                      ? `Run All (${position.total} statements)`
                      : 'Run All'
                  }
                  hint={kbd('⇧⏎')}
                  onClick={() => pick('buffer')}
                />
                <div className="my-1 h-px bg-[var(--hairline)]" />
                <MenuItem
                  icon={<Gauge />}
                  label="Explain Analyze…"
                  hint="runs it"
                  onClick={() => {
                    setRunMenu(false);
                    onExplain();
                  }}
                />
              </PopoverContent>
            </Popover>
          )}
        </SplitPill>
      )}
    </div>
  );
}
