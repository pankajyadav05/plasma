import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Pill } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { databaseLabel } from '@/lib/engine-meta';
import { describeConnectError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { MOD } from '@/lib/platform';
import { SAFE_MODE_LABEL, SAFE_MODE_LEVELS, type SafeModeLevel } from '@/stores/safe-mode';
import { useSession } from '@/stores/session';
import { useConnectionDraft } from '@/stores/workspace';
import { suggestReadOnlyForTag } from '@shared/connection-readonly';
import {
  type ParsedConnectionUrl,
  formatConnectionUrl,
  parseConnectionUrl,
} from '@shared/connection-url';
import { dataFileKind } from '@shared/data-files';
import type {
  ConnectionConfig,
  ConnectionEngine,
  ConnectionSshConfig,
  OpenSearchOptions,
  TlsMode,
} from '@shared/protocol';
import { engineCaps } from '@shared/sql-dialect';
import { Check, Copy, Link2, Loader2, Play, Save, Trash2 } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CapsulePreview } from './CapsulePreview';
import { SectionIndex } from './SectionIndex';
import { ENGINE_DEFAULTS, isPlaceholderName } from './connection-defaults';
import {
  Field,
  FieldError,
  FileField,
  Hint,
  OpenSearchAuthFields,
  OpenSearchServerFields,
  SectionCard,
  Switch,
  TEXTAREA_CLASS,
} from './connection-fields';
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
import {
  SECTION_HINT,
  SECTION_TITLE,
  type SectionId,
  type SectionStatus,
  firstInvalidSection,
  isFileEngine,
  sectionStatus,
  sectionsFor,
} from './connection-sections';
import { ENV_TAGS, type EnvTag, TAG_COLOR, TAG_LABEL } from './env-tags';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; message: string }
  | { kind: 'fail'; message: string };

const TLS_MODES: Exclude<TlsMode, 'insecure'>[] = [
  'disable',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
];

export interface ConnectionEditorHandle {
  /** Switch engine, keeping typed values (creating only). */
  applyEngine(engine: ConnectionEngine): void;
  /** Fill the fields from a parsed URL. */
  applyParsed(parsed: ParsedConnectionUrl): void;
  /** URL for the current form values, without the password. */
  getUrl(): string;
  /** Move focus to the first field. */
  focusFirst(): void;
}

export interface ConnectionEditorProps {
  initial: ConnectionConfig;
  /** A saved connection (engine locked, secrets kept on blank). False = new or draft. */
  isEditing: boolean;
  /** Move focus to the Name field once mounted. */
  focusOnMount?: boolean;
  /** Shown while creating: go back to the engine picker. */
  onChangeEngine?: () => void;
  /** Reports the live name and whether the form differs from what was loaded. */
  onStatus: (s: { name: string; dirty: boolean }) => void;
  /** Runs `action` now, or after the user confirms losing unsaved changes. */
  guard: (action: () => void) => void;
}

/**
 * The connection form: capsule preview, section cards, section index and the
 * sticky action bar. Holds all form state; the Connections screen only picks
 * which connection it edits.
 */
export const ConnectionEditor = forwardRef<ConnectionEditorHandle, ConnectionEditorProps>(
  function ConnectionEditor(
    { initial, isEditing, focusOnMount, onChangeEngine, onStatus, guard },
    ref,
  ) {
    const connectionState = useSession((s) => s.connectionState);
    const connectionError = useSession((s) => s.connectionError);
    const connect = useSession((s) => s.connect);
    const testConnection = useSession((s) => s.testConnection);
    const closeDialog = useSession((s) => s.closeDialog);
    const disconnect = useSession((s) => s.disconnect);
    const activeConfig = useSession((s) => s.activeConfig);
    const requestDelete = useSession((s) => s.requestDeleteConnection);
    const duplicateSaved = useSession((s) => s.duplicateSaved);
    const editConnection = useSession((s) => s.editConnection);
    const setConnectionTag = useSession((s) => s.setConnectionTag);
    const updateSettings = useSession((s) => s.updateSettings);
    const saveConnectionOnly = useSession((s) => s.saveConnectionOnly);
    const savedConnections = useSession((s) => s.savedConnections);
    const allSsh = useSession((s) => s.settings.connectionSsh);
    const allSafeMode = useSession((s) => s.settings.connectionSafeMode);
    const defaultSafeMode = useSession((s) => s.settings.safeModeDefault);
    const allAlwaysSafeRun = useSession((s) => s.settings.connectionAlwaysSafeRun);
    const initialTag = useSession((s) => s.settings.connectionTags?.[initial.id]);
    const initialSsh = useSession((s) => s.settings.connectionSsh?.[initial.id]);

    const [form, setForm] = useState<ConnectionConfig>(initial);
    const [portText, setPortText] = useState(() => String(initial.port));
    const [test, setTest] = useState<TestState>({ kind: 'idle' });
    const [errors, setErrors] = useState<FormErrors>({});
    /** The store's connect error belongs to the last submit; hide it once the user edits. */
    const [showConnectError, setShowConnectError] = useState(false);
    const [urlOpen, setUrlOpen] = useState(false);
    const [urlText, setUrlText] = useState('');
    const [urlError, setUrlError] = useState<string | null>(null);
    const [tag, setTag] = useState<EnvTag | null>((initialTag as EnvTag | undefined) ?? null);
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
    // null = untouched: follows the tag (on for Prod).
    const [alwaysSafeRunChoice, setAlwaysSafeRunChoice] = useState<boolean | null>(
      () => allAlwaysSafeRun?.[initial.id] ?? null,
    );
    const [safeMode, setSafeMode] = useState<SafeModeLevel | 'default'>(
      () => allSafeMode?.[initial.id] ?? 'default',
    );
    const [advancedOpen, setAdvancedOpen] = useState(
      () => safeMode !== 'default' || alwaysSafeRunChoice !== null || Boolean(initial.bootstrapSql),
    );

    const formRef = useRef<HTMLFormElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const nameRef = useRef<HTMLInputElement>(null);
    const [currentSection, setCurrentSection] = useState<SectionId | null>('connection');

    const engine = (form.engine ?? 'postgres') as ConnectionEngine;
    const groupSuggestions = useMemo(() => existingGroups(savedConnections), [savedConnections]);
    const showDisconnect = Boolean(activeConfig && isEditing && activeConfig.id === initial.id);
    const sshSupported = engineCaps(engine).ssh && engine !== 'opensearch';
    const isFile = isFileEngine(engine);
    const tlsMode = formTlsMode(form);
    const sections = useMemo(() => sectionsFor(engine, sshSupported), [engine, sshSupported]);
    const connecting = connectionState === 'connecting';
    const connectErrorVisible = showConnectError && connectionState === 'error' && connectionError;

    // ── dirty tracking ──
    const snapshot = JSON.stringify({
      form,
      portText,
      tag,
      useSsh,
      ssh,
      safeMode,
      alwaysSafeRunChoice,
    });
    const baseline = useRef(snapshot);
    const dirty = snapshot !== baseline.current;
    useEffect(() => {
      onStatus({ name: form.name, dirty });
    }, [form.name, dirty, onStatus]);

    useEffect(() => {
      if (focusOnMount) nameRef.current?.focus();
    }, [focusOnMount]);

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
      // values when flicking between engines.
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

    const applyParsed = (parsed: ParsedConnectionUrl) => {
      setForm((prev) => ({
        ...prev,
        ...parsed,
        // Keep a saved password when the URL carries none.
        password: parsed.password || prev.password,
        name: isPlaceholderName(prev.name) ? parsed.host : prev.name,
      }));
      setPortText(String(parsed.port));
      setErrors({});
      touched();
    };

    const currentConfig = (): ConnectionConfig => ({ ...form, port: Number(portText.trim()) || 0 });

    useImperativeHandle(ref, () => ({
      applyEngine: switchEngine,
      applyParsed,
      getUrl: () => formatConnectionUrl(currentConfig()),
      focusFirst: () => nameRef.current?.focus(),
    }));

    const scrollToSection = useCallback((id: SectionId) => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-section="conn-sec-${id}"]`);
      if (!el) return;
      setCurrentSection(id);
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    }, []);

    // Scroll-spy: the current card is the last one whose top has passed the fold.
    const onScroll = useCallback(() => {
      const root = scrollRef.current;
      if (!root) return;
      const fold = root.getBoundingClientRect().top + 96;
      let found: SectionId | null = null;
      for (const el of root.querySelectorAll<HTMLElement>('[data-section]')) {
        if (el.getBoundingClientRect().top <= fold) {
          found = el.dataset.section?.replace('conn-sec-', '') as SectionId;
        }
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) {
        const all = root.querySelectorAll<HTMLElement>('[data-section]');
        const last = all[all.length - 1];
        if (last) found = last.dataset.section?.replace('conn-sec-', '') as SectionId;
      }
      setCurrentSection(found ?? sections[0] ?? null);
    }, [sections]);

    const validate = (): boolean => {
      const next = validateConnectionForm({
        config: form,
        portText,
        useSsh,
        ssh,
        savedSsh: initialSsh,
      });
      setErrors(next);
      const bad = firstInvalidSection(next, sections);
      if (bad) {
        // Wait a frame so the error text is in the layout before we scroll.
        requestAnimationFrame(() => scrollToSection(bad));
      }
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
      const started = performance.now();
      const res = await testConnection(currentConfig(), sshPayload());
      const ms = Math.round(performance.now() - started);
      setTest(
        res.ok
          ? { kind: 'ok', message: `${res.message} · ${ms} ms` }
          : { kind: 'fail', message: res.message },
      );
    };

    /** Tag, SSH tunnel and safe-mode level live in settings, keyed by connection id. */
    const persistSideSettings = async () => {
      void setConnectionTag(form.id, tag);
      const nextSshMap = { ...(allSsh ?? {}) };
      // SSH tunnels make sense for engines on raw TCP; OpenSearch is HTTPS,
      // so the section is hidden there (see sshSupported).
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
      // On success the store leaves the Connections screen for the database.
      await connect(currentConfig());
    };

    /** C28: keep the connection without opening it. Stays here, with it selected. */
    const handleSave = async () => {
      setTest({ kind: 'idle' });
      if (!validate()) return;
      try {
        await persistSideSettings();
        await saveConnectionOnly(currentConfig());
        // Reload the saved row: it is now an edit of a saved connection.
        useConnectionDraft.getState().setDraft(null);
        await editConnection(form.id);
      } catch (err) {
        setTest({ kind: 'fail', message: err instanceof Error ? err.message : String(err) });
      }
    };

    const handleDuplicate = () =>
      guard(() => {
        void duplicateSaved(form.id)
          .then((copy) => editConnection(copy.id))
          .catch((err: unknown) =>
            setTest({ kind: 'fail', message: err instanceof Error ? err.message : String(err) }),
          );
      });

    const applyUrl = () => {
      try {
        const parsed = parseConnectionUrl(urlText);
        if (isEditing && parsed.engine !== engine) {
          throw new Error(
            `This is a ${parsed.engine} URL; the connection is ${engine}. Delete and re-add to change engines.`,
          );
        }
        applyParsed(parsed);
        setUrlOpen(false);
        setUrlText('');
        setUrlError(null);
      } catch (err) {
        setUrlError(err instanceof Error ? err.message : String(err));
      }
    };

    const pickSqlite = async (mode: 'open' | 'create') => {
      try {
        let path: string | null;
        if (engine === 'duckdb') {
          const picked = await ipc.conn.pickDataFiles('database');
          path = picked?.files[0] ?? null;
          if (picked && !path) throw new Error(picked.problems[0] ?? 'That is not a DuckDB file');
          if (path && dataFileKind(path) !== 'duckdb') {
            throw new Error('Choose a .duckdb file, or use Open data file… for CSV and Parquet.');
          }
        } else {
          path = await ipc.conn.pickSqliteFile(mode);
        }
        if (!path) return;
        setForm((prev) => ({
          ...prev,
          database: path,
          host: 'local',
          port: 1,
          name: !isPlaceholderName(prev.name) ? prev.name : (path.split(/[\\/]/).pop() ?? path),
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

    const tlsLabel =
      engine === 'postgres' || engine === 'mysql'
        ? 'SSL mode'
        : engine === 'redis'
          ? 'TLS'
          : 'HTTPS';

    const advancedTouched =
      safeMode !== 'default' || alwaysSafeRunChoice !== null || Boolean(form.bootstrapSql);
    const statuses = useMemo(() => {
      const input = {
        config: form,
        portText,
        useSsh,
        ssh,
        savedSsh: initialSsh,
        errors,
        advancedTouched,
      };
      const out = {} as Record<SectionId, SectionStatus>;
      for (const id of sections) out[id] = sectionStatus(id, input);
      return out;
    }, [form, portText, useSsh, ssh, initialSsh, errors, advancedTouched, sections]);

    const capsuleTls = isFile
      ? null
      : form.ssl
        ? `TLS${form.tls?.mode === 'insecure' ? ' (unverified)' : ''}`
        : useSsh
          ? 'SSH'
          : 'No TLS';
    const capsuleDb = isFile
      ? databaseLabel({ engine, database: form.database })
      : engine === 'redis'
        ? form.database || '0'
        : form.database;

    const sid = (id: SectionId) => `conn-sec-${id}`;
    const showBasicLogin =
      engine !== 'opensearch' || (form.opensearch?.auth ?? 'basic') === 'basic';

    return (
      <form
        ref={formRef}
        onSubmit={handleConnect}
        noValidate
        data-testid="connection-form"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            formRef.current?.requestSubmit();
          }
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[860px] justify-center gap-8 px-6 py-5">
            <div className="flex w-full max-w-[620px] min-w-0 flex-col gap-4">
              <CapsulePreview
                engine={engine}
                tls={capsuleTls}
                name={form.name}
                database={capsuleDb}
                tag={tag}
              />

              {onChangeEngine ? (
                <p className="text-[12px] text-[var(--wb-text-2)]">
                  <button
                    type="button"
                    onClick={onChangeEngine}
                    className="cursor-pointer text-[var(--wb-accent-text)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Change engine
                  </button>
                </p>
              ) : (
                isEditing && (
                  <p className="text-[12px] text-[var(--wb-text-2)]">
                    The engine is fixed for a saved connection. Delete and re-add to change it.
                  </p>
                )
              )}

              {/* a. Connection */}
              <SectionCard
                id={sid('connection')}
                title={SECTION_TITLE.connection}
                hint={SECTION_HINT.connection}
                action={
                  <Pill
                    onClick={() => setUrlOpen((o) => !o)}
                    aria-expanded={urlOpen}
                    title="Fill the fields from a connection URL"
                  >
                    <Link2 />
                    Import URL…
                  </Pill>
                }
              >
                {urlOpen && (
                  <div className="flex flex-col gap-1.5">
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
                            e.stopPropagation();
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
                <div className="grid grid-cols-[1fr_180px] gap-3">
                  <Field label="Name" htmlFor="conn-name" error={errors.name}>
                    <Input
                      id="conn-name"
                      ref={nameRef}
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

                <div className="flex flex-col gap-1">
                  <span
                    id="conn-env-label"
                    className="text-[13px] font-medium text-[var(--wb-text)]"
                  >
                    Environment
                  </span>
                  <fieldset
                    aria-labelledby="conn-env-label"
                    className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0"
                  >
                    {ENV_TAGS.map((t) => {
                      const selected = tag === t;
                      return (
                        <button
                          key={t}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => {
                            const next = selected ? null : t;
                            setTag(next);
                            // Prod suggests read-only by default (U28). The user
                            // can still turn it off after picking Prod.
                            if (suggestReadOnlyForTag(next) && !form.readOnly) {
                              setForm((prev) => ({ ...prev, readOnly: true }));
                            }
                            touched();
                          }}
                          style={selected ? { backgroundColor: TAG_COLOR[t] } : undefined}
                          className={cn(
                            'inline-flex h-6 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
                  </fieldset>
                  <Hint>Prod turns the top bar red and asks before destructive SQL.</Hint>
                </div>

                <div className="flex items-start gap-2.5">
                  <Switch
                    id="conn-readonly"
                    checked={Boolean(form.readOnly)}
                    onCheckedChange={(v) => update('readOnly', v)}
                  />
                  <div className="flex flex-col gap-0.5">
                    <label
                      htmlFor="conn-readonly"
                      className="cursor-pointer text-[13px] leading-[18px] text-[var(--wb-text)]"
                    >
                      Read-only
                    </label>
                    <Hint>
                      Refuses writes on every engine.{tag === 'prod' ? ' Suggested for Prod.' : ''}
                    </Hint>
                  </div>
                </div>
              </SectionCard>

              {/* b. Server */}
              <SectionCard
                id={sid('server')}
                title={SECTION_TITLE.server}
                hint={SECTION_HINT.server}
              >
                {isFile ? (
                  <Field
                    label={engine === 'duckdb' ? 'DuckDB file' : 'Database file'}
                    htmlFor="conn-file"
                    error={errors.database}
                  >
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
                      {engine === 'sqlite' && (
                        <Pill onClick={() => void pickSqlite('create')}>New…</Pill>
                      )}
                    </div>
                    <Hint>
                      {engine === 'duckdb'
                        ? 'Opened read-only. For CSV, Excel, Parquet or JSON, use Open data file… instead.'
                        : 'Turn on Read-only above to open the file without changing it.'}
                    </Hint>
                  </Field>
                ) : (
                  <>
                    <div className="grid grid-cols-[1fr_120px] gap-3">
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
                    {engine === 'redis' && redisEndpointKind(form.host) !== 'tcp' && (
                      <Hint>
                        {
                          REDIS_HOST_HINT[
                            redisEndpointKind(form.host) as Exclude<
                              ReturnType<typeof redisEndpointKind>,
                              'tcp'
                            >
                          ]
                        }
                      </Hint>
                    )}
                    {engine === 'redis' && redisEndpointKind(form.host) === 'tcp' && (
                      <p className="text-[12px] text-[var(--wb-text-3)]">
                        Host also accepts a unix socket path, sentinel://h1:26379,h2:26379/master or
                        cluster://h1:7000,h2:7001.
                      </p>
                    )}
                    {(engine === 'postgres' || engine === 'mysql' || engine === 'clickhouse') && (
                      <Field label="Database" htmlFor="conn-db" error={errors.database}>
                        <Input
                          id="conn-db"
                          value={form.database}
                          onChange={(e) => update('database', e.target.value, 'database')}
                          placeholder={
                            engine === 'mysql'
                              ? '(optional)'
                              : engine === 'clickhouse'
                                ? 'default'
                                : 'postgres'
                          }
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
                    {engine === 'opensearch' && (
                      <OpenSearchServerFields
                        options={form.opensearch ?? {}}
                        errors={errors}
                        onChange={updateOs}
                      />
                    )}
                  </>
                )}
              </SectionCard>

              {/* c. Authentication */}
              {sections.includes('auth') && (
                <SectionCard id={sid('auth')} title={SECTION_TITLE.auth} hint={SECTION_HINT.auth}>
                  {engine === 'opensearch' && (
                    <OpenSearchAuthFields
                      options={form.opensearch ?? {}}
                      errors={errors}
                      onChange={updateOs}
                      isEditing={isEditing}
                    />
                  )}
                  {showBasicLogin && (
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
                </SectionCard>
              )}

              {/* d. Security (C4/C9: TLS mode + CA / client certificate files) */}
              {sections.includes('security') && (
                <SectionCard
                  id={sid('security')}
                  title={SECTION_TITLE.security}
                  hint={SECTION_HINT.security}
                >
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
                    <Hint>
                      Encrypted, but the server certificate is not checked. Not allowed for
                      connections tagged Prod.
                    </Hint>
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
                </SectionCard>
              )}

              {/* e. SSH tunnel: hidden for OpenSearch (HTTPS over public endpoints) */}
              {sections.includes('ssh') && (
                <SectionCard
                  id={sid('ssh')}
                  title={SECTION_TITLE.ssh}
                  hint={SECTION_HINT.ssh}
                  action={
                    <Switch
                      aria-label="Connect over SSH tunnel"
                      checked={useSsh}
                      onCheckedChange={(v) => {
                        setUseSsh(v);
                        touched(['sshHost', 'sshPort', 'sshUser', 'sshAuth']);
                      }}
                    />
                  }
                  open={useSsh}
                >
                  {errors.ssh && <FieldError id="ssh-unsupported">{errors.ssh}</FieldError>}
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
                          className={cn(TEXTAREA_CLASS, 'text-[11px]')}
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
                </SectionCard>
              )}

              {/* f. Advanced: per-connection guard rails + bootstrap SQL */}
              <SectionCard
                id={sid('advanced')}
                title={SECTION_TITLE.advanced}
                hint={SECTION_HINT.advanced}
                open={advancedOpen}
                onToggle={() => setAdvancedOpen((o) => !o)}
              >
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
                  <Hint>
                    {SAFE_MODE_LABEL[safeMode === 'default' ? defaultSafeMode : safeMode].hint} A
                    Prod tag still confirms destructive statements.
                  </Hint>
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
                    <Hint>
                      Run on an INSERT, UPDATE, DELETE or MERGE executes it in a transaction first
                      and shows the rows it changed; you Commit or Roll back. On by default for Prod
                      connections.
                    </Hint>
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
                      className={TEXTAREA_CLASS}
                    />
                    <Hint>
                      Runs on your query session each time it connects; a failing statement stops
                      the connect.
                    </Hint>
                  </Field>
                )}
              </SectionCard>
            </div>

            <SectionIndex
              sections={sections}
              statuses={statuses}
              current={currentSection}
              onPick={scrollToSection}
            />
          </div>
        </div>

        {/* Sticky action bar */}
        <div className="flex shrink-0 items-center gap-3 border-t border-[var(--wb-separator)] bg-[var(--wb-window)] px-4 py-2.5">
          <div
            aria-live="polite"
            className="flex min-w-0 flex-1 items-center gap-2 text-[13px] text-[var(--wb-text)]"
          >
            {test.kind === 'testing' && (
              <>
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--wb-text-2)]" />
                <span data-testid="conn-test-result">Testing…</span>
              </>
            )}
            {test.kind === 'ok' && (
              <>
                <Check
                  className="h-3.5 w-3.5 shrink-0 text-[var(--status-local)]"
                  strokeWidth={3}
                />
                <span className="truncate" data-testid="conn-test-result" title={test.message}>
                  {test.message}
                </span>
              </>
            )}
            {test.kind === 'fail' && (
              <span
                className="line-clamp-2 text-[var(--destructive)]"
                data-testid="conn-test-result"
                title={describeConnectError(test.message, engine)}
              >
                {describeConnectError(test.message, engine)}
              </span>
            )}
            {test.kind === 'idle' && connectErrorVisible && (
              <span
                className="line-clamp-2 text-[var(--destructive)]"
                data-testid="conn-connect-error"
                title={describeConnectError(connectionError, engine)}
              >
                {describeConnectError(connectionError, engine)}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isEditing && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleDuplicate}
                  title="Make a copy of this saved connection"
                >
                  <Copy />
                  Duplicate
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => requestDelete(form.id)}
                  className="text-[var(--destructive)] hover:text-[var(--destructive)]"
                  title="Delete this saved connection"
                >
                  <Trash2 />
                  Delete
                </Button>
                <span className="mx-1 h-4 w-px bg-[var(--wb-separator)]" aria-hidden />
              </>
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
              data-testid="conn-test"
              onClick={() => void handleTest()}
              disabled={test.kind === 'testing' || connecting}
            >
              {test.kind === 'testing' && <Loader2 className="animate-spin" />}
              {test.kind === 'testing' ? 'Testing…' : 'Test'}
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
              type="submit"
              variant="primary"
              size="sm"
              data-testid="conn-connect"
              disabled={connecting}
              title="Connect (Ctrl/⌘ + Enter)"
            >
              {connecting ? <Loader2 className="animate-spin" /> : <Play />}
              {connecting ? 'Connecting…' : 'Connect'}
              {!connecting && <kbd className="ml-1 font-sans text-[11px] opacity-70">{MOD}↵</kbd>}
            </Button>
          </div>
        </div>
      </form>
    );
  },
);
