import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { kbd } from '@/lib/platform';
import { useActiveTab, useSession } from '@/stores/session';
import { Play, Square } from 'lucide-react';
import { useEffect } from 'react';
import { MonacoEditor } from './MonacoEditor';

/**
 * Full-canvas SQL editor. Layout: a small toolbar (tab title + Run),
 * then Monaco. When `expanded` is true the editor takes all remaining
 * space — used for SQL tabs that haven't run yet, so the user is
 * dropped straight into the editor without a "home" panel below. When
 * `expanded` is false the editor caps at 40% so the result grid below
 * has room.
 */
export function SqlCanvas({ expanded = false }: { expanded?: boolean }) {
  const tab = useActiveTab();
  const setSql = useSession((s) => s.setSql);
  const runQuery = useSession((s) => s.runQuery);
  const cancelQuery = useSession((s) => s.cancelQuery);
  const refreshTable = useSession((s) => s.refreshTable);
  const connectionState = useSession((s) => s.connectionState);
  const formatActiveSql = useSession((s) => s.formatActiveSql);
  const setRightPanelMode = useSession((s) => s.setRightPanelMode);
  const aiAsk = useSession((s) => s.aiAsk);
  const recallPreviousHistory = useSession((s) => s.recallPreviousHistory);
  const theme = useSession((s) => s.settings.theme);
  const fontSize = useSession((s) => s.settings.editorFontSize);
  const editorHeightPx = useSession((s) => s.settings.editorHeightPx);

  // If the right-rail query panel is open, close it — Monaco is now
  // rendered inline here and the side pane would be a duplicate. Other
  // right-rail panes (AI, Saved, Role, RLS) stay untouched so users can
  // keep them open alongside the inline editor.
  const rightPanelMode = useSession((s) => s.rightPanelMode);
  useEffect(() => {
    if (rightPanelMode === 'query') setRightPanelMode(null);
  }, [rightPanelMode, setRightPanelMode]);

  if (!tab) return null;

  const isTable = tab.kind === 'table';
  const canRun = connectionState === 'connected' && (isTable || tab.sql.trim().length > 0);
  const running = tab.queryRunState === 'running';

  const handleAction = () => {
    if (running) void cancelQuery();
    else if (isTable) void refreshTable();
    else void runQuery();
  };

  return (
    <div
      className={
        expanded
          ? 'flex min-h-0 flex-1 flex-col bg-background'
          : 'flex shrink-0 flex-col bg-background'
      }
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <span className="font-display text-sm italic text-muted-foreground">{tab.title}</span>
        {isTable && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs uppercase text-muted-foreground">
            table — read-only
          </span>
        )}
        <div className="flex-1" />
        {running ? (
          <Button variant="destructive" size="sm" onClick={handleAction}>
            <Square className="fill-current" />
            Cancel
            <Kbd className="border-0 bg-transparent text-destructive-foreground/80">{kbd('.')}</Kbd>
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={handleAction} disabled={!canRun}>
            <Play className="fill-current" />
            Run
            <Kbd className="border-0 bg-transparent text-primary-foreground/80">{kbd('⏎')}</Kbd>
          </Button>
        )}
      </div>

      <div
        className={
          expanded
            ? 'relative min-h-0 flex-1 border-b border-border'
            : 'relative shrink-0 border-b border-border'
        }
        style={expanded ? undefined : { height: `${editorHeightPx}px`, minHeight: 120 }}
      >
        <MonacoEditor
          value={tab.sql}
          onChange={isTable ? () => {} : setSql}
          onRun={handleAction}
          onToggle={() => {}}
          theme={theme}
          fontSize={fontSize}
          readOnly={isTable}
          onFormat={isTable ? undefined : () => void formatActiveSql()}
          onAskAi={
            isTable
              ? undefined
              : (text) => {
                  setRightPanelMode('ai');
                  const seed = text.trim()
                    ? `Explain or improve this SQL:\n\n\`\`\`sql\n${text}\n\`\`\``
                    : '';
                  if (seed) void aiAsk(seed);
                }
          }
          onRecallPrevious={isTable ? undefined : () => void recallPreviousHistory()}
        />
      </div>
    </div>
  );
}
