import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppShell } from '@/features/app-shell/AppShell';
import { useReconnect } from '@/stores/reconnect';
import { useSession } from '@/stores/session';
import { ConnectionRecovered } from '@shared/protocol';
import { useEffect } from 'react';

export function App() {
  useEffect(() => {
    void (async () => {
      const session = useSession.getState();
      await session.loadSettings();
      await session.loadSavedConnections();

      const { savedConnections, connectionState, settings } = useSession.getState();
      if (savedConnections.length === 0 && connectionState === 'idle') {
        session.openDialog();
        return;
      }
      // Auto-connect to the connection used last time (skipped after an
      // explicit disconnect, which clears lastConnectionId).
      const last = savedConnections.find((c) => c.id === settings.lastConnectionId);
      if (settings.autoConnectOnLaunch && last && connectionState === 'idle') {
        useReconnect.getState().start({ id: last.id, name: last.name }, 'launch');
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
      // U20: the worker died and came back with no DB session — stop
      // claiming to be connected so the user gets the connect screen.
      window.plasmaEvents.on('plasma:worker:reset', () => {
        // Remember what we were connected to before the reset forgets it,
        // then retry with backoff (or wait for a click if auto is off).
        const prev = session().activeConfig;
        session().handleWorkerReset();
        if (prev?.id && session().savedConnections.some((c) => c.id === prev.id)) {
          useReconnect.getState().start({ id: prev.id, name: prev.name }, 'lost');
        }
      }),
      // U27: main rebuilt the session after a network/VPN drop. Adopt the
      // new connection generation so edit + result guards stay honest.
      window.plasmaEvents.on('plasma:conn:recovered', (...args: unknown[]) => {
        const parsed = ConnectionRecovered.safeParse(args[0]);
        if (parsed.success) session().handleConnectionRecovered(parsed.data);
      }),
    ];
    // Network back (Wi-Fi, VPN, wake from sleep) → retry right away
    // instead of waiting out the backoff.
    const onOnline = () => {
      const r = useReconnect.getState();
      if (r.target && (r.phase === 'waiting' || r.phase === 'failed')) void r.reconnectNow();
    };
    window.addEventListener('online', onOnline);
    return () => {
      for (const fn of unsub) fn();
      window.removeEventListener('online', onOnline);
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
