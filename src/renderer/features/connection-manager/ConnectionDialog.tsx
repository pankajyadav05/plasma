import { useState } from 'react';
import { Play } from 'lucide-react';
import type { ConnectionConfig } from '@shared/protocol';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSession } from '@/stores/session';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; message: string }
  | { kind: 'fail'; message: string };

function freshId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function freshConfig(): ConnectionConfig {
  return {
    id: freshId(),
    name: 'localhost',
    host: 'localhost',
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: '',
    ssl: false,
  };
}

export function ConnectionDialog() {
  const open = useSession((s) => s.dialogOpen);
  const connectionState = useSession((s) => s.connectionState);
  const connectionError = useSession((s) => s.connectionError);
  const connect = useSession((s) => s.connect);
  const testConnection = useSession((s) => s.testConnection);
  const closeDialog = useSession((s) => s.closeDialog);
  const disconnect = useSession((s) => s.disconnect);
  const activeConfig = useSession((s) => s.activeConfig);
  const dialogPrefill = useSession((s) => s.dialogPrefill);

  // The form is seeded from `dialogPrefill` only. When the user clicks
  // "+" in the sidebar, `openDialog()` is called with no args → prefill
  // is null → form starts fresh (even if a connection is already active).
  // Edit mode is entered exclusively via `editConnection(id)` which
  // fetches the full decrypted config and passes it as the prefill.
  const [form, setForm] = useState<ConnectionConfig>(
    () => dialogPrefill ?? freshConfig(),
  );
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  const isEditing = Boolean(dialogPrefill);
  // `activeConfig` drives whether the "disconnect" link is visible,
  // separately from edit/new mode.
  const showDisconnect = Boolean(activeConfig && isEditing && activeConfig.id === dialogPrefill?.id);

  const update = <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) => {
    setForm({ ...form, [key]: value });
    setTest({ kind: 'idle' });
  };

  const handleTest = async () => {
    setTest({ kind: 'testing' });
    const res = await testConnection(form);
    setTest(
      res.ok ? { kind: 'ok', message: res.message } : { kind: 'fail', message: res.message },
    );
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    await connect(form);
  };

  const connecting = connectionState === 'connecting';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeDialog()}>
      <DialogContent>
        <form onSubmit={handleConnect}>
          <DialogHeader>
            <DialogTitle>{isEditing ? 'Edit connection' : 'New connection'}</DialogTitle>
            <DialogDescription>
              {isEditing
                ? 'Update credentials or reconnect. Password will be re-encrypted.'
                : "Enter your Postgres details — they'll be saved to the OS keychain."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5 px-8 py-6">
            <Field label="Name" htmlFor="conn-name">
              <Input
                id="conn-name"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                placeholder="My database"
              />
            </Field>

            <div className="grid grid-cols-[1fr_120px] gap-4">
              <Field label="Host" htmlFor="conn-host">
                <Input
                  id="conn-host"
                  value={form.host}
                  onChange={(e) => update('host', e.target.value)}
                  placeholder="localhost"
                />
              </Field>
              <Field label="Port" htmlFor="conn-port">
                <Input
                  id="conn-port"
                  value={String(form.port)}
                  onChange={(e) => update('port', Number(e.target.value) || 0)}
                  placeholder="5432"
                  inputMode="numeric"
                />
              </Field>
            </div>

            <Field label="Database" htmlFor="conn-db">
              <Input
                id="conn-db"
                value={form.database}
                onChange={(e) => update('database', e.target.value)}
                placeholder="postgres"
              />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="User" htmlFor="conn-user">
                <Input
                  id="conn-user"
                  value={form.user}
                  onChange={(e) => update('user', e.target.value)}
                  placeholder="postgres"
                />
              </Field>
              <Field label="Password" htmlFor="conn-password">
                <Input
                  id="conn-password"
                  type="password"
                  value={form.password}
                  onChange={(e) => update('password', e.target.value)}
                  placeholder="•••••••"
                />
              </Field>
            </div>

            <div className="flex items-center gap-3">
              <Checkbox
                id="conn-ssl"
                checked={form.ssl}
                onCheckedChange={(v) => update('ssl', Boolean(v))}
              />
              <label
                htmlFor="conn-ssl"
                className="cursor-pointer font-display text-base italic text-ink"
              >
                Use SSL
              </label>
              <span className="font-display text-sm italic text-ink-muted">
                — rejectUnauthorized: false, for dev
              </span>
            </div>

            {test.kind === 'ok' && (
              <div className="border-l-[3px] border-type-str bg-[var(--bg-hover)] px-4 py-2 font-mono text-sm text-ink">
                ✓ {test.message}
              </div>
            )}
            {test.kind === 'fail' && (
              <div className="border-l-[3px] border-accent bg-[var(--bg-hover)] px-4 py-2 font-mono text-sm text-ink">
                ✗ {test.message}
              </div>
            )}
            {connectionError && connectionState === 'error' && (
              <div className="border-l-[3px] border-accent bg-[var(--bg-hover)] px-4 py-2 font-mono text-sm text-ink">
                ✗ {connectionError}
              </div>
            )}
          </div>

          <DialogFooter>
            {showDisconnect && (
              <Button
                type="button"
                variant="link"
                size="default"
                onClick={() => void disconnect()}
                className="mr-auto"
              >
                disconnect
              </Button>
            )}
            <Button type="button" variant="secondary" size="default" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="default"
              onClick={() => void handleTest()}
              disabled={test.kind === 'testing' || connecting}
            >
              {test.kind === 'testing' ? 'Testing…' : 'Test'}
            </Button>
            <Button type="submit" variant="primary" size="lg" disabled={connecting}>
              <Play className="fill-accent text-accent" />
              {connecting ? 'Connecting…' : 'Connect'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
