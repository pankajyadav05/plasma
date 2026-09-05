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
import type { ConnectionConfig, ConnectionEngine } from '@shared/protocol';
import { Boxes, Database, Layers, Loader2, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; message: string }
  | { kind: 'fail'; message: string };

const ENGINE_DEFAULTS: Record<
  ConnectionEngine,
  { port: number; database: string; user: string; ssl: boolean }
> = {
  postgres: { port: 5432, database: 'postgres', user: 'postgres', ssl: false },
  redis: { port: 6379, database: '0', user: '', ssl: false },
  opensearch: { port: 9200, database: '', user: '', ssl: false },
};

const ENGINE_DISPLAY: Record<
  ConnectionEngine,
  { label: string; subtitle: string; icon: typeof Database }
> = {
  postgres: { label: 'Postgres', subtitle: 'Relational · SQL', icon: Database },
  redis: { label: 'Redis', subtitle: 'Key-value · cache', icon: Layers },
  opensearch: { label: 'OpenSearch', subtitle: 'Search · documents', icon: Boxes },
};

/**
 * Environment tag → theme-token class mapping. Sourced from the active
 * theme so light / dark / claude / cyberpunk all stay coherent. Order of
 * intensity (low → high): local · dev · staging · prod.
 */
const TAG_ACTIVE_CLASS = {
  local: 'bg-foreground text-background',
  dev: 'bg-secondary text-secondary-foreground',
  staging: 'bg-primary text-primary-foreground',
  prod: 'bg-destructive text-destructive-foreground',
} as const;

function freshId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function freshConfig(engine: ConnectionEngine = 'postgres'): ConnectionConfig {
  const d = ENGINE_DEFAULTS[engine];
  return {
    id: freshId(),
    name: 'localhost',
    engine,
    host: 'localhost',
    port: d.port,
    database: d.database,
    user: d.user,
    password: '',
    ssl: d.ssl,
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
  const requestDelete = useSession((s) => s.requestDeleteConnection);

  const [form, setForm] = useState<ConnectionConfig>(
    () => dialogPrefill ?? freshConfig('postgres'),
  );
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  const engine = (form.engine ?? 'postgres') as ConnectionEngine;
  const isEditing = Boolean(dialogPrefill);
  const setConnectionTag = useSession((s) => s.setConnectionTag);
  const initialTag = useSession((s) =>
    dialogPrefill ? s.settings.connectionTags?.[dialogPrefill.id] : undefined,
  );
  const [tag, setTag] = useState<'prod' | 'staging' | 'dev' | 'local' | null>(
    initialTag ?? null,
  );

  const initialSsh = useSession((s) =>
    dialogPrefill ? s.settings.connectionSsh?.[dialogPrefill.id] : undefined,
  );
  const updateSettings = useSession((s) => s.updateSettings);
  const allSsh = useSession((s) => s.settings.connectionSsh);
  const [useSsh, setUseSsh] = useState(Boolean(initialSsh));
  // Secrets are never returned by SettingsGet (U07). Empty fields mean
  // "keep the vault value" on save when has* flags are set.
  const [ssh, setSsh] = useState({
    host: initialSsh?.host ?? '',
    port: initialSsh?.port ?? 22,
    user: initialSsh?.user ?? '',
    password: '',
    privateKey: '',
    passphrase: '',
  });
  const sshHasPassword = Boolean(initialSsh?.hasPassword);
  const sshHasPrivateKey = Boolean(initialSsh?.hasPrivateKey);
  const sshHasPassphrase = Boolean(initialSsh?.hasPassphrase);
  const showDisconnect = Boolean(
    activeConfig && isEditing && activeConfig.id === dialogPrefill?.id,
  );

  const update = <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) => {
    setForm({ ...form, [key]: value });
    setTest({ kind: 'idle' });
  };

  const switchEngine = (next: ConnectionEngine) => {
    if (next === engine) return;
    const d = ENGINE_DEFAULTS[next];
    // Preserve id + name + host so the user doesn't lose their typed-in
    // values when flicking between Postgres/Redis/OS pickers.
    setForm({
      ...form,
      engine: next,
      port: d.port,
      database: d.database,
      user: form.user || d.user,
      ssl: d.ssl,
    });
    setTest({ kind: 'idle' });
  };

  const handleTest = async () => {
    setTest({ kind: 'testing' });
    const res = await testConnection(form);
    setTest(res.ok ? { kind: 'ok', message: res.message } : { kind: 'fail', message: res.message });
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    void setConnectionTag(form.id, tag);
    const nextSshMap = { ...(allSsh ?? {}) };
    // SSH tunnels make sense for postgres + redis (raw TCP). OpenSearch
    // is HTTPS — most clusters terminate TLS at a public endpoint, so
    // we hide the SSH section there to avoid the wrong-tool footgun.
    const sshSupported = engine !== 'opensearch';
    if (sshSupported && useSsh && ssh.host && ssh.user) {
      nextSshMap[form.id] = ssh;
    } else {
      delete nextSshMap[form.id];
    }
    await updateSettings({ connectionSsh: nextSshMap });
    await connect(form);
  };

  const connecting = connectionState === 'connecting';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeDialog()}>
      <DialogContent className="max-w-xl">
        <form onSubmit={handleConnect}>
          <DialogHeader>
            <DialogTitle>{isEditing ? 'Edit connection' : 'New connection'}</DialogTitle>
            <DialogDescription>
              {isEditing
                ? 'Update credentials or reconnect. Password will be re-encrypted.'
                : 'Pick an engine and enter connection details — passwords are stored in the OS keychain.'}
            </DialogDescription>
          </DialogHeader>

          {/* Engine picker */}
          <div className="grid grid-cols-3 gap-2 pt-4">
            {(Object.keys(ENGINE_DISPLAY) as ConnectionEngine[]).map((eng) => {
              const meta = ENGINE_DISPLAY[eng];
              const Icon = meta.icon;
              const selected = engine === eng;
              return (
                <button
                  key={eng}
                  type="button"
                  onClick={() => switchEngine(eng)}
                  disabled={isEditing}
                  className={
                    selected
                      ? 'flex flex-col items-start gap-0.5 rounded-md border border-foreground bg-muted/40 px-3 py-2 text-left text-foreground'
                      : 'flex cursor-pointer flex-col items-start gap-0.5 rounded-md border border-border bg-background px-3 py-2 text-left text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50'
                  }
                  aria-pressed={selected}
                >
                  <Icon className="h-4 w-4" />
                  <span className="text-sm font-semibold">{meta.label}</span>
                  <span className="font-display text-[11px] italic">{meta.subtitle}</span>
                </button>
              );
            })}
          </div>
          {isEditing && (
            <p className="pt-1 font-display text-[11px] italic text-muted-foreground">
              Engine is locked while editing. Delete and re-add to change engines.
            </p>
          )}

          <div className="grid gap-4 py-4">
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
                  placeholder={engine === 'opensearch' ? 'search.example.com' : 'localhost'}
                />
              </Field>
              <Field label="Port" htmlFor="conn-port">
                <Input
                  id="conn-port"
                  value={String(form.port)}
                  onChange={(e) => update('port', Number(e.target.value) || 0)}
                  placeholder={String(ENGINE_DEFAULTS[engine].port)}
                  inputMode="numeric"
                />
              </Field>
            </div>

            {/* Engine-specific data field */}
            {engine === 'postgres' && (
              <Field label="Database" htmlFor="conn-db">
                <Input
                  id="conn-db"
                  value={form.database}
                  onChange={(e) => update('database', e.target.value)}
                  placeholder="postgres"
                />
              </Field>
            )}
            {engine === 'redis' && (
              <Field label="DB index" htmlFor="conn-db">
                <Input
                  id="conn-db"
                  value={form.database}
                  onChange={(e) => update('database', e.target.value)}
                  placeholder="0"
                  inputMode="numeric"
                />
              </Field>
            )}

            {/* User + password */}
            <div className="grid grid-cols-2 gap-4">
              <Field
                label={engine === 'redis' ? 'ACL user (optional)' : 'User'}
                htmlFor="conn-user"
              >
                <Input
                  id="conn-user"
                  value={form.user}
                  onChange={(e) => update('user', e.target.value)}
                  placeholder={engine === 'redis' ? '(leave empty for default)' : 'admin'}
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

            {/* SSL / TLS / HTTPS toggle, label varies by engine */}
            <div className="flex items-center gap-3">
              <Checkbox
                id="conn-ssl"
                checked={form.ssl}
                onCheckedChange={(v) => update('ssl', Boolean(v))}
              />
              <label
                htmlFor="conn-ssl"
                className="cursor-pointer text-sm font-medium text-foreground"
              >
                {engine === 'postgres' && 'Use SSL'}
                {engine === 'redis' && 'Use TLS'}
                {engine === 'opensearch' && 'Use HTTPS'}
              </label>
              <span className="font-display text-xs italic text-muted-foreground">
                — rejectUnauthorized: false, for dev
              </span>
            </div>

            {/* SSH section: hidden for OpenSearch (HTTPS over public endpoints) */}
            {engine !== 'opensearch' && (
              <div className="flex flex-col gap-3 rounded-md border border-border p-3">
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="conn-ssh"
                    checked={useSsh}
                    onCheckedChange={(v) => setUseSsh(Boolean(v))}
                  />
                  <label
                    htmlFor="conn-ssh"
                    className="cursor-pointer text-sm font-medium text-foreground"
                  >
                    Connect over SSH tunnel
                  </label>
                </div>
                {useSsh && (
                  <div className="grid grid-cols-[1fr_120px] gap-3">
                    <Field label="SSH host" htmlFor="ssh-host">
                      <Input
                        id="ssh-host"
                        value={ssh.host}
                        onChange={(e) => setSsh((s) => ({ ...s, host: e.target.value }))}
                        placeholder="bastion.example.com"
                      />
                    </Field>
                    <Field label="SSH port" htmlFor="ssh-port">
                      <Input
                        id="ssh-port"
                        value={String(ssh.port)}
                        onChange={(e) =>
                          setSsh((s) => ({ ...s, port: Number(e.target.value) || 22 }))
                        }
                        placeholder="22"
                        inputMode="numeric"
                      />
                    </Field>
                    <Field label="SSH user" htmlFor="ssh-user">
                      <Input
                        id="ssh-user"
                        value={ssh.user}
                        onChange={(e) => setSsh((s) => ({ ...s, user: e.target.value }))}
                        placeholder="ubuntu"
                      />
                    </Field>
                    <Field label="SSH password" htmlFor="ssh-password">
                      <Input
                        id="ssh-password"
                        type="password"
                        value={ssh.password}
                        onChange={(e) => setSsh((s) => ({ ...s, password: e.target.value }))}
                        placeholder={
                          sshHasPassword ? '•••••• (saved — leave blank to keep)' : '(or use private key)'
                        }
                      />
                    </Field>
                    <div className="col-span-2">
                      <Field label="SSH private key (paste content; takes priority over password)">
                        <textarea
                          value={ssh.privateKey}
                          onChange={(e) => setSsh((s) => ({ ...s, privateKey: e.target.value }))}
                          rows={3}
                          className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[11px] text-foreground outline-none focus:border-primary"
                          placeholder={
                            sshHasPrivateKey
                              ? '(saved in OS keychain — paste a new key to replace)'
                              : '-----BEGIN OPENSSH PRIVATE KEY-----…'
                          }
                        />
                      </Field>
                    </div>
                    <Field label="Key passphrase" htmlFor="ssh-passphrase">
                      <Input
                        id="ssh-passphrase"
                        type="password"
                        value={ssh.passphrase}
                        onChange={(e) => setSsh((s) => ({ ...s, passphrase: e.target.value }))}
                        placeholder={
                          sshHasPassphrase ? '•••••• (saved — leave blank to keep)' : 'if key is encrypted'
                        }
                      />
                    </Field>
                  </div>
                )}
              </div>
            )}

            <Field label="Environment">
              <div className="flex flex-wrap items-center gap-2">
                {(['local', 'dev', 'staging', 'prod'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={tag === t}
                    onClick={() => setTag(tag === t ? null : t)}
                    className={
                      tag === t
                        ? `rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wider ${TAG_ACTIVE_CLASS[t]}`
                        : 'cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs uppercase tracking-wider text-muted-foreground hover:border-foreground hover:text-foreground'
                    }
                  >
                    {t}
                  </button>
                ))}
              </div>
              <p className="mt-1 font-display text-xs italic text-muted-foreground">
                "prod" tag colors the status bar red and gates DELETE / TRUNCATE / DROP behind a
                confirm dialog.
              </p>
            </Field>

            {test.kind === 'ok' && (
              <div className="rounded-md border-l-4 border-type-str bg-muted px-4 py-2 text-sm text-foreground">
                ✓ {test.message}
              </div>
            )}
            {test.kind === 'fail' && (
              <div className="rounded-md border-l-4 border-destructive bg-muted px-4 py-2 text-sm text-foreground">
                ✗ {test.message}
              </div>
            )}
            {connectionError && connectionState === 'error' && (
              <div className="rounded-md border-l-4 border-destructive bg-muted px-4 py-2 text-sm text-foreground">
                ✗ {connectionError}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            {isEditing && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  requestDelete(form.id);
                  closeDialog();
                }}
                className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
                title="Delete this saved connection"
              >
                <Trash2 />
                Delete
              </Button>
            )}
            {showDisconnect && (
              <Button type="button" variant="link" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            )}
            <Button type="button" variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleTest()}
              disabled={test.kind === 'testing' || connecting}
            >
              {test.kind === 'testing' && <Loader2 className="animate-spin" />}
              {test.kind === 'testing' ? 'Testing…' : 'Test'}
            </Button>
            <Button type="submit" variant="primary" disabled={connecting}>
              {connecting ? <Loader2 className="animate-spin" /> : <Play />}
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
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
