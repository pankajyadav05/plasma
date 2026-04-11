import { AlertCircle, Loader2 } from "lucide-react";
import type { AppMeta } from "@shared/protocol";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useActiveTab, useSession } from "@/stores/session";

interface StatusBarProps {
  meta: AppMeta | null;
}

export function StatusBar({ meta }: StatusBarProps) {
  const tab = useActiveTab();
  const activeConfig = useSession((s) => s.activeConfig);
  const connectionState = useSession((s) => s.connectionState);
  const serverVersion = useSession((s) => s.serverVersion);
  const txnState = useSession((s) => s.txnState);
  const beginTxn = useSession((s) => s.beginTxn);
  const commitTxn = useSession((s) => s.commitTxn);
  const rollbackTxn = useSession((s) => s.rollbackTxn);

  const stateLabel =
    connectionState === "connected"
      ? "connected"
      : connectionState === "connecting"
        ? "connecting…"
        : connectionState === "error"
          ? "error"
          : "disconnected";

  const dotClass =
    connectionState === "connected"
      ? "bg-accent"
      : connectionState === "connecting"
        ? "bg-type-json animate-pulse"
        : connectionState === "error"
          ? "bg-accent"
          : "bg-ink-disabled";

  return (
    <footer
      className="flex h-7 shrink-0 items-center gap-0 border-t-2 border-border-strong bg-paper px-5 font-mono text-sm text-ink-2"
      style={{ letterSpacing: "0.02em" }}
    >
      <Seg first>
        <span className={`inline-block h-2 w-2 rounded-none ${dotClass}`} />
        {stateLabel}
      </Seg>
      {activeConfig && (
        <>
          <Sep />
          <Seg>{activeConfig.name}</Seg>
          <Sep />
          <Seg>{activeConfig.database}</Seg>
        </>
      )}
      {tab?.queryResult && !tab.queryError && (
        <>
          <Sep />
          <Seg>{tab.queryResult.rowCount.toLocaleString()} rows</Seg>
          <Sep />
          <Seg>{tab.queryResult.durationMs} ms</Seg>
        </>
      )}
      {tab?.queryError && (
        <>
          <Sep />
          <Seg>
            <AlertCircle className="h-3 w-3 text-accent" />
            <span className="text-accent">query error</span>
          </Seg>
        </>
      )}
      {tab?.queryRunState === "running" && (
        <>
          <Sep />
          <Seg>
            <Loader2 className="h-3 w-3 animate-spin text-accent" />
            <span className="text-accent">running…</span>
          </Seg>
        </>
      )}

      {activeConfig && (
        <>
          <Sep />
          {txnState === "active" ? (
            <Seg>
              <span className="text-accent">txn active</span>
              <Button variant="ghost" size="xs" onClick={() => void commitTxn()} className="ml-1.5 h-5">
                commit
              </Button>
              <Button variant="ghost" size="xs" onClick={() => void rollbackTxn()} className="h-5">
                rollback
              </Button>
            </Seg>
          ) : (
            <Seg>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void beginTxn()}
                className="h-5 text-ink-muted"
                title="Begin transaction"
              >
                txn idle
              </Button>
            </Seg>
          )}
        </>
      )}

      <div className="flex-1" />
      {serverVersion && (
        <>
          <Seg>{shortVersion(serverVersion)}</Seg>
          {/* <Sep /> */}
        </>
      )}
    </footer>
  );
}

function Seg({ children, first = false }: { children: React.ReactNode; first?: boolean }) {
  return <div className={`flex items-center gap-1.5 ${first ? "pl-0 pr-3" : "px-3"}`}>{children}</div>;
}

function Sep() {
  return <Separator orientation="vertical" className="h-3" />;
}

function shortVersion(full: string): string {
  const m = full.match(/^(PostgreSQL\s+[\d.]+)/);
  return m ? m[1] : full;
}
