import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { formatDuration } from '@/lib/format';
import { kbd } from '@/lib/platform';
import { useActiveTab, useSession } from '@/stores/session';
import { AlertCircle, Loader2 } from 'lucide-react';
import { UpdateBadge } from './UpdateBadge';

/**
 * Bottom status line. Connection identity (name, engine, version, TLS,
 * environment tag) lives in the toolbar status capsule; this bar keeps
 * the live state — connection health, last result, running query, and
 * the open-transaction controls.
 */
export function StatusBar() {
  const tab = useActiveTab();
  const activeConfig = useSession((s) => s.activeConfig);
  const connectionState = useSession((s) => s.connectionState);
  const txnState = useSession((s) => s.txnState);
  const commitTxn = useSession((s) => s.commitTxn);
  const rollbackTxn = useSession((s) => s.rollbackTxn);

  const stateLabel =
    connectionState === 'connected'
      ? 'connected'
      : connectionState === 'connecting'
        ? 'connecting…'
        : connectionState === 'error'
          ? 'error'
          : 'disconnected';

  const dotClass =
    connectionState === 'connected'
      ? 'bg-primary'
      : connectionState === 'connecting'
        ? 'bg-primary animate-pulse'
        : connectionState === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground';

  return (
    <footer
      className="flex h-7 shrink-0 items-center gap-0 border-t bg-background px-4 text-xs text-muted-foreground"
      data-testid="status-bar"
    >
      <Seg first>
        <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} />
        <span data-testid="status-connection">{stateLabel}</span>
      </Seg>
      {tab?.queryResult && !tab.queryError && (
        <>
          <Sep />
          <Seg>
            {tab.queryResult.rowCount.toLocaleString()} rows
            {tab.queryResult.truncated ? ' (truncated)' : ''}
          </Seg>
          <Sep />
          <Seg>{formatDuration(tab.queryResult.durationMs)}</Seg>
        </>
      )}
      {tab?.queryError && (
        <>
          <Sep />
          <Seg>
            <AlertCircle className="h-3 w-3 text-destructive" />
            <span className="text-destructive">query error</span>
          </Seg>
        </>
      )}
      {tab?.queryRunState === 'running' && (
        <>
          <Sep />
          <Seg>
            <Loader2 className="h-3 w-3 animate-spin text-primary" />
            <span className="text-muted-foreground">running…</span>
          </Seg>
        </>
      )}

      {activeConfig && txnState === 'active' && (
        <>
          <Sep />
          <Seg>
            <span className="font-semibold text-primary" data-testid="status-txn">
              txn active
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void commitTxn()}
              className="ml-1.5 h-5"
            >
              commit
            </Button>
            <Button variant="ghost" size="xs" onClick={() => void rollbackTxn()} className="h-5">
              rollback
            </Button>
          </Seg>
        </>
      )}

      <div className="flex-1" />
      <UpdateBadge />
      <Seg>
        <span>{kbd('/')} shortcuts</span>
      </Seg>
    </footer>
  );
}

function Seg({ children, first = false }: { children: React.ReactNode; first?: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 ${first ? 'pl-0 pr-3' : 'px-3'}`}>{children}</div>
  );
}

function Sep() {
  return <Separator orientation="vertical" className="h-3" />;
}
