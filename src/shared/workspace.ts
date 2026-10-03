import { z } from 'zod';
import { ConnectionEngine, TlsMode } from './protocol';
import type { SnippetDef } from './snippets';
import type { VariableMode, VariableValue } from './sql-variables';

/**
 * D1 — team workspaces. A workspace is a folder holding a `.plasma/`
 * directory that is meant to be committed to git:
 *
 *   .plasma/connections.json            profiles, NEVER secrets
 *   .plasma/queries/**\/*.sql           saved queries (folders = groups)
 *   .plasma/snippets.json               editor snippets
 *   .plasma/notebooks/*.plasma-notebook.json
 *
 * Every writer here is deterministic (fixed key order, sorted lists, pretty
 * JSON, trailing newline, no timestamps) so saving an unchanged document
 * produces an identical file and diffs only show real edits.
 */

export const WORKSPACE_DIR = '.plasma';
export const WORKSPACE_FORMAT_VERSION = 1;
export const CONNECTIONS_FILE = 'connections.json';
export const SNIPPETS_FILE = 'snippets.json';
export const QUERIES_DIR = 'queries';
export const NOTEBOOKS_DIR = 'notebooks';
export const NOTEBOOK_SUFFIX = '.plasma-notebook.json';

/** Caps so a hostile or accidental repo cannot make the app read forever. */
export const MAX_WORKSPACE_FILES = 2000;
export const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;

export const ENV_TAGS = ['prod', 'staging', 'dev', 'local'] as const;
export type EnvTag = (typeof ENV_TAGS)[number];

// ─── connections.json ────────────────────────────────────────────────

const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Profile without secrets. String fields may hold `${ENV}` placeholders (resolved in main). */
export const WorkspaceProfile = z
  .object({
    id: z.string().regex(PROFILE_ID_RE, 'id: letters, digits, . _ - (max 64)'),
    name: z.string().min(1).max(120),
    engine: ConnectionEngine.default('postgres'),
    host: z.string().max(500).optional(),
    port: z.union([z.number().int().positive().max(65535), z.string().max(100)]).optional(),
    database: z.string().max(2000).optional(),
    user: z.string().max(500).optional(),
    ssl: z.boolean().optional(),
    tlsMode: TlsMode.optional(),
    readOnly: z.boolean().optional(),
    tag: z.enum(ENV_TAGS).optional(),
    group: z.string().max(120).optional(),
    bootstrapSql: z.string().max(10_000).optional(),
  })
  .strict();
export type WorkspaceProfile = z.infer<typeof WorkspaceProfile>;

/** Canonical key order of a profile in connections.json. */
const PROFILE_KEYS = [
  'id',
  'name',
  'engine',
  'group',
  'tag',
  'host',
  'port',
  'database',
  'user',
  'ssl',
  'tlsMode',
  'readOnly',
  'bootstrapSql',
] as const;

export function orderedProfile(p: WorkspaceProfile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PROFILE_KEYS) {
    const v = p[key];
    if (v !== undefined && v !== '') out[key] = v;
  }
  return out;
}

export interface ParsedConnectionsFile {
  profiles: WorkspaceProfile[];
  /** Human-readable problems; a bad profile is skipped, the rest still load. */
  problems: string[];
}

export function parseConnectionsFile(text: string): ParsedConnectionsFile {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { profiles: [], problems: ['connections.json is not valid JSON'] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { profiles: [], problems: ['connections.json must be an object'] };
  }
  const file = raw as { version?: unknown; connections?: unknown };
  if (file.version !== WORKSPACE_FORMAT_VERSION) {
    return {
      profiles: [],
      problems: [
        `connections.json has version ${JSON.stringify(file.version)}; this build reads version ${WORKSPACE_FORMAT_VERSION}`,
      ],
    };
  }
  if (!Array.isArray(file.connections)) {
    return { profiles: [], problems: ['connections.json: "connections" must be an array'] };
  }
  const seen = new Set<string>();
  const profiles: WorkspaceProfile[] = [];
  file.connections.forEach((entry, i) => {
    const label = `connections[${i}]`;
    if (entry && typeof entry === 'object' && 'password' in entry) {
      problems.push(`${label}: passwords must not be stored in .plasma/ — profile skipped`);
      return;
    }
    const parsed = WorkspaceProfile.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      problems.push(
        `${label}: ${issue?.path.join('.') || 'profile'} ${issue?.message ?? 'invalid'}`,
      );
      return;
    }
    if (seen.has(parsed.data.id)) {
      problems.push(`${label}: duplicate id "${parsed.data.id}" skipped`);
      return;
    }
    seen.add(parsed.data.id);
    profiles.push(parsed.data);
  });
  return { profiles, problems };
}

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function serializeConnectionsFile(profiles: readonly WorkspaceProfile[]): string {
  const sorted = [...profiles].sort((a, b) => a.id.localeCompare(b.id));
  return jsonFile({
    version: WORKSPACE_FORMAT_VERSION,
    connections: sorted.map(orderedProfile),
  });
}

// ─── ${ENV} interpolation ────────────────────────────────────────────

export class InterpolationError extends Error {
  constructor(readonly variable: string) {
    super(`Environment variable ${variable} is not set`);
    this.name = 'InterpolationError';
  }
}

const INTERP_RE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Replace `${NAME}` / `${NAME:-default}` from `env`. `$$` is a literal `$`
 * (so `$${NAME}` stays as text). It reads the given environment and nothing
 * else — never files, never commands — and values are not expanded again.
 */
export function interpolateEnv(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return text.replace(INTERP_RE, (match, name?: string, fallback?: string) => {
    if (match === '$$') return '$';
    const value = Object.hasOwn(env, name as string) ? env[name as string] : undefined;
    if (fallback !== undefined) return value === undefined || value === '' ? fallback : value;
    if (value === undefined) throw new InterpolationError(name as string);
    return value;
  });
}

export function hasInterpolation(text: string): boolean {
  return /\$\{[A-Za-z_]/.test(text);
}

export const DEFAULT_PORTS: Record<string, number> = {
  postgres: 5432,
  mysql: 3306,
  redis: 6379,
  opensearch: 9200,
  sqlite: 1,
  clickhouse: 8123,
  duckdb: 1,
};

/** A profile with env placeholders resolved; still no password. */
export interface ResolvedProfile {
  id: string;
  name: string;
  engine: ConnectionEngine;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  tlsMode?: TlsMode;
  readOnly: boolean;
  group?: string;
  bootstrapSql?: string;
}

export function resolveProfile(
  p: WorkspaceProfile,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedProfile {
  const sub = (v: string | undefined): string => (v === undefined ? '' : interpolateEnv(v, env));
  const portText = typeof p.port === 'number' ? String(p.port) : sub(p.port);
  const port = portText.trim() === '' ? (DEFAULT_PORTS[p.engine] ?? 5432) : Number(portText.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Profile "${p.id}": port "${portText}" is not a valid port`);
  }
  const host = sub(p.host).trim();
  if (p.engine !== 'sqlite' && p.engine !== 'duckdb' && !host)
    throw new Error(`Profile "${p.id}": host is empty`);
  return {
    id: p.id,
    name: sub(p.name) || p.id,
    engine: p.engine,
    host: p.engine === 'sqlite' || p.engine === 'duckdb' ? 'localhost' : host,
    port,
    database: sub(p.database),
    user: sub(p.user),
    ssl: p.ssl ?? false,
    ...(p.tlsMode ? { tlsMode: p.tlsMode } : {}),
    readOnly: p.readOnly ?? false,
    ...(p.group ? { group: p.group } : {}),
    ...(p.bootstrapSql ? { bootstrapSql: sub(p.bootstrapSql) } : {}),
  };
}

/** Connection ids of workspace profiles are `ws:<workspaceId>:<profileId>`. */
export function workspaceConnectionId(workspaceId: string, profileId: string): string {
  return `ws:${workspaceId}:${profileId}`;
}

export function parseWorkspaceConnectionId(
  id: string,
): { workspaceId: string; profileId: string } | null {
  const m = /^ws:([a-f0-9]{12}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(id);
  return m ? { workspaceId: m[1] as string, profileId: m[2] as string } : null;
}

export function workspacePasswordKey(workspaceId: string, profileId: string): string {
  return `ws:${workspaceId}:${profileId}:password`;
}

/** Engines that connect without a password prompt (files). */
export function profileNeedsPassword(engine: ConnectionEngine): boolean {
  return engine !== 'sqlite' && engine !== 'duckdb';
}

// ─── queries/**/*.sql ────────────────────────────────────────────────

export const QUERY_MARKER = '-- plasma:query';

export interface WorkspaceQuery {
  /** Path under `.plasma/queries/`, posix separators, ends with `.sql`. */
  path: string;
  name: string;
  description?: string;
  /** Profile id this query is meant for. */
  connection?: string;
  /** Default values of the query's variables. */
  variables: Record<string, VariableValue>;
  sql: string;
}

const VAR_MODES: readonly VariableMode[] = ['text', 'number', 'date', 'boolean', 'null', 'raw'];

function singleLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

export function fileBaseName(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.replace(/\.sql$/i, '');
}

export function parseQueryFile(path: string, text: string): WorkspaceQuery {
  const lines = normalizeNewlines(text.replace(/^﻿/, '')).split('\n');
  const fallback: WorkspaceQuery = {
    path,
    name: fileBaseName(path),
    variables: {},
    sql: lines.join('\n').replace(/\s+$/, ''),
  };
  if (lines[0]?.trim() !== QUERY_MARKER) return fallback;

  let name: string | undefined;
  let description: string | undefined;
  let connection: string | undefined;
  const variables: Record<string, VariableValue> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    const field = /^--\s*(name|description|connection):[ \t]?(.*)$/.exec(line);
    if (field) {
      const value = (field[2] as string).trim();
      if (field[1] === 'name') name = value;
      else if (field[1] === 'description') description = value;
      else connection = value;
      continue;
    }
    const variable = /^--\s*var\s+([A-Za-z_][A-Za-z0-9_]*):[ \t]*(\{.*\})\s*$/.exec(line);
    if (variable) {
      try {
        const v = JSON.parse(variable[2] as string) as { mode?: unknown; value?: unknown };
        if (VAR_MODES.includes(v.mode as VariableMode) && typeof v.value === 'string') {
          variables[variable[1] as string] = { mode: v.mode as VariableMode, value: v.value };
        }
      } catch {
        // A malformed variable line is dropped; the query itself still loads.
      }
      continue;
    }
    break;
  }
  // Exactly one blank line separates the header from the body.
  if (lines[i] === '') i++;
  return {
    path,
    name: name || fileBaseName(path),
    ...(description ? { description } : {}),
    ...(connection ? { connection } : {}),
    variables,
    sql: lines.slice(i).join('\n').replace(/\s+$/, ''),
  };
}

export function serializeQueryFile(q: Omit<WorkspaceQuery, 'path'>): string {
  const out: string[] = [QUERY_MARKER, `-- name: ${singleLine(q.name)}`];
  if (q.description) out.push(`-- description: ${singleLine(q.description)}`);
  if (q.connection) out.push(`-- connection: ${singleLine(q.connection)}`);
  for (const key of Object.keys(q.variables).sort()) {
    const v = q.variables[key] as VariableValue;
    out.push(`-- var ${key}: ${JSON.stringify({ mode: v.mode, value: v.value })}`);
  }
  out.push('');
  const body = normalizeNewlines(q.sql).replace(/\s+$/, '');
  return `${out.join('\n')}\n${body}${body ? '\n' : ''}`;
}

/** Lower-case, filesystem-safe file stem for a query name. */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'query';
}

/** Where a new query called `name` in `folder` lives (unique among `taken`). */
export function newQueryPath(name: string, folder: string, taken: ReadonlySet<string>): string {
  const dir = folder
    .split(/[\\/]+/)
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map(slugify)
    .join('/');
  const prefix = dir ? `${dir}/` : '';
  const stem = slugify(name);
  let candidate = `${prefix}${stem}.sql`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${prefix}${stem}-${n}.sql`;
  return candidate;
}

export interface QueryTreeNode {
  folders: Array<{ name: string; path: string; node: QueryTreeNode }>;
  queries: WorkspaceQuery[];
}

/** Folders (sorted) then queries (sorted by name) — folders are the groups. */
export function buildQueryTree(queries: readonly WorkspaceQuery[]): QueryTreeNode {
  const root: QueryTreeNode = { folders: [], queries: [] };
  for (const q of queries) {
    const parts = q.path.split('/');
    parts.pop();
    let node = root;
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.folders.find((f) => f.name === part);
      if (!child) {
        child = { name: part, path: acc, node: { folders: [], queries: [] } };
        node.folders.push(child);
      }
      node = child.node;
    }
    node.queries.push(q);
  }
  const sort = (n: QueryTreeNode): void => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name));
    n.queries.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    for (const f of n.folders) sort(f.node);
  };
  sort(root);
  return root;
}

// ─── snippets.json ───────────────────────────────────────────────────

const SnippetEntry = z.object({
  name: z.string().min(1).max(120),
  prefix: z.string().min(1).max(60),
  description: z.string().max(500).default(''),
  body: z.string().max(100_000),
});

export function parseSnippetsFile(text: string): { snippets: SnippetDef[]; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { snippets: [], problems: ['snippets.json is not valid JSON'] };
  }
  const file = raw as { version?: unknown; snippets?: unknown } | null;
  if (!file || file.version !== WORKSPACE_FORMAT_VERSION || !Array.isArray(file.snippets)) {
    return {
      snippets: [],
      problems: [
        `snippets.json must be {"version": ${WORKSPACE_FORMAT_VERSION}, "snippets": [...]}`,
      ],
    };
  }
  const problems: string[] = [];
  const snippets: SnippetDef[] = [];
  file.snippets.forEach((entry, i) => {
    const parsed = SnippetEntry.safeParse(entry);
    if (parsed.success) snippets.push(parsed.data);
    else problems.push(`snippets[${i}]: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  });
  return { snippets, problems };
}

export function serializeSnippetsFile(snippets: readonly SnippetDef[]): string {
  const sorted = [...snippets].sort(
    (a, b) => a.prefix.localeCompare(b.prefix) || a.name.localeCompare(b.name),
  );
  return jsonFile({
    version: WORKSPACE_FORMAT_VERSION,
    snippets: sorted.map((s) => ({
      name: s.name,
      prefix: s.prefix,
      description: s.description,
      body: s.body,
    })),
  });
}

// ─── notebooks/*.plasma-notebook.json ────────────────────────────────

export interface WorkspaceNotebook {
  name: string;
  connection?: string;
  cells: Array<{ id: string; kind: 'sql' | 'md'; content: string }>;
}

const NotebookFile = z.object({
  version: z.literal(WORKSPACE_FORMAT_VERSION),
  name: z.string().min(1).max(200),
  connection: z.string().max(100).optional(),
  cells: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        kind: z.enum(['sql', 'md']),
        content: z.string().max(500_000),
      }),
    )
    .max(500),
});

export function parseNotebookFile(text: string): WorkspaceNotebook | null {
  try {
    const parsed = NotebookFile.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    const { name, connection, cells } = parsed.data;
    return { name, ...(connection ? { connection } : {}), cells };
  } catch {
    return null;
  }
}

export function serializeNotebookFile(nb: WorkspaceNotebook): string {
  return jsonFile({
    version: WORKSPACE_FORMAT_VERSION,
    name: nb.name,
    ...(nb.connection ? { connection: nb.connection } : {}),
    cells: nb.cells.map((c) => ({ id: c.id, kind: c.kind, content: c.content })),
  });
}

export function notebookFileName(name: string): string {
  return `${slugify(name)}${NOTEBOOK_SUFFIX}`;
}

// ─── IPC shapes shared by main, preload and the renderer ─────────────

export const WorkspaceChannel = {
  OpenDialog: 'plasma:workspace:openDialog',
  OpenRecent: 'plasma:workspace:openRecent',
  Close: 'plasma:workspace:close',
  Current: 'plasma:workspace:current',
  Recents: 'plasma:workspace:recents',
  ForgetRecent: 'plasma:workspace:forgetRecent',
  WriteQuery: 'plasma:workspace:writeQuery',
  DeleteQuery: 'plasma:workspace:deleteQuery',
  WriteSnippets: 'plasma:workspace:writeSnippets',
  WriteNotebook: 'plasma:workspace:writeNotebook',
  ReadNotebook: 'plasma:workspace:readNotebook',
  ProfileConfig: 'plasma:workspace:profileConfig',
  SetPassword: 'plasma:workspace:setPassword',
  /** Push: the folder changed on disk (or was opened/closed). Payload: snapshot or null. */
  ChangedEvent: 'plasma:workspace:changed',
  LaunchTake: 'plasma:launch:take',
  /** Push: a link / launcher request arrived. Payload: LaunchAction. */
  LaunchEvent: 'plasma:launch:action',
  CliStatus: 'plasma:cli:status',
  CliInstall: 'plasma:cli:install',
} as const;

export interface WorkspaceProfileView {
  id: string;
  name: string;
  engine: ConnectionEngine;
  group?: string;
  tag?: EnvTag;
  readOnly: boolean;
  /** `user@host:port/db` style summary with env placeholders already resolved; empty when unresolved. */
  summary: string;
  /** Set when env interpolation failed (e.g. the variable is missing). */
  error?: string;
  /** A password for this profile is already in the vault. */
  hasPassword: boolean;
  needsPassword: boolean;
}

export interface WorkspaceQueryView extends WorkspaceQuery {
  /** Content hash; send it back as `baseRev` when saving to detect external edits. */
  rev: string;
}

export interface WorkspaceNotebookView {
  file: string;
  name: string;
  connection?: string;
  cellCount: number;
  rev: string;
}

export interface WorkspaceSnapshot {
  id: string;
  name: string;
  root: string;
  profiles: WorkspaceProfileView[];
  queries: WorkspaceQueryView[];
  snippets: SnippetDef[];
  snippetsRev: string;
  notebooks: WorkspaceNotebookView[];
  problems: string[];
}

export interface RecentWorkspace {
  path: string;
  name: string;
}

export type WorkspaceWriteResult =
  | { ok: true; rev: string; path: string }
  | { ok: false; conflict: true; currentRev: string | null };

export interface WorkspaceQueryWrite {
  /** Existing path to update, or omit to create from `name` + `folder`. */
  path?: string;
  folder?: string;
  name: string;
  description?: string;
  connection?: string;
  variables: Record<string, VariableValue>;
  sql: string;
  /** Rev the editor last saw; null/undefined for a brand-new file. */
  baseRev?: string | null;
  overwrite?: boolean;
}

export interface WorkspaceApi {
  /** Native folder picker; main allowlists the choice. Null when cancelled. */
  openDialog(): Promise<WorkspaceSnapshot | null>;
  openRecent(path: string): Promise<WorkspaceSnapshot | null>;
  close(): Promise<void>;
  current(): Promise<WorkspaceSnapshot | null>;
  recents(): Promise<RecentWorkspace[]>;
  forgetRecent(path: string): Promise<RecentWorkspace[]>;
  writeQuery(req: WorkspaceQueryWrite): Promise<WorkspaceWriteResult>;
  deleteQuery(path: string): Promise<void>;
  writeSnippets(
    snippets: SnippetDef[],
    baseRev: string | null,
    overwrite?: boolean,
  ): Promise<WorkspaceWriteResult>;
  writeNotebook(
    nb: WorkspaceNotebook,
    file: string | null,
    baseRev: string | null,
    overwrite?: boolean,
  ): Promise<WorkspaceWriteResult & { file?: string }>;
  readNotebook(file: string): Promise<WorkspaceNotebook | null>;
  /** The profile as a ConnectionConfig for `conn.connect` (env resolved in main, no password). */
  profileConfig(
    profileId: string,
  ): Promise<{ config: import('./protocol').ConnectionConfig; needsPassword: boolean }>;
  setPassword(profileId: string, password: string): Promise<void>;
}
