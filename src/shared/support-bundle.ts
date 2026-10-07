import { redactSecrets } from './redact-secrets';

/**
 * The support bundle: what Plasma can hand to someone who is helping debug a
 * problem, with every secret removed and none of the user's data in it.
 *
 * This file is the pure part (tested without Electron): what goes in each
 * file, how settings and connections are reduced to what is safe, and the
 * optional second pass that hides host names and user names. Main gathers the
 * inputs and writes the zip; the renderer shows every file before anything is
 * saved. Nothing is ever uploaded.
 *
 * Never in a bundle, by construction and by test: query results, SQL text
 * (history, snippets, saved queries, tabs, bootstrap SQL, SQL that an error
 * quotes), row data, passwords, keys, tokens, connection-string secrets.
 */

export const SupportChannel = {
  Preview: 'plasma:support:preview',
  Save: 'plasma:support:save',
} as const;

export interface SupportBundleOptions {
  /** Also replace host names, IP addresses, user names and e-mail addresses with placeholders. */
  redactHostsAndUsers: boolean;
}

export interface SupportBundleFile {
  /** Path inside the zip. */
  name: string;
  /** One line: what the file is. */
  description: string;
  /** The exact text that will be written. */
  text: string;
  bytes: number;
}

export interface SupportBundlePreview {
  /** Hand back to `save` to write exactly these files. */
  token: string;
  files: SupportBundleFile[];
  totalBytes: number;
}

export type SupportBundleSaveResult =
  | { saved: true; filePath: string; bytes: number }
  | { saved: false };

export interface SupportApi {
  /** Gather the bundle and return every file's exact text, for review. */
  preview(options: SupportBundleOptions): Promise<SupportBundlePreview>;
  /** Ask where to save, then write the previewed files as a zip. Nothing is uploaded. */
  save(token: string): Promise<SupportBundleSaveResult>;
}

// ── inputs ───────────────────────────────────────────────────────────────

export interface SupportBundleInput {
  generatedAt: string;
  app: {
    name: string;
    version: string;
    platform: string;
    arch: string;
    osRelease: string;
    electron: string;
    chrome: string;
    node: string;
    locale: string;
    packaged: boolean;
  };
  /** The connection the app is on now, when there is one. */
  active: { engine: string; serverVersion: string } | null;
  /** Saved connections as the renderer sees them (no passwords). */
  connections: unknown[];
  settings: Record<string, unknown>;
  /** Raw log text, newest last: the main process log and the one it rotated out. */
  mainLog: string;
  mainLogOld?: string;
  /** What the database worker printed since the app started. */
  workerLog: string;
  /** `update-helper.log`, when an update ran. */
  updateHelperLog: string | null;
  /** The OS account name, hidden along with the others when asked. */
  osUser: string;
}

// ── limits ───────────────────────────────────────────────────────────────

export const MAIN_LOG_LINES = 2000;
export const WORKER_LOG_LINES = 1000;
export const UPDATE_LOG_LINES = 200;
export const ERROR_LINES = 100;
const MAX_LINE = 600;
const MAX_STRING = 300;

// ── text helpers ─────────────────────────────────────────────────────────

/** The last `n` lines of `text`. */
export function tailLines(text: string, n: number): string {
  if (!text) return '';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-n).join('\n');
}

/** A line that holds SQL: a statement a log or an error quoted. Dropped, not shown. */
const SQL_LINE =
  /\b(select\b[\s\S]{0,400}?\bfrom\b|insert\s+into\b|update\s+["`\w.]+\s+set\b|delete\s+from\b|create\s+(or\s+replace\s+)?(table|view|index|function|role|user)\b|alter\s+(table|role|user)\b|drop\s+(table|view|index|database|schema)\b|truncate\s+table\b|copy\s+\S+\s+(from|to)\b|\bvalues\s*\()/i;

export const SQL_LINE_PLACEHOLDER = '[line left out: it looks like SQL]';

/** Remove what a log line must not carry, one line at a time. */
function scrubLogLines(text: string): string {
  return text
    .split('\n')
    .map((raw) => {
      const line = raw.length > MAX_LINE ? `${raw.slice(0, MAX_LINE)}… [cut]` : raw;
      return SQL_LINE.test(line) ? SQL_LINE_PLACEHOLDER : line;
    })
    .join('\n');
}

const ERROR_LINE =
  /\[(?:error|fatal)\]|\buncaught\b|\bunhandled\b|\bcrash|\[worker:err\]|\bFATAL\b/i;

/** The most recent error lines of `logs` (each already scrubbed). */
export function recentErrors(logs: readonly string[], limit = ERROR_LINES): string {
  const found: string[] = [];
  for (const log of logs) {
    for (const line of log.split('\n')) {
      if (ERROR_LINE.test(line) && line !== SQL_LINE_PLACEHOLDER) found.push(line);
    }
  }
  return found.slice(-limit).join('\n');
}

// ── settings ─────────────────────────────────────────────────────────────

/** A key whose value is a credential, whatever its name is attached to. */
const SECRET_KEY =
  /(api[_-]?key|secret|token|password|passphrase|private[_-]?key|credential|authorization)/i;

/** Keys that hold what the user wrote or ran: never in a bundle, not even as a summary of the text. */
const USER_CONTENT_KEY =
  /(snippet|saved[_-]?quer|query[_-]?history|^history|bootstrap|notebook|recent[_-]?files|tabs$|snapshot|prompt|chat|conversation|messages|^sql|sql$)/i;

/** A credential reduced to whether it is set. */
function maskSecretValue(value: unknown): unknown {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value ? '[set]' : '[empty]';
  return '[left out]';
}

function summarize(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} entries`;
  if (value && typeof value === 'object') return `${Object.keys(value).length} entries`;
  return typeof value;
}

function safeString(value: string): string {
  const clean = redactSecrets(value);
  if (SQL_LINE.test(clean)) return '[text left out: it looks like SQL]';
  if (clean.length > MAX_STRING || clean.includes('\n'))
    return `[text, ${clean.length} characters]`;
  return clean;
}

function safeValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return safeString(value);
  if (Array.isArray(value)) {
    if (
      depth > 0 ||
      value.length > 50 ||
      !value.every((v) => typeof v !== 'object' || v === null)
    ) {
      return `[${summarize(value)}]`;
    }
    return value.map((v) => safeValue(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    // A flat record of plain values (per-connection flags keyed by id) is kept; anything deeper is not.
    if (
      depth === 0 &&
      entries.length <= 200 &&
      entries.every(([, v]) => typeof v !== 'object' || v === null)
    ) {
      return Object.fromEntries(
        entries.map(([k, v]) => [
          k,
          SECRET_KEY.test(k) ? maskSecretValue(v) : safeValue(v, depth + 1),
        ]),
      );
    }
    return `[${summarize(value)}]`;
  }
  return undefined;
}

/** What an SSH tunnel entry says about itself without any of its secrets. */
function sshSummary(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return '[omitted]';
  const e = entry as Record<string, unknown>;
  return {
    host: typeof e.host === 'string' ? redactSecrets(e.host) : undefined,
    port: typeof e.port === 'number' ? e.port : undefined,
    user: typeof e.user === 'string' ? e.user : undefined,
    auth: e.useAgent
      ? 'agent'
      : e.privateKey || e.privateKeyPath || e.hasPrivateKey
        ? 'key'
        : 'password',
    keyFile: Boolean(e.privateKeyPath),
  };
}

/**
 * Reduce the settings to what is safe to share: plain preferences are kept,
 * credentials become `[set]` / `[empty]`, SSH tunnels lose their secrets, and
 * everything the user wrote (snippets, saved queries, history, tabs) is left out.
 */
export function sanitizeSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'connectionSsh' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([id, v]) => [id, sshSummary(v)]),
      );
      continue;
    }
    if (key === 'sshKnownHosts') {
      out[key] = `[${summarize(value)}]`;
      continue;
    }
    if (USER_CONTENT_KEY.test(key)) {
      out[key] = `[left out: ${summarize(value)}]`;
      continue;
    }
    if (SECRET_KEY.test(key)) {
      out[key] = maskSecretValue(value);
      continue;
    }
    const safe = safeValue(value);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

// ── connections ──────────────────────────────────────────────────────────

const FILE_ENGINES = new Set(['sqlite', 'duckdb']);

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function urlWithoutUserinfo(url: string): string {
  return redactSecrets(url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1'));
}

/**
 * Saved connections reduced to what helps with a connection problem: engine,
 * host, port, database, user, TLS and SSH settings. Passwords, keys, tokens,
 * certificate contents, bootstrap SQL and file paths do not appear.
 */
export function sanitizeConnections(list: readonly unknown[]): Array<Record<string, unknown>> {
  return list.map((raw) => {
    const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const engine = typeof c.engine === 'string' ? c.engine : 'postgres';
    const file = FILE_ENGINES.has(engine);
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v ? redactSecrets(v) : undefined;
    const tls = (c.tls && typeof c.tls === 'object' ? c.tls : {}) as Record<string, unknown>;
    const os = (c.opensearch && typeof c.opensearch === 'object' ? c.opensearch : {}) as Record<
      string,
      unknown
    >;
    const duckdb = (c.duckdb && typeof c.duckdb === 'object' ? c.duckdb : {}) as Record<
      string,
      unknown
    >;
    const out: Record<string, unknown> = {
      id: str(c.id),
      name: str(c.name),
      engine,
      ...(file ? {} : { host: str(c.host), port: typeof c.port === 'number' ? c.port : undefined }),
      // A file engine's "database" is a path on this computer: the file name is enough.
      database: file
        ? typeof c.database === 'string' && c.database
          ? baseName(c.database)
          : undefined
        : str(c.database),
      user: file ? undefined : str(c.user),
      ssl: typeof c.ssl === 'boolean' ? c.ssl : undefined,
      tlsMode: typeof tls.mode === 'string' ? tls.mode : undefined,
      readOnly: typeof c.readOnly === 'boolean' ? c.readOnly : undefined,
      group: str(c.group),
      tag: str(c.tag),
      hasBootstrapSql: Boolean(c.bootstrapSql) || undefined,
    };
    if (Object.keys(os).length > 0) {
      out.opensearch = {
        auth: typeof os.auth === 'string' ? os.auth : 'basic',
        pathPrefix: str(os.pathPrefix),
        extraNodes: Array.isArray(os.nodes)
          ? os.nodes.map((n) => urlWithoutUserinfo(String(n)))
          : undefined,
        awsRegion: str(os.awsRegion),
      };
    }
    if (Array.isArray(duckdb.files)) out.dataFiles = duckdb.files.length;
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
  });
}

// ── hiding hosts and users ───────────────────────────────────────────────

const KEEP_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'local', '']);

/** Hosts and users named in the saved connections, the SSH tunnels and the OS account. */
export function collectIdentities(
  connections: readonly unknown[],
  settings: Record<string, unknown>,
  osUser: string,
): { hosts: string[]; users: string[] } {
  const hosts = new Set<string>();
  const users = new Set<string>();
  const addHost = (v: unknown) => {
    if (typeof v !== 'string') return;
    const h =
      v
        .trim()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
        .replace(/^[^@/]*@/, '')
        .split(/[/:?#]/)[0] ?? '';
    if (!KEEP_HOSTS.has(h.toLowerCase())) hosts.add(h);
  };
  const addUser = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) users.add(v.trim());
  };
  for (const raw of connections) {
    const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (!FILE_ENGINES.has(String(c.engine))) addHost(c.host);
    addUser(c.user);
    const os = c.opensearch as { nodes?: unknown[] } | undefined;
    for (const n of os?.nodes ?? []) addHost(n);
  }
  const ssh = settings.connectionSsh;
  if (ssh && typeof ssh === 'object') {
    for (const v of Object.values(ssh as Record<string, unknown>)) {
      const e = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      addHost(e.host);
      addUser(e.user);
    }
  }
  addUser(osUser);
  return {
    // Longest first, so "db.prod.example.com" goes before "db".
    hosts: [...hosts].sort((a, b) => b.length - a.length),
    users: [...users].sort((a, b) => b.length - a.length),
  };
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces known hosts, users, IP addresses, e-mail addresses and home folders with stable placeholders. */
export function createPrivacyFilter(identities: { hosts: string[]; users: string[] }) {
  const hostName = new Map<string, string>();
  const userName = new Map<string, string>();
  const ipName = new Map<string, string>();
  const mailName = new Map<string, string>();
  const name = (map: Map<string, string>, key: string, prefix: string): string => {
    const k = key.toLowerCase();
    let v = map.get(k);
    if (!v) {
      v = `${prefix}-${map.size + 1}`;
      map.set(k, v);
    }
    return v;
  };
  // Words a user name must not be replaced inside (a user called "app" is not "application").
  const wordRe = (word: string) =>
    new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(word)}(?![A-Za-z0-9_-])`, 'gi');
  const hostRes = identities.hosts.map((h) => ({ h, re: wordRe(h) }));
  const userRes = identities.users.filter((u) => u.length >= 3).map((u) => ({ u, re: wordRe(u) }));

  const text = (input: string): string => {
    let out = input;
    // E-mail addresses first: they hold a user and a host.
    out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, (m) =>
      name(mailName, m, 'email'),
    );
    for (const { h, re } of hostRes) out = out.replace(re, name(hostName, h, 'host'));
    out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) =>
      ip === '127.0.0.1' || ip === '0.0.0.0' ? ip : name(ipName, ip, 'ip'),
    );
    for (const { u, re } of userRes) out = out.replace(re, name(userName, u, 'user'));
    // Home folders carry the account name even when it was never saved anywhere.
    out = out.replace(/(\/home\/|\/Users\/|[A-Za-z]:\\Users\\)([^/\\\s'"]+)/g, '$1<user>');
    return out;
  };
  return {
    text,
    host: (h: string) => (KEEP_HOSTS.has(h.toLowerCase()) ? h : name(hostName, h, 'host')),
    user: (u: string) => (u ? name(userName, u, 'user') : u),
  };
}

type PrivacyFilter = ReturnType<typeof createPrivacyFilter>;

/** The structured fields of a connection that name a host or a user, replaced in place. */
function hideInConnections(rows: Array<Record<string, unknown>>, p: PrivacyFilter) {
  return rows.map((r) => ({
    ...r,
    ...(typeof r.host === 'string' ? { host: p.host(r.host) } : {}),
    ...(typeof r.user === 'string' ? { user: p.user(r.user) } : {}),
    ...(typeof r.name === 'string' ? { name: p.text(r.name) } : {}),
    ...(typeof r.database === 'string' ? { database: p.text(r.database) } : {}),
  }));
}

// ── the bundle ───────────────────────────────────────────────────────────

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function readme(input: SupportBundleInput, hidden: boolean): string {
  return [
    'Plasma support bundle',
    `Created ${input.generatedAt} by Plasma ${input.app.version}.`,
    '',
    'What is in it',
    '  system.json       app, operating system and versions',
    '  settings.json     your preferences, minus secrets and anything',
    '                    you wrote',
    '  connections.json  saved connections: engine, host, port, database,',
    '                    user, TLS and SSH settings (no passwords or keys)',
    '  logs/             recent log lines of the app and its database',
    '                    worker',
    '  errors.txt        the most recent error lines from those logs',
    '',
    'What is never in it',
    '  Query results, row data, SQL you wrote or ran (history, snippets,',
    '  saved queries, tabs), passwords, private keys, API keys, tokens',
    '  and connection-string secrets.',
    '',
    ...(hidden
      ? [
          'Host names, IP addresses, user names and e-mail addresses were',
          'replaced with placeholders (host-1, user-1, ...).',
        ]
      : [
          'Host names and user names are included. Create the bundle again',
          'with "Also hide host names and user names" to remove them.',
        ]),
    '',
    'Plasma does not send this file anywhere. You decide who gets it.',
    '',
  ].join('\n');
}

const encoder = new TextEncoder();

function file(name: string, description: string, text: string): SupportBundleFile {
  // Every file ends with one newline, so it reads and diffs like a text file.
  const body = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return { name, description, text: body, bytes: encoder.encode(body).length };
}

/**
 * Build the bundle's files. Every file passes through the same filters: secrets
 * always, SQL-looking log lines always, hosts and users when asked.
 */
export function buildSupportBundle(
  input: SupportBundleInput,
  options: SupportBundleOptions,
): SupportBundleFile[] {
  const privacy = options.redactHostsAndUsers
    ? createPrivacyFilter(collectIdentities(input.connections, input.settings, input.osUser))
    : null;
  const finish = (text: string): string => {
    const clean = redactSecrets(text);
    return privacy ? privacy.text(clean) : clean;
  };

  const mainLog = scrubLogLines(redactSecrets(tailLines(input.mainLog, MAIN_LOG_LINES)));
  const mainOld = scrubLogLines(redactSecrets(tailLines(input.mainLogOld ?? '', MAIN_LOG_LINES)));
  const worker = scrubLogLines(redactSecrets(tailLines(input.workerLog, WORKER_LOG_LINES)));
  const update = input.updateHelperLog
    ? scrubLogLines(redactSecrets(tailLines(input.updateHelperLog, UPDATE_LOG_LINES)))
    : null;

  let connections = sanitizeConnections(input.connections);
  if (privacy) connections = hideInConnections(connections, privacy);
  const settings = sanitizeSettings(input.settings);

  const files: SupportBundleFile[] = [
    file('README.txt', 'What this bundle is and is not', finish(readme(input, privacy !== null))),
    file(
      'system.json',
      'App, operating system and versions',
      finish(
        json({
          createdAt: input.generatedAt,
          app: {
            name: input.app.name,
            version: input.app.version,
            packaged: input.app.packaged,
            locale: input.app.locale,
          },
          system: {
            platform: input.app.platform,
            arch: input.app.arch,
            osRelease: input.app.osRelease,
          },
          runtime: {
            electron: input.app.electron,
            chrome: input.app.chrome,
            node: input.app.node,
          },
          activeConnection: input.active
            ? { engine: input.active.engine, serverVersion: input.active.serverVersion }
            : null,
        }),
      ),
    ),
    file(
      'settings.json',
      'Your preferences, without secrets and without anything you wrote',
      finish(json(settings)),
    ),
    file(
      'connections.json',
      'Saved connections: no passwords, keys or tokens',
      finish(json(connections)),
    ),
    file(
      'logs/main.log',
      `Last ${MAIN_LOG_LINES.toLocaleString('en-US')} lines of the app log`,
      finish(mainLog),
    ),
  ];
  if (mainOld.trim()) {
    files.push(file('logs/main.old.log', 'The app log before the last rotation', finish(mainOld)));
  }
  files.push(
    file(
      'logs/worker.log',
      'What the database worker printed since Plasma started',
      finish(worker),
    ),
  );
  if (update !== null) {
    files.push(
      file(
        'logs/update-helper.log',
        `Last ${UPDATE_LOG_LINES} lines of the update helper log`,
        finish(update),
      ),
    );
  }
  files.push(
    file(
      'errors.txt',
      'The most recent error lines from the logs',
      finish(recentErrors([mainOld, mainLog, worker])),
    ),
  );
  return files;
}

export function totalBytes(files: readonly SupportBundleFile[]): number {
  return files.reduce((n, f) => n + f.bytes, 0);
}
