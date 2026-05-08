import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useSession } from '@/stores/session';

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

  return (
    <ConfirmDialog
      open={Boolean(gate)}
      onOpenChange={(o) => {
        if (!o) cancelProdGate();
      }}
      title="Run destructive query on production?"
      description={
        <span>
          You're about to run a destructive statement on{' '}
          <span className="font-mono font-semibold text-destructive">
            {activeConfig?.name ?? 'this connection'}
          </span>{' '}
          (tagged <span className="text-destructive">prod</span>). This may delete or rewrite data.
          Verify your <code>WHERE</code> clause first.
        </span>
      }
      confirmLabel="Run anyway"
      cancelLabel="Cancel"
      variant="destructive"
      onConfirm={confirmProdGate}
    />
  );
}
