import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppShell } from '@/features/app-shell/AppShell';
import { useSession } from '@/stores/session';
import { useEffect } from 'react';

export function App() {
  useEffect(() => {
    void (async () => {
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
      window.plasmaEvents.on(
        'plasma:menu:runQueryAll',
        () => void session().runQuery({ all: true }),
      ),
      window.plasmaEvents.on('plasma:menu:cancelQuery', () => void session().cancelQuery()),
      window.plasmaEvents.on('plasma:menu:history', () => {
        session().setHistoryOpen(true);
        void session().loadHistory();
      }),
      window.plasmaEvents.on('plasma:menu:exportCsv', () => exportEvent('csv')),
      window.plasmaEvents.on('plasma:menu:exportJson', () => exportEvent('json')),
      // AI streaming deltas. Cast on receipt — preload sends raw IPC
      // payloads typed as unknown[] through the generic on() facade.
      window.plasmaEvents.on('plasma:ai:event', (...args: unknown[]) => {
        const evt = args[0] as Parameters<
          ReturnType<typeof useSession.getState>['aiApplyEvent']
        >[0];
        session().aiApplyEvent(evt);
      }),
      // U26: stream Postgres NOTICE / RAISE NOTICE into the origin tab.
      window.plasmaEvents.on('plasma:pg:notice', (...args: unknown[]) => {
        const notice = args[0] as Parameters<
          ReturnType<typeof useSession.getState>['appendPgNotice']
        >[0];
        session().appendPgNotice(notice);
      }),
    ];
    return () => {
      for (const fn of unsub) fn();
    };
  }, []);

  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}

// Dispatch a DOM custom event so the PaginationBar (which owns the
// export UI) can respond without a direct store coupling.
function exportEvent(kind: 'csv' | 'json') {
  window.dispatchEvent(new CustomEvent('plasma:export', { detail: { kind } }));
}
