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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Pill } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { describeConnectError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { SAFE_MODE_LABEL, SAFE_MODE_LEVELS, type SafeModeLevel } from '@/stores/safe-mode';
import { useSession } from '@/stores/session';
import { suggestReadOnlyForTag } from '@shared/connection-readonly';
import { formatConnectionUrl, parseConnectionUrl } from '@shared/connection-url';
import type {
  ConnectionConfig,
  ConnectionEngine,
  ConnectionSshConfig,
  OpenSearchOptions,
  TlsMode,
} from '@shared/protocol';
import { engineCaps } from '@shared/sql-dialect';
import {
  Boxes,
  Check,
  ChevronRight,
  Copy,
  Database,
  DatabaseZap,
  HardDrive,
  Layers,
  Link2,
  Loader2,
  Play,
  Save,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  type FormErrors,
  type FormField,
  REDIS_HOST_HINT,
  type SshFormState,
  TLS_MODE_LABEL,
  formTlsMode,
  hasErrors,
  redisEndpointKind,
  validateConnectionForm,
  withTlsMode,
} from './connection-form';
import { existingGroups } from './connection-groups';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; message: string }
  | { kind: 'fail'; message: string };

type EnvTag = 'prod' | 'staging' | 'dev' | 'local';

const ENGINE_DEFAULTS: Record<
  ConnectionEngine,
  { port: number; database: string; user: string; ssl: boolean }
> = {
  postgres: { port: 5432, database: 'postgres', user: 'postgres', ssl: false },
  redis: { port: 6379, database: '0', user: '', ssl: false },
  opensearch: { port: 9200, database: '', user: '', ssl: false },
  sqlite: { port: 1, database: '', user: '', ssl: false },
  mysql: { port: 3306, database: '', user: 'root', ssl: false },
};

const ENGINE_DISPLAY: Record<
  ConnectionEngine,
  { label: string; subtitle: string; icon: typeof Database }
> = {
  postgres: { label: 'Postgres', subtitle: 'Relational · SQL', icon: Database },
  redis: { label: 'Redis', subtitle: 'Key-value · cache', icon: Layers },
  opensearch: { label: 'OpenSearch', subtitle: 'Search · documents', icon: Boxes },
  sqlite: { label: 'SQLite', subtitle: 'Local file · SQL', icon: HardDrive },
  mysql: { label: 'MySQL', subtitle: 'MySQL · MariaDB', icon: DatabaseZap },
};

/**
 * V6: environment tags use the same `--status-*` colours as the status
 * capsule, so the pick previews what the top bar will show.
 */
const TAG_COLOR: Record<EnvTag, string> = {
  local: 'var(--status-local)',
  dev: 'var(--status-dev)',
  staging: 'var(--status-staging)',
  prod: 'var(--status-prod)',
};
const TAG_LABEL: Record<EnvTag, string> = {
  local: 'Local',
  dev: 'Dev',
  staging: 'Staging',
  prod: 'Prod',
};

const TLS_MODES: Exclude<TlsMode, 'insecure'>[] = [
  'disable',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
];

const SECTION = 'flex flex-col gap-3 rounded-[8px] bg-[var(--wb-sidebar)] p-3';

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
    readOnly: false,
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
  const [portText, setPortText] = useState(() => String(form.port));
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [errors, setErrors] = useState<FormErrors>({});
  /** The store's connect error belongs to the last submit; hide it once the user edits. */
  const [showConnectError, setShowConnectError] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlText, setUrlText] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const engine = (form.engine ?? 'postgres') as ConnectionEngine;
  const isEditing = Boolean(dialogPrefill);
  const setConnectionTag = useSession((s) => s.setConnectionTag);
  const initialTag = useSession((s) =>
    dialogPrefill ? s.settings.connectionTags?.[dialogPrefill.id] : undefined,
  );
  const [tag, setTag] = useState<EnvTag | null>(initialTag ?? null);

  const initialSsh = useSession((s) =>
    dialogPrefill ? s.settings.connectionSsh?.[dialogPrefill.id] : undefined,
  );
  const updateSettings = useSession((s) => s.updateSettings);
  const allSsh = useSession((s) => s.settings.connectionSsh);
  const [useSsh, setUseSsh] = useState(Boolean(initialSsh));
  const [ssh, setSsh] = useState<SshFormState>({
    host: initialSsh?.host ?? '',
    port: String(initialSsh?.port ?? 22),
    user: initialSsh?.user ?? '',
    password: initialSsh?.password ?? '',
    privateKey: initialSsh?.privateKey ?? '',
    passphrase: initialSsh?.passphrase ?? '',
    privateKeyPath: initialSsh?.privateKeyPath ?? '',
    useAgent: initialSsh?.useAgent ?? false,
  });
  const savedConnections = useSession((s) => s.savedConnections);
  const saveConnectionOnly = useSession((s) => s.saveConnectionOnly);
  const groupSuggestions = useMemo(() => existingGroups(savedConnections), [savedConnections]);
  const allSafeMode = useSession((s) => s.settings.connectionSafeMode);
  const defaultSafeMode = useSession((s) => s.settings.safeModeDefault);
  const allAlwaysSafeRun = useSession((s) => s.settings.connectionAlwaysSafeRun);
  // null = untouched: follows the tag (on for Prod).
  const [alwaysSafeRunChoice, setAlwaysSafeRunChoice] = useState<boolean | null>(
    () => (dialogPrefill ? allAlwaysSafeRun?.[dialogPrefill.id] : undefined) ?? null,
  );
  const [safeMode, setSafeMode] = useState<SafeModeLevel | 'default'>(
    () => (dialogPrefill ? allSafeMode?.[dialogPrefill.id] : undefined) ?? 'default',
  );
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      safeMode !== 'default' ||
      alwaysSafeRunChoice !== null ||
      Boolean(dialogPrefill?.bootstrapSql),
  );
  const showDisconnect = Boolean(
    activeConfig && isEditing && activeConfig.id === dialogPrefill?.id,
  );
  const sshSupported = engineCaps(engine).ssh && engine !== 'opensearch';
  const isFile = engine === 'sqlite';
  const tlsMode = formTlsMode(form);

  /** Anything the user edits invalidates the last test / errors for that field. */
  const touched = (fields: FormField[] = []) => {
    setTest({ kind: 'idle' });
    setShowConnectError(false);
    if (fields.length > 0) {
      setErrors((prev) => {
        const next = { ...prev };
        for (const f of fields) delete next[f];
        return next;
      });
    }
  };

  const update = <K extends keyof ConnectionConfig>(
    key: K,
    value: ConnectionConfig[K],
    field?: FormField,
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    touched(field ? [field] : []);
  };

  const updateSsh = (key: keyof SshFormState, value: string, field: FormField) => {
    setSsh((s) => ({ ...s, [key]: value }));
    touched([field]);
  };

  const updateOs = (patch: Partial<OpenSearchOptions>, field: FormField = 'osAuth') => {
    setForm((prev) => ({ ...prev, opensearch: { ...(prev.opensearch ?? {}), ...patch } }));
    touched([field]);
  };

  const updateTls = (key: 'caFile' | 'certFile' | 'keyFile', value: string) => {
    setForm((prev) => ({
      ...prev,
      tls: { mode: 'verify-full', ...(prev.tls ?? {}), [key]: value },
    }));
    touched(['tlsCert', 'tlsKey']);
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
      // Replace the previous engine's default user (e.g. Postgres's
      // "postgres") — Redis/OpenSearch reject it — but keep one the user typed.
      user: !form.user || form.user === ENGINE_DEFAULTS[engine].user ? d.user : form.user,
      ssl: d.ssl,
      tls: undefined,
    });
    setPortText(String(d.port));
    setErrors({});
    touched();
  };

  const currentConfig = (): ConnectionConfig => ({ ...form, port: Number(portText.trim()) || 0 });

  const validate = (): boolean => {
    const next = validateConnectionForm({
      config: form,
      portText,
      useSsh,
      ssh,
      savedSsh: initialSsh,
    });
    setErrors(next);
    return !hasErrors(next);
  };

  const sshPayload = (): ConnectionSshConfig | null =>
    sshSupported && useSsh && ssh.host && ssh.user
      ? {
          host: ssh.host.trim(),
          port: Number(ssh.port) || 22,
          user: ssh.user.trim(),
          password: ssh.password,
          privateKey: ssh.privateKey,
          passphrase: ssh.passphrase,
          privateKeyPath: (ssh.privateKeyPath ?? '').trim(),
          useAgent: ssh.useAgent === true,
        }
      : null;

  const handleTest = async () => {
    setShowConnectError(false);
    if (!validate()) {
      setTest({ kind: 'idle' });
      return;
    }
    setTest({ kind: 'testing' });
    const res = await testConnection(currentConfig(), sshPayload());
    setTest(res.ok ? { kind: 'ok', message: res.message } : { kind: 'fail', message: res.message });
  };

  /** Tag, SSH tunnel and safe-mode level live in settings, keyed by connection id. */
  const persistSideSettings = async () => {
    void setConnectionTag(form.id, tag);
    const nextSshMap = { ...(allSsh ?? {}) };
    // SSH tunnels make sense for postgres + redis (raw TCP). OpenSearch
    // is HTTPS — most clusters terminate TLS at a public endpoint, so
    // we hide the SSH section there to avoid the wrong-tool footgun.
    const tunnel = sshPayload();
    if (tunnel) nextSshMap[form.id] = tunnel;
    else delete nextSshMap[form.id];
    const nextSafe = { ...(allSafeMode ?? {}) };
    if (safeMode === 'default') delete nextSafe[form.id];
    else nextSafe[form.id] = safeMode;
    const nextSafeRun = { ...(allAlwaysSafeRun ?? {}) };
    if (alwaysSafeRunChoice === null) delete nextSafeRun[form.id];
    else nextSafeRun[form.id] = alwaysSafeRunChoice;
    await updateSettings({
      connectionSsh: nextSshMap,
      connectionSafeMode: nextSafe,
      connectionAlwaysSafeRun: nextSafeRun,
    });
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setTest({ kind: 'idle' });
    if (!validate()) return;
    await persistSideSettings();
    setShowConnectError(true);
    await connect(currentConfig());
  };

  /** C28: keep the connection without opening it. */
  const handleSave = async () => {
    setTest({ kind: 'idle' });
    if (!validate()) return;
    try {
      await persistSideSettings();
      await saveConnectionOnly(currentConfig());
      closeDialog();
    } catch (err) {
      setTest({ kind: 'fail', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const applyUrl = () => {
    try {
      const parsed = parseConnectionUrl(urlText);
      if (isEditing && parsed.engine !== engine) {
        throw new Error(
          `This is a ${ENGINE_DISPLAY[parsed.engine].label} URL; the connection is ${ENGINE_DISPLAY[engine].label}`,
        );
      }
      setForm((prev) => ({
        ...prev,
        ...parsed,
        // Keep a saved password when the URL carries none.
        password: parsed.password || prev.password,
        name: prev.name === 'localhost' || !prev.name.trim() ? parsed.host : prev.name,
      }));
      setPortText(String(parsed.port));
      setUrlOpen(false);
      setUrlText('');
      setUrlError(null);
      setErrors({});
      touched();
    } catch (err) {
      setUrlError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(formatConnectionUrl(currentConfig()));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (permissions); nothing useful to show.
    }
  };

  const pickSqlite = async (mode: 'open' | 'create') => {
    try {
      const path = await ipc.conn.pickSqliteFile(mode);
      if (!path) return;
      setForm((prev) => ({
        ...prev,
        database: path,
        host: 'local',
        port: 1,
        name:
          prev.name && prev.name !== 'localhost' ? prev.name : (path.split(/[\\/]/).pop() ?? path),
      }));
      touched(['database']);
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        database:
          err instanceof Error
            ? err.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
            : String(err),
      }));
    }
  };

  const pickFile = async (key: 'caFile' | 'certFile' | 'keyFile', title: string) => {
    const path = await ipc.conn.pickFile(title);
    if (path) updateTls(key, path);
  };

  const pickSshKeyFile = async () => {
    const path = await ipc.conn.pickFile('Choose an SSH private key');
    if (path) updateSsh('privateKeyPath', path, 'sshAuth');
  };

  const connecting = connectionState === 'connecting';
  const connectErrorVisible = showConnectError && connectionState === 'error' && connectionError;

  const tlsLabel = useMemo(
    () =>
      engine === 'postgres' || engine === 'mysql'
        ? 'SSL mode'
        : engine === 'redis'
          ? 'TLS'
          : 'HTTPS',
    [engine],
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeDialog()}>
      {/* F7: top-aligned, capped at 90vh, scrolling body, sticky footer. */}
      <DialogContent
        className="top-[5vh] flex max-h-[90vh] max-w-xl translate-y-0 flex-col gap-0 overflow-hidden p-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2"
        data-testid="connection-dialog"
      >
        <form onSubmit={handleConnect} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="shrink-0 px-5 pb-3 pt-5">
            <DialogTitle>{isEditing ? 'Edit connection' : 'New connection'}</DialogTitle>
            <DialogDescription>
              {isEditing
                ? 'Update details or reconnect. Leave secret fields blank to keep the saved ones.'
                : 'Pick an engine and enter connection details. Passwords are stored in the OS keychain.'}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
            {/* Engine picker */}
            <div className="grid grid-cols-3 gap-2" data-testid="engine-picker">
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
                    className={cn(
                      'flex flex-col items-start gap-0.5 rounded-[8px] px-3 py-2 text-left transition-colors',
                      selected
                        ? 'bg-[var(--wb-control)] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-text)]'
                        : 'cursor-pointer text-[var(--wb-text-2)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] hover:text-[var(--wb-text)] disabled:cursor-not-allowed disabled:opacity-50',
                    )}
                    aria-pressed={selected}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="text-[13px] font-semibold">{meta.label}</span>
                    <span className="text-[12px] text-[var(--wb-text-2)]">{meta.subtitle}</span>
                  </button>
                );
              })}
            </div>
            {isEditing && (
              <p className="pt-1 text-[12px] text-[var(--wb-text-2)]">
                Engine is locked while editing. Delete and re-add to change engines.
              </p>
            )}

            {/* C28: connection URL import / copy */}
            <div className="flex flex-wrap items-center gap-2 pt-3">
              <Pill onClick={() => setUrlOpen((o) => !o)} aria-expanded={urlOpen}>
                <Link2 />
                Import URL…
              </Pill>
              <Pill
                onClick={() => void copyUrl()}
                title="Copy a connection URL (without the password)"
              >
                {copied ? <Check /> : <Copy />}
                {copied ? 'Copied' : 'Copy URL'}
              </Pill>
            </div>
            {urlOpen && (
              <div className="flex flex-col gap-1.5 pt-2">
                <div className="flex gap-2">
                  <Input
                    aria-label="Connection URL"
                    value={urlText}
                    autoFocus
                    spellCheck={false}
                    aria-invalid={urlError ? true : undefined}
                    onChange={(e) => {
                      setUrlText(e.target.value);
                      setUrlError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        applyUrl();
                      }
                    }}
                    placeholder="postgres://user:password@host:5432/db?sslmode=require"
                    className="font-mono"
                  />
                  <Pill onClick={applyUrl} disabled={!urlText.trim()} className="h-[26px]">
                    Apply
                  </Pill>
                </div>
                {urlError && <FieldError id="conn-url-error">{urlError}</FieldError>}
              </div>
            )}

            <div className="grid gap-3 pt-4">
              <div className="grid grid-cols-[1fr_170px] gap-3">
                <Field label="Name" htmlFor="conn-name" error={errors.name}>
                  <Input
                    id="conn-name"
                    value={form.name}
                    aria-invalid={errors.name ? true : undefined}
                    onChange={(e) => update('name', e.target.value, 'name')}
                    placeholder="My database"
                  />
                </Field>
                <Field label="Folder (optional)" htmlFor="conn-group">
                  <Input
                    id="conn-group"
                    list="conn-group-options"
                    value={form.group ?? ''}
                    onChange={(e) => update('group', e.target.value || undefined)}
                    placeholder="e.g. Work"
                  />
                  <datalist id="conn-group-options">
                    {groupSuggestions.map((g) => (
                      <option key={g} value={g} />
                    ))}
                  </datalist>
                </Field>
              </div>

              {isFile && (
                <Field label="Database file" htmlFor="conn-file" error={errors.database}>
                  <div className="flex gap-2">
                    <Input
                      id="conn-file"
                      value={form.database}
                      readOnly
                      aria-invalid={errors.database ? true : undefined}
                      placeholder="No file chosen"
                      className="font-mono"
                    />
                    <Pill onClick={() => void pickSqlite('open')}>Open…</Pill>
                    <Pill onClick={() => void pickSqlite('create')}>New…</Pill>
                  </div>
                  <p className="pt-1 text-[12px] text-[var(--wb-text-2)]">
                    Turn on Read-only below to open the file without being able to change it.
                  </p>
                </Field>
              )}

              <div className="grid grid-cols-[1fr_120px] gap-3" hidden={isFile}>
                <Field label="Host" htmlFor="conn-host" error={errors.host}>
                  <Input
                    id="conn-host"
                    value={form.host}
                    aria-invalid={errors.host ? true : undefined}
                    onChange={(e) => update('host', e.target.value, 'host')}
                    placeholder={engine === 'opensearch' ? 'search.example.com' : 'localhost'}
                  />
                </Field>
                <Field label="Port" htmlFor="conn-port" error={errors.port}>
                  <Input
                    id="conn-port"
                    value={portText}
                    aria-invalid={errors.port ? true : undefined}
                    onChange={(e) => {
                      setPortText(e.target.value);
                      touched(['port']);
                    }}
                    placeholder={String(ENGINE_DEFAULTS[engine].port)}
                    inputMode="numeric"
                  />
                </Field>
              </div>

              {!isFile && engine === 'redis' && redisEndpointKind(form.host) !== 'tcp' && (
                <p className="-mt-1.5 text-[12px] text-[var(--wb-text-2)]">
                  {
                    REDIS_HOST_HINT[
                      redisEndpointKind(form.host) as Exclude<
                        ReturnType<typeof redisEndpointKind>,
                        'tcp'
                      >
                    ]
                  }
                </p>
              )}
              {engine === 'redis' && redisEndpointKind(form.host) === 'tcp' && (
                <p className="-mt-1.5 text-[12px] text-[var(--wb-text-3)]">
                  Host also accepts a unix socket path, sentinel://h1:26379,h2:26379/master or
                  cluster://h1:7000,h2:7001.
                </p>
              )}

              {/* Engine-specific data field */}
              {(engine === 'postgres' || engine === 'mysql') && (
                <Field label="Database" htmlFor="conn-db" error={errors.database}>
                  <Input
                    id="conn-db"
                    value={form.database}
                    onChange={(e) => update('database', e.target.value, 'database')}
                    placeholder={engine === 'mysql' ? '(optional)' : 'postgres'}
                  />
                </Field>
              )}
              {engine === 'redis' && (
                <Field label="DB index" htmlFor="conn-db" error={errors.database}>
                  <Input
                    id="conn-db"
                    value={form.database}
                    aria-invalid={errors.database ? true : undefined}
                    onChange={(e) => update('database', e.target.value, 'database')}
                    placeholder="0"
                    inputMode="numeric"
                  />
                </Field>
              )}

              {/* User + password (OpenSearch API-key / SigV4 auth doesn't use them) */}
              {!isFile &&
                (engine !== 'opensearch' || (form.opensearch?.auth ?? 'basic') === 'basic') && (
                  <div className="grid grid-cols-2 gap-3">
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
                        placeholder={isEditing ? 'Saved — leave blank to keep' : '•••••••'}
                      />
                    </Field>
                  </div>
                )}

              {/* C4/C9: TLS mode + CA / client certificate files */}
              {!isFile && (
                <div className={SECTION}>
                  <Field label={tlsLabel} htmlFor="conn-ssl">
                    <Select
                      value={tlsMode}
                      onValueChange={(v) => {
                        setForm((prev) => withTlsMode(prev, v as TlsMode));
                        touched(['tlsCert', 'tlsKey']);
                      }}
                    >
                      <SelectTrigger
                        id="conn-ssl"
                        aria-label={tlsLabel}
                        className="h-[26px] text-[13px]"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TLS_MODES.filter((m) => engine === 'postgres' || m !== 'prefer').map(
                          (m) => (
                            <SelectItem key={m} value={m} className="text-[13px]">
                              {TLS_MODE_LABEL[m]}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                  </Field>
                  {(tlsMode === 'prefer' || tlsMode === 'require') && (
                    <p className="text-[12px] text-[var(--wb-text-2)]">
                      Encrypted, but the server certificate is not checked. Not allowed for
                      connections tagged Prod.
                    </p>
                  )}
                  {tlsMode !== 'disable' && (
                    <div className="grid gap-2">
                      <FileField
                        label="CA certificate"
                        value={form.tls?.caFile ?? ''}
                        placeholder={
                          tlsMode === 'verify-ca' || tlsMode === 'verify-full'
                            ? 'System trust store'
                            : 'Optional'
                        }
                        onChange={(v) => updateTls('caFile', v)}
                        onBrowse={() => void pickFile('caFile', 'Choose a CA certificate')}
                      />
                      <FileField
                        label="Client certificate"
                        value={form.tls?.certFile ?? ''}
                        placeholder="Optional (mutual TLS)"
                        error={errors.tlsCert}
                        onChange={(v) => updateTls('certFile', v)}
                        onBrowse={() => void pickFile('certFile', 'Choose a client certificate')}
                      />
                      <FileField
                        label="Client key"
                        value={form.tls?.keyFile ?? ''}
                        placeholder="Optional (mutual TLS)"
                        error={errors.tlsKey}
                        onChange={(v) => updateTls('keyFile', v)}
                        onBrowse={() => void pickFile('keyFile', 'Choose a client key')}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* O12: OpenSearch auth, path prefix and extra nodes */}
              {engine === 'opensearch' && (
                <OpenSearchSection
                  options={form.opensearch ?? {}}
                  errors={errors}
                  onChange={updateOs}
                  isEditing={isEditing}
                />
              )}

              {/* SSH section: hidden for OpenSearch (HTTPS over public endpoints) */}
              {sshSupported && (
                <div className={SECTION}>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="conn-ssh"
                      checked={useSsh}
                      onCheckedChange={(v) => {
                        setUseSsh(Boolean(v));
                        touched(['sshHost', 'sshPort', 'sshUser', 'sshAuth']);
                      }}
                    />
                    <label
                      htmlFor="conn-ssh"
                      className="cursor-pointer text-[13px] text-[var(--wb-text)]"
                    >
                      Connect over SSH tunnel
                    </label>
                  </div>
                  {useSsh && errors.ssh && (
                    <FieldError id="ssh-unsupported">{errors.ssh}</FieldError>
                  )}
                  {useSsh && (
                    <div className="grid grid-cols-[1fr_120px] gap-3">
                      <Field label="SSH host" htmlFor="ssh-host" error={errors.sshHost}>
                        <Input
                          id="ssh-host"
                          value={ssh.host}
                          aria-invalid={errors.sshHost ? true : undefined}
                          onChange={(e) => updateSsh('host', e.target.value, 'sshHost')}
                          placeholder="bastion.example.com"
                        />
                      </Field>
                      <Field label="SSH port" htmlFor="ssh-port" error={errors.sshPort}>
                        <Input
                          id="ssh-port"
                          value={ssh.port}
                          aria-invalid={errors.sshPort ? true : undefined}
                          onChange={(e) => updateSsh('port', e.target.value, 'sshPort')}
                          placeholder="22"
                          inputMode="numeric"
                        />
                      </Field>
                      <Field label="SSH user" htmlFor="ssh-user" error={errors.sshUser}>
                        <Input
                          id="ssh-user"
                          value={ssh.user}
                          aria-invalid={errors.sshUser ? true : undefined}
                          onChange={(e) => updateSsh('user', e.target.value, 'sshUser')}
                          placeholder="ubuntu"
                        />
                      </Field>
                      <Field label="SSH password" htmlFor="ssh-password">
                        <Input
                          id="ssh-password"
                          type="password"
                          value={ssh.password}
                          onChange={(e) => updateSsh('password', e.target.value, 'sshAuth')}
                          placeholder={initialSsh?.hasPassword ? 'Saved' : 'Optional'}
                          title={
                            initialSsh?.hasPassword
                              ? 'A password is saved — leave blank to keep it'
                              : 'Optional: use a private key or the ssh-agent instead'
                          }
                        />
                      </Field>
                      <div className="col-span-2">
                        <Field
                          label="SSH private key (paste content; takes priority over password)"
                          htmlFor="ssh-key"
                          error={errors.sshAuth}
                        >
                          <textarea
                            id="ssh-key"
                            value={ssh.privateKey}
                            onChange={(e) => updateSsh('privateKey', e.target.value, 'sshAuth')}
                            rows={3}
                            aria-invalid={errors.sshAuth ? true : undefined}
                            className="rounded-[7px] bg-[var(--wb-field)] px-2 py-1.5 font-mono text-[11px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] outline-none placeholder:text-[var(--wb-text-3)] focus-visible:shadow-[inset_0_0_0_1px_var(--ring)] aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--destructive)]"
                            placeholder={
                              initialSsh?.hasPrivateKey
                                ? 'Saved key — leave blank to keep'
                                : '-----BEGIN OPENSSH PRIVATE KEY-----…'
                            }
                          />
                        </Field>
                      </div>
                      <div className="col-span-2">
                        <FileField
                          label="SSH key file"
                          value={ssh.privateKeyPath ?? ''}
                          placeholder="e.g. ~/.ssh/id_ed25519 (used when no key is pasted)"
                          onChange={(v) => updateSsh('privateKeyPath', v, 'sshAuth')}
                          onBrowse={() => void pickSshKeyFile()}
                        />
                      </div>
                      <div className="col-span-2 flex items-center gap-2">
                        <Checkbox
                          id="ssh-agent"
                          checked={ssh.useAgent === true}
                          onCheckedChange={(v) => {
                            setSsh((s) => ({ ...s, useAgent: Boolean(v) }));
                            touched(['sshAuth']);
                          }}
                        />
                        <label
                          htmlFor="ssh-agent"
                          className="cursor-pointer text-[13px] text-[var(--wb-text)]"
                        >
                          Use the ssh-agent (SSH_AUTH_SOCK)
                        </label>
                      </div>
                      <Field label="Key passphrase" htmlFor="ssh-passphrase">
                        <Input
                          id="ssh-passphrase"
                          type="password"
                          value={ssh.passphrase}
                          onChange={(e) => updateSsh('passphrase', e.target.value, 'sshAuth')}
                          placeholder={
                            initialSsh?.hasPassphrase ? 'Saved — leave blank to keep' : undefined
                          }
                        />
                      </Field>
                    </div>
                  )}
                </div>
              )}

              <Field label="Environment">
                <div className="flex flex-wrap items-center gap-2">
                  {(['local', 'dev', 'staging', 'prod'] as const).map((t) => {
                    const selected = tag === t;
                    return (
                      <button
                        key={t}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          const next = selected ? null : t;
                          setTag(next);
                          // Prod suggests read-only by default (U28). User can
                          // still uncheck the box after selecting prod.
                          if (suggestReadOnlyForTag(next) && !form.readOnly) {
                            setForm((prev) => ({ ...prev, readOnly: true }));
                          }
                          touched();
                        }}
                        style={selected ? { backgroundColor: TAG_COLOR[t] } : undefined}
                        className={cn(
                          'inline-flex h-6 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] transition-colors',
                          selected
                            ? 'font-medium text-white'
                            : 'cursor-pointer text-[var(--wb-text-2)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] hover:text-[var(--wb-text)]',
                        )}
                      >
                        {!selected && (
                          <span
                            aria-hidden
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: TAG_COLOR[t] }}
                          />
                        )}
                        {TAG_LABEL[t]}
                      </button>
                    );
                  })}
                  <span className="mx-1 h-4 w-px bg-[var(--wb-separator)]" aria-hidden />
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="conn-readonly"
                      checked={Boolean(form.readOnly)}
                      onCheckedChange={(v) => update('readOnly', Boolean(v))}
                    />
                    <label
                      htmlFor="conn-readonly"
                      className="cursor-pointer text-[13px] text-[var(--wb-text)]"
                    >
                      Read-only
                    </label>
                  </div>
                </div>
                <p className="mt-1 text-[12px] leading-snug text-[var(--wb-text-2)]">
                  Prod colours the status bar and asks before destructive SQL. Read-only is enforced
                  for every engine: Postgres sessions start with{' '}
                  <span className="font-mono">default_transaction_read_only</span>, and Redis /
                  OpenSearch writes are refused
                  {tag === 'prod' ? ' — suggested for prod' : ''}.
                </p>
              </Field>

              {/* C28 / safe mode: per-connection guard rails + bootstrap SQL */}
              <div className={SECTION}>
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((o) => !o)}
                  aria-expanded={advancedOpen}
                  className="flex cursor-pointer items-center gap-1.5 text-left text-[13px] font-medium text-[var(--wb-text)]"
                >
                  <ChevronRight
                    className={cn('h-3.5 w-3.5 transition-transform', advancedOpen && 'rotate-90')}
                  />
                  Advanced
                </button>
                {advancedOpen && (
                  <div className="grid gap-3">
                    <Field label="Safe mode" htmlFor="conn-safe-mode">
                      <Select
                        value={safeMode}
                        onValueChange={(v) => {
                          setSafeMode(v as SafeModeLevel | 'default');
                          touched();
                        }}
                      >
                        <SelectTrigger
                          id="conn-safe-mode"
                          aria-label="Safe mode"
                          className="h-[26px] text-[13px]"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default" className="text-[13px]">
                            Default ({SAFE_MODE_LABEL[defaultSafeMode].label})
                          </SelectItem>
                          {SAFE_MODE_LEVELS.map((level) => (
                            <SelectItem key={level} value={level} className="text-[13px]">
                              {SAFE_MODE_LABEL[level].label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[12px] text-[var(--wb-text-2)]">
                        {SAFE_MODE_LABEL[safeMode === 'default' ? defaultSafeMode : safeMode].hint}{' '}
                        A Prod tag still confirms destructive statements.
                      </p>
                    </Field>
                    {engine === 'postgres' && (
                      <Field label="Safe Run" htmlFor="conn-always-safe-run">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id="conn-always-safe-run"
                            checked={alwaysSafeRunChoice ?? tag === 'prod'}
                            disabled={Boolean(form.readOnly)}
                            onCheckedChange={(v) => {
                              setAlwaysSafeRunChoice(Boolean(v));
                              touched();
                            }}
                          />
                          <label
                            htmlFor="conn-always-safe-run"
                            className="cursor-pointer text-[13px] text-[var(--wb-text)]"
                          >
                            Always Safe Run writes
                          </label>
                        </div>
                        <p className="text-[12px] text-[var(--wb-text-2)]">
                          Run on an INSERT, UPDATE, DELETE or MERGE executes it in a transaction
                          first and shows the rows it changed; you Commit or Roll back. On by
                          default for Prod connections.
                        </p>
                      </Field>
                    )}
                    {engine === 'postgres' && (
                      <Field label="Run after connecting (SQL)" htmlFor="conn-bootstrap">
                        <textarea
                          id="conn-bootstrap"
                          value={form.bootstrapSql ?? ''}
                          onChange={(e) => update('bootstrapSql', e.target.value || undefined)}
                          rows={3}
                          spellCheck={false}
                          placeholder={"SET search_path TO app, public;\nSET TIME ZONE 'UTC';"}
                          className="rounded-[7px] bg-[var(--wb-field)] px-2 py-1.5 font-mono text-[12px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] outline-none placeholder:text-[var(--wb-text-3)] focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
                        />
                        <p className="text-[12px] text-[var(--wb-text-2)]">
                          Runs on your query session each time it connects; a failing statement
                          stops the connect.
                        </p>
                      </Field>
                    )}
                  </div>
                )}
              </div>

              <div aria-live="polite" className="flex flex-col gap-2">
                {test.kind === 'ok' && (
                  <Notice tone="ok" testId="conn-test-result">
                    {test.message}
                  </Notice>
                )}
                {test.kind === 'fail' && (
                  <Notice tone="error" testId="conn-test-result">
                    {describeConnectError(test.message, engine)}
                  </Notice>
                )}
                {connectErrorVisible && (
                  <Notice tone="error" testId="conn-connect-error">
                    {describeConnectError(connectionError, engine)}
                  </Notice>
                )}
              </div>
            </div>
          </div>

          <DialogFooter className="shrink-0 items-center border-t border-[var(--wb-separator)] bg-[var(--wb-content)] px-5 py-3">
            {isEditing && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  requestDelete(form.id);
                  closeDialog();
                }}
                className="mr-auto text-[var(--destructive)] hover:text-[var(--destructive)]"
                title="Delete this saved connection"
              >
                <Trash2 />
                Delete
              </Button>
            )}
            {showDisconnect && (
              <Button type="button" variant="ghost" size="sm" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            )}
            <Button type="button" variant="secondary" size="sm" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="conn-save"
              onClick={() => void handleSave()}
              disabled={connecting}
              title="Save without connecting"
            >
              <Save />
              Save
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="conn-test"
              onClick={() => void handleTest()}
              disabled={test.kind === 'testing' || connecting}
            >
              {test.kind === 'testing' && <Loader2 className="animate-spin" />}
              {test.kind === 'testing' ? 'Testing…' : 'Test'}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              data-testid="conn-connect"
              disabled={connecting}
            >
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
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && <FieldError id={htmlFor ? `${htmlFor}-error` : undefined}>{error}</FieldError>}
    </div>
  );
}

function FieldError({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="text-[12px] leading-snug text-[var(--destructive)]">
      {children}
    </p>
  );
}

function FileField({
  label,
  value,
  placeholder,
  error,
  onChange,
  onBrowse,
}: {
  label: string;
  value: string;
  placeholder?: string;
  error?: string;
  onChange: (v: string) => void;
  onBrowse: () => void;
}) {
  const id = `conn-tls-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <Field label={label} htmlFor={id} error={error}>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="font-mono text-[12px]"
        />
        <Pill onClick={onBrowse} className="h-[26px]">
          Browse…
        </Pill>
      </div>
    </Field>
  );
}

function Notice({
  tone,
  testId,
  children,
}: {
  tone: 'ok' | 'error';
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'rounded-[6px] px-2.5 py-2 text-[13px] leading-snug text-[var(--wb-text)]',
        tone === 'ok'
          ? 'bg-[color-mix(in_srgb,var(--status-local)_16%,transparent)]'
          : 'bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)]',
      )}
    >
      {tone === 'ok' ? '✓ ' : '✗ '}
      {children}
    </div>
  );
}

const OS_AUTH_LABEL: Record<NonNullable<OpenSearchOptions['auth']>, string> = {
  basic: 'Username and password',
  apiKey: 'API key',
  sigv4: 'AWS SigV4 (Amazon OpenSearch)',
};

/** O12: how to authenticate, plus path prefix and extra nodes. */
function OpenSearchSection({
  options,
  errors,
  onChange,
  isEditing,
}: {
  options: OpenSearchOptions;
  errors: FormErrors;
  onChange: (patch: Partial<OpenSearchOptions>, field?: FormField) => void;
  isEditing: boolean;
}) {
  const auth = options.auth ?? 'basic';
  const keep = (saved: boolean | undefined) =>
    isEditing && saved ? 'Saved — leave blank to keep' : undefined;
  return (
    <div className={SECTION}>
      <Field label="Authentication" htmlFor="os-auth" error={errors.osAuth}>
        <Select value={auth} onValueChange={(v) => onChange({ auth: v as typeof auth })}>
          <SelectTrigger id="os-auth" aria-label="Authentication" className="h-[26px] text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(OS_AUTH_LABEL) as Array<keyof typeof OS_AUTH_LABEL>).map((m) => (
              <SelectItem key={m} value={m} className="text-[13px]">
                {OS_AUTH_LABEL[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {auth === 'basic' && (
        <p className="text-[12px] text-[var(--wb-text-2)]">
          Uses the User and Password fields above; leave both empty for an open cluster.
        </p>
      )}
      {auth === 'apiKey' && (
        <Field label="API key" htmlFor="os-api-key">
          <Input
            id="os-api-key"
            type="password"
            value={options.apiKey ?? ''}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder={keep(options.hasApiKey) ?? 'id:key or base64-encoded key'}
            spellCheck={false}
          />
        </Field>
      )}
      {auth === 'sigv4' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="AWS region" htmlFor="os-aws-region">
            <Input
              id="os-aws-region"
              value={options.awsRegion ?? ''}
              onChange={(e) => onChange({ awsRegion: e.target.value })}
              placeholder="eu-west-1"
            />
          </Field>
          <Field label="Service" htmlFor="os-aws-service">
            <Select
              value={options.awsService ?? 'es'}
              onValueChange={(v) => onChange({ awsService: v as 'es' | 'aoss' })}
            >
              <SelectTrigger
                id="os-aws-service"
                aria-label="Service"
                className="h-[26px] text-[13px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="es" className="text-[13px]">
                  Managed domain (es)
                </SelectItem>
                <SelectItem value="aoss" className="text-[13px]">
                  Serverless (aoss)
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Access key id" htmlFor="os-aws-key-id">
            <Input
              id="os-aws-key-id"
              value={options.awsAccessKeyId ?? ''}
              onChange={(e) => onChange({ awsAccessKeyId: e.target.value })}
              spellCheck={false}
            />
          </Field>
          <Field label="Secret access key" htmlFor="os-aws-secret">
            <Input
              id="os-aws-secret"
              type="password"
              value={options.awsSecretAccessKey ?? ''}
              onChange={(e) => onChange({ awsSecretAccessKey: e.target.value })}
              placeholder={keep(options.hasAwsSecretAccessKey)}
            />
          </Field>
          <div className="col-span-2">
            <Field label="Session token (optional)" htmlFor="os-aws-token">
              <Input
                id="os-aws-token"
                type="password"
                value={options.awsSessionToken ?? ''}
                onChange={(e) => onChange({ awsSessionToken: e.target.value })}
                placeholder={keep(options.hasAwsSessionToken)}
              />
            </Field>
          </div>
        </div>
      )}
      <Field label="Path prefix (optional)" htmlFor="os-path-prefix">
        <Input
          id="os-path-prefix"
          value={options.pathPrefix ?? ''}
          onChange={(e) => onChange({ pathPrefix: e.target.value })}
          placeholder="/search — when the cluster sits behind a reverse proxy"
          spellCheck={false}
        />
      </Field>
      <Field label="Additional nodes (optional)" htmlFor="os-nodes" error={errors.osNodes}>
        <textarea
          id="os-nodes"
          value={(options.nodes ?? []).join('\n')}
          onChange={(e) => onChange({ nodes: e.target.value.split('\n') }, 'osNodes')}
          rows={2}
          spellCheck={false}
          aria-invalid={errors.osNodes ? true : undefined}
          placeholder={'One per line: node2.example.com:9200 or https://node3:9200'}
          className="rounded-[7px] bg-[var(--wb-field)] px-2 py-1.5 font-mono text-[12px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] outline-none placeholder:text-[var(--wb-text-3)] focus-visible:shadow-[inset_0_0_0_1px_var(--ring)] aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--destructive)]"
        />
      </Field>
    </div>
  );
}
