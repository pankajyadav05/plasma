import { useEffect, useState } from 'react';
import type { AppMeta } from '@shared/protocol';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { AppShell } from '@/features/app-shell/AppShell';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export function App() {
  const [meta, setMeta] = useState<AppMeta | null>(null);

  // App boot: fetch meta, load settings, load saved connections.
  // Only auto-open the dialog if there are no saved connections.
  useEffect(() => {
    void (async () => {
      try {
        const m = await ipc.app.meta();
        setMeta(m);
      } catch (err) {
        console.error('[plasma] app.meta failed', err);
      }

      const session = useSession.getState();
      await session.loadSettings();
      await session.loadSavedConnections();

      const { savedConnections, connectionState } = useSession.getState();
      if (savedConnections.length === 0 && connectionState === 'idle') {
        session.openDialog();
      }
    })();
  }, []);

  // Wire up native menu → renderer action events from the main process.
  useEffect(() => {
    const session = useSession.getState;
    const unsub = [
      window.plasmaEvents.on('plasma:menu:newTab', () => session().addTab()),
      window.plasmaEvents.on('plasma:menu:closeTab', () =>
        session().closeTab(session().activeTabId),
      ),
      window.plasmaEvents.on('plasma:menu:toggleSidebar', () => void session().toggleSidebar()),
      window.plasmaEvents.on('plasma:menu:toggleEditor', () => session().toggleEditor()),
      window.plasmaEvents.on('plasma:menu:palette', () => session().togglePalette()),
      window.plasmaEvents.on('plasma:menu:runQuery', () => void session().runQuery()),
      window.plasmaEvents.on('plasma:menu:cancelQuery', () => void session().cancelQuery()),
      window.plasmaEvents.on('plasma:menu:history', () => {
        session().setHistoryOpen(true);
        void session().loadHistory();
      }),
      window.plasmaEvents.on('plasma:menu:exportCsv', () => exportEvent('csv')),
      window.plasmaEvents.on('plasma:menu:exportJson', () => exportEvent('json')),
    ];
    return () => unsub.forEach((fn) => fn());
  }, []);

  return (
    <ErrorBoundary>
      <AppShell meta={meta} />
    </ErrorBoundary>
  );
}

// Dispatch a DOM custom event so the PaginationBar (which owns the
// export UI) can respond without a direct store coupling.
function exportEvent(kind: 'csv' | 'json') {
  window.dispatchEvent(new CustomEvent('plasma:export', { detail: { kind } }));
}
