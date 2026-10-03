import { parseConnectionUrl } from './connection-url';
import type { ConnectionConfig, ConnectionEngine, ImportPickedFile } from './protocol';

/**
 * D2 — `plasma://` deep links and the command-line arguments the `plasma`
 * launcher passes. Everything here is pure: parsing and validation only.
 *
 *   plasma://connect?url=<connection-url>&name=<label>&readonly=1
 *   plasma://open?workspace=<absolute folder>
 *
 * A link is untrusted input (any web page can fire one), so `connect` only
 * ever PRE-FILLS the New Connection dialog and `open?workspace` is confirmed
 * by the user in main before anything is opened.
 */

export const DEEP_LINK_SCHEME = 'plasma:';
const MAX_LINK_LENGTH = 4096;
const MAX_NAME_LENGTH = 80;

/** What the New Connection dialog is filled with. The password is a separate field, never part of a URL. */
export interface ConnectionPrefill {
  name: string;
  engine: ConnectionEngine;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  tls?: ConnectionConfig['tls'];
  readOnly: boolean;
}

export type DeepLinkAction =
  | { kind: 'connect'; prefill: ConnectionPrefill }
  | { kind: 'workspace'; path: string };

export type DeepLinkResult = DeepLinkAction | { kind: 'invalid'; message: string };

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

/** Build the dialog prefill from a connection URL string. Throws a readable Error. */
export function prefillFromConnectionUrl(
  url: string,
  opts: { name?: string; readOnly?: boolean } = {},
): ConnectionPrefill {
  const parsed = parseConnectionUrl(url);
  const name = (opts.name ?? '').trim().slice(0, MAX_NAME_LENGTH);
  return {
    name: name || parsed.host,
    engine: parsed.engine,
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    // Credentials in the URL end up in the password field only.
    password: parsed.password,
    ssl: parsed.ssl,
    ...(parsed.tls ? { tls: parsed.tls } : {}),
    readOnly: opts.readOnly === true,
  };
}

/** Is this argument a Plasma deep link? */
export function isDeepLink(arg: string): boolean {
  return arg.slice(0, DEEP_LINK_SCHEME.length + 2).toLowerCase() === 'plasma://';
}

export function parseDeepLink(raw: string): DeepLinkResult {
  const text = raw.trim();
  if (!isDeepLink(text)) return { kind: 'invalid', message: 'Not a plasma:// link' };
  if (text.length > MAX_LINK_LENGTH) return { kind: 'invalid', message: 'The link is too long' };
  if (text.includes('\0')) return { kind: 'invalid', message: 'The link is malformed' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { kind: 'invalid', message: 'The link is malformed' };
  }
  const action = url.hostname.toLowerCase();
  const params = url.searchParams;

  if (action === 'connect') {
    const target = params.get('url');
    if (!target) return { kind: 'invalid', message: 'The link has no connection url' };
    try {
      return {
        kind: 'connect',
        prefill: prefillFromConnectionUrl(target, {
          name: params.get('name') ?? undefined,
          readOnly: TRUE_VALUES.has((params.get('readonly') ?? '').toLowerCase()),
        }),
      };
    } catch (err) {
      return { kind: 'invalid', message: err instanceof Error ? err.message : String(err) };
    }
  }

  if (action === 'open') {
    const path = params.get('workspace');
    if (!path) return { kind: 'invalid', message: 'The link names no workspace folder' };
    if (path.includes('\0') || !isAbsolutePathText(path)) {
      return { kind: 'invalid', message: 'The workspace path must be absolute' };
    }
    return { kind: 'workspace', path };
  }

  return { kind: 'invalid', message: `Unknown link action "${action}"` };
}

function isAbsolutePathText(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** A copy of `text` that is safe to log: the password of any `scheme://user:pass@` becomes `***`. */
export function redactSecrets(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@?#]*):([^\s@/?#]*)@/gi, '$1:***@')
    .replace(/([a-z][a-z0-9+.-]*%3A%2F%2F[^\s:/@?#]*?)%3A([^\s@/?#]*?)%40/gi, '$1%3A***%40');
}

// ─── Command line ────────────────────────────────────────────────────

export type CliAction =
  | { kind: 'open'; target: string }
  | { kind: 'import'; file: string; into: string; table: string };

const OPEN_FLAG = '--plasma-open=';
const IMPORT_FLAG = '--plasma-import=';
const INTO_FLAG = '--plasma-into=';
const TABLE_FLAG = '--plasma-table=';

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(flag));
  return hit === undefined ? undefined : hit.slice(flag.length);
}

/** Deep-link arguments (protocol launches on Windows/Linux, `open-url` on macOS aside). */
export function deepLinksFromArgv(argv: readonly string[]): string[] {
  return argv.filter((a) => isDeepLink(a));
}

/**
 * The launcher's flags, from a process argv. These come from the local user's
 * own command line (a web page cannot add arguments to the app), unlike links.
 */
export function cliActionsFromArgv(argv: readonly string[]): CliAction[] {
  const actions: CliAction[] = [];
  const open = flagValue(argv, OPEN_FLAG);
  if (open) actions.push({ kind: 'open', target: open });
  const file = flagValue(argv, IMPORT_FLAG);
  const into = flagValue(argv, INTO_FLAG);
  const table = flagValue(argv, TABLE_FLAG);
  if (file && into && table) actions.push({ kind: 'import', file, into, table });
  return actions;
}

/** Is `target` a connection URL (as opposed to a path)? */
export function looksLikeConnectionUrl(target: string): boolean {
  return /^(postgres(ql)?|mysql|mariadb|redis|rediss|opensearch|https?):\/\//i.test(target.trim());
}

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,127}(\.[A-Za-z_][A-Za-z0-9_$]{0,127})?$/;

/** `schema.table` or `table`; null when it is not a plain identifier. */
export function parseTargetTable(text: string): { schema: string | null; table: string } | null {
  const t = text.trim();
  if (!TABLE_NAME_RE.test(t)) return null;
  const dot = t.indexOf('.');
  return dot === -1
    ? { schema: null, table: t }
    : { schema: t.slice(0, dot), table: t.slice(dot + 1) };
}

/** True when a prefill and a saved/active connection point at the same server and login. */
export function sameEndpoint(
  a: { host: string; port: number; database: string; user: string; engine?: string },
  b: { host: string; port: number; database: string; user: string; engine?: string },
): boolean {
  return (
    (a.engine ?? 'postgres') === (b.engine ?? 'postgres') &&
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.port === b.port &&
    a.database === b.database &&
    a.user === b.user
  );
}

/**
 * "Open connection string…": a pasted connection URL or `plasma://` link,
 * through the same validation as a real link. Workspace links are refused
 * here (they need main's confirmation).
 */
export function parsePasted(text: string): LaunchAction {
  const t = text.trim();
  if (isDeepLink(t)) {
    const r = parseDeepLink(t);
    if (r.kind === 'invalid') return { kind: 'error', message: r.message };
    if (r.kind === 'workspace') {
      return { kind: 'error', message: 'Use File > Open workspace folder for workspaces' };
    }
    return r;
  }
  try {
    return { kind: 'connect', prefill: prefillFromConnectionUrl(t) };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Actions pushed to the renderer ──────────────────────────────────

export type LaunchAction =
  | { kind: 'connect'; prefill: ConnectionPrefill }
  | {
      kind: 'import';
      file: ImportPickedFile;
      into: ConnectionPrefill | null;
      schema: string | null;
      table: string;
    }
  /** Main opened a workspace on the renderer's behalf; fetch `workspace.current()`. */
  | { kind: 'workspace' }
  | { kind: 'error'; message: string };

export interface DeepLinkApi {
  /** Actions that arrived before the renderer was listening; also marks it ready. */
  takePending(): Promise<LaunchAction[]>;
}

export interface CliApi {
  status(): Promise<CliInstallStatus>;
  /** Symlink the launcher into a PATH directory (macOS/Linux); the user confirms in a native dialog. */
  install(): Promise<CliInstallStatus>;
}

export interface CliInstallStatus {
  platform: 'darwin' | 'win32' | 'linux';
  /** Where the launcher script ships inside the app (empty in dev). */
  scriptPath: string;
  /** Where it is installed, if it is. */
  installedAt: string | null;
  /** Windows: how to put the launcher on PATH. */
  instructions: string | null;
  /** Result of the last install attempt. */
  message?: string;
}
