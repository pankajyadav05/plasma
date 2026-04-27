import { useEffect } from 'react';
import { Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { kbd } from '@/lib/platform';
import { useActiveTab, useSession } from '@/stores/session';
import { MonacoEditor } from './MonacoEditor';

/**
 * Full-canvas SQL editor. Replaces the grid view when the IconRail
 * SQL Editor mode is active. Layout: TabStrip on top (already rendered
 * by AppShell), then Monaco filling the upper half, then result grid +
 * pagination below.
 */
export function SqlCanvas() {
  const tab = useActiveTab();
  const setSql = useSession((s) => s.setSql);
  const runQuery = useSession((s) => s.runQuery);
  const cancelQuery = useSession((s) => s.cancelQuery);
  const refreshTable = useSession((s) => s.refreshTable);
  const connectionState = useSession((s) => s.connectionState);
  const theme = useSession((s) => s.settings.theme);
  const fontSize = useSession((s) => s.settings.editorFontSize);

  // Force the EditorPane closed in SQL canvas — we render Monaco inline
  // here instead, and the side pane would be redundant.
  const setEditorExpanded = useSession((s) => s.setEditorExpanded);
  useEffect(() => {
    setEditorExpanded(false);
  }, [setEditorExpanded]);

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
    <div className="flex min-h-0 flex-1 flex-col bg-background">
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

      <div className="relative h-[40%] min-h-[140px] shrink-0 border-b border-border">
        <MonacoEditor
          value={tab.sql}
          onChange={isTable ? () => {} : setSql}
          onRun={handleAction}
          onToggle={() => {}}
          theme={theme}
          fontSize={fontSize}
          readOnly={isTable}
        />
      </div>
    </div>
  );
}
