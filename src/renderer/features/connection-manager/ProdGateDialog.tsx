import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { statementsLabel } from '@/lib/safe-run';
import { effectiveSafeMode } from '@/stores/safe-mode';
import { useSession } from '@/stores/session';
import { CLICKHOUSE_MUTATION_WARNING, clickhouseMutation } from '@shared/clickhouse-mutation';
import { firstLine, planSafeRunScript } from '@shared/safe-run-script';
import { engineCaps } from '@shared/sql-dialect';

/**
 * Renders a confirm dialog when runQuery has stashed a destructive
 * statement against a prod-tagged connection. Mounted once in AppShell;
 * shows nothing while `prodGate` is null.
 */
export function ProdGateDialog() {
  const gate = useSession((s) => s.prodGate);
  const activeConfig = useSession((s) => s.activeConfig);
  const confirmProdGate = useSession((s) => s.confirmProdGate);
  const cancelProdGate = useSession((s) => s.cancelProdGate);
  const isCommit = gate?.kind === 'commitEdits';
  const safeMode = gate?.reason === 'safe-mode';
  const mutation =
    gate !== null &&
    engineCaps(activeConfig?.engine).asyncMutations &&
    clickhouseMutation(gate.sql) !== null;
  const readOnlyLevel = useSession(
    (s) => effectiveSafeMode(s.settings, s.activeConfig?.id) === 'read-only',
  );

  // A Safe Run script: list every statement, since one confirmation covers them all.
  const plan = gate?.safe ? planSafeRunScript(gate.sql) : null;
  const statements = plan?.ok && plan.statements.length > 1 ? plan.statements : null;

  return (
    <ConfirmDialog
      open={Boolean(gate)}
      details={
        statements && (
          <div data-testid="prod-gate-statements" className="text-[13px] text-[var(--wb-text-2)]">
            <p className="m-0 mb-1">
              This Safe Run has {statementsLabel(statements.length)}. They run in order in one
              transaction, and nothing is saved until you commit.
            </p>
            <ol className="m-0 max-h-40 list-none overflow-auto rounded-[6px] border border-[var(--wb-separator)] p-0">
              {statements.map((sql, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list
                  key={i}
                  className="flex gap-2 border-b border-[var(--wb-separator)] px-2 py-1 font-mono text-[12px] last:border-b-0"
                >
                  <span className="w-5 shrink-0 text-right tabular-nums text-[var(--wb-text-3)]">
                    {i + 1}
                  </span>
                  <span className="truncate" title={sql}>
                    {firstLine(sql)}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )
      }
      onOpenChange={(o) => {
        if (!o) cancelProdGate();
      }}
      title={
        mutation
          ? 'Run an asynchronous mutation?'
          : safeMode
            ? isCommit
              ? 'Commit changes?'
              : 'Run this statement?'
            : isCommit
              ? 'Commit changes to production?'
              : 'Run destructive query on production?'
      }
      description={
        mutation ? (
          <span>
            {CLICKHOUSE_MUTATION_WARNING} Running it on{' '}
            <span className="font-mono font-semibold">
              {activeConfig?.name ?? 'this connection'}
            </span>
            .
          </span>
        ) : safeMode && readOnlyLevel ? (
          <span>
            Safe mode is read-only on{' '}
            <span className="font-mono font-semibold">
              {activeConfig?.name ?? 'this connection'}
            </span>
            , and this statement calls a function Plasma can't verify is read-only. It may write.
          </span>
        ) : safeMode ? (
          <span>
            Safe mode is asking before this runs on{' '}
            <span className="font-mono font-semibold">
              {activeConfig?.name ?? 'this connection'}
            </span>
            . You can change the level in the connection's Advanced settings.
          </span>
        ) : isCommit ? (
          <span>
            You're about to write {gate?.summary ?? 'pending changes'} to{' '}
            <span className="font-mono font-semibold text-destructive">
              {activeConfig?.name ?? 'this connection'}
            </span>{' '}
            (tagged <span className="text-destructive">prod</span>) in one transaction.
          </span>
        ) : (
          <span>
            You're about to run a destructive statement on{' '}
            <span className="font-mono font-semibold text-destructive">
              {activeConfig?.name ?? 'this connection'}
            </span>{' '}
            (tagged <span className="text-destructive">prod</span>). This may delete or rewrite
            data. Verify your <code>WHERE</code> clause first.
          </span>
        )
      }
      confirmLabel={isCommit ? 'Commit' : safeMode ? 'Run' : 'Run anyway'}
      cancelLabel="Cancel"
      variant={safeMode ? 'primary' : 'destructive'}
      onConfirm={confirmProdGate}
    />
  );
}
