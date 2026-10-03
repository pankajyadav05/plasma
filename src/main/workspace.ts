import { createHash } from 'node:crypto';
import {
  type FSWatcher,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ConnectionConfig } from '@shared/protocol';
import type { SnippetDef } from '@shared/snippets';
import {
  CONNECTIONS_FILE,
  InterpolationError,
  MAX_WORKSPACE_FILES,
  MAX_WORKSPACE_FILE_BYTES,
  NOTEBOOKS_DIR,
  NOTEBOOK_SUFFIX,
  QUERIES_DIR,
  type RecentWorkspace,
  type ResolvedProfile,
  SNIPPETS_FILE,
  WORKSPACE_DIR,
  type WorkspaceNotebook,
  type WorkspaceNotebookView,
  type WorkspaceProfile,
  type WorkspaceProfileView,
  type WorkspaceQuery,
  type WorkspaceQueryView,
  type WorkspaceQueryWrite,
  type WorkspaceSnapshot,
  type WorkspaceWriteResult,
  newQueryPath,
  notebookFileName,
  parseConnectionsFile,
  parseNotebookFile,
  parseQueryFile,
  parseSnippetsFile,
  parseWorkspaceConnectionId,
  profileNeedsPassword,
  resolveProfile,
  serializeNotebookFile,
  serializeQueryFile,
  serializeSnippetsFile,
  workspaceConnectionId,
  workspacePasswordKey,
} from '@shared/workspace';
import {
  PathConfinementError,
  assertFileName,
  assertQueryRelPath,
  confineToRoot,
} from './workspace-paths';

export interface WorkspaceDeps {
  env: Readonly<Record<string, string | undefined>>;
  getSecret(key: string): string | null;
  putSecret(key: string, value: string): void;
  hasSecret(key: string): boolean;
  /** A SQLite file inside the workspace may be opened by a profile. */
  allowSqlitePath(path: string): void;
  /** Debounced notification that something under `.plasma/` changed. */
  onChange(): void;
  debounceMs?: number;
}

const sha = (text: string): string => createHash('sha1').update(text).digest('hex');
const rev = (text: string): string => sha(text).slice(0, 16);

function readText(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_WORKSPACE_FILE_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Write via a temp file in the same directory so readers never see half a file. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

export function workspaceIdForRoot(realRoot: string): string {
  return sha(realRoot).slice(0, 12);
}

export class WorkspaceService {
  private root: string | null = null;
  private id = '';
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: WorkspaceDeps) {}

  get isOpen(): boolean {
    return this.root !== null;
  }

  get workspaceId(): string | null {
    return this.root ? this.id : null;
  }

  get rootPath(): string | null {
    return this.root;
  }

  /** `root` must already be user-approved (dialog, recents, confirmed deep link). */
  open(root: string): WorkspaceSnapshot {
    if (typeof root !== 'string' || root.includes('\0')) throw new Error('Invalid folder');
    const real = realpathSync(root);
    if (!statSync(real).isDirectory()) throw new Error('Not a folder');
    this.close();
    this.root = real;
    this.id = workspaceIdForRoot(real);
    this.startWatch();
    return this.snapshot();
  }

  close(): void {
    this.stopWatch();
    this.root = null;
    this.id = '';
  }

  private need(): string {
    if (!this.root) throw new Error('No workspace is open');
    return this.root;
  }

  private dir(...parts: string[]): string {
    return confineToRoot(this.need(), join(WORKSPACE_DIR, ...parts));
  }

  // ── reading ──

  snapshot(): WorkspaceSnapshot {
    const root = this.need();
    const problems: string[] = [];

    const connText = readText(this.dir(CONNECTIONS_FILE));
    const profiles = connText === null ? [] : this.readProfiles(connText, problems);

    const queries = this.readQueries(problems);

    const snipText = readText(this.dir(SNIPPETS_FILE));
    let snippets: SnippetDef[] = [];
    if (snipText !== null) {
      const parsed = parseSnippetsFile(snipText);
      snippets = parsed.snippets;
      problems.push(...parsed.problems);
    }

    return {
      id: this.id,
      name: basename(root),
      root,
      profiles: profiles.map((p) => this.profileView(p)),
      queries,
      snippets,
      snippetsRev: snipText === null ? '' : rev(snipText),
      notebooks: this.readNotebooks(),
      problems,
    };
  }

  private readProfiles(text: string, problems: string[]): WorkspaceProfile[] {
    const parsed = parseConnectionsFile(text);
    problems.push(...parsed.problems);
    return parsed.profiles;
  }

  private readQueries(problems: string[]): WorkspaceQueryView[] {
    const base = this.dir(QUERIES_DIR);
    const out: WorkspaceQueryView[] = [];
    let count = 0;
    const walk = (abs: string, relDir: string): void => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (count >= MAX_WORKSPACE_FILES) {
          problems.push(`More than ${MAX_WORKSPACE_FILES} query files; the rest are ignored`);
          return;
        }
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        // Dirent.isFile/isDirectory are false for symlinks: links are never followed.
        if (e.isDirectory()) walk(join(abs, e.name), rel);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.sql')) {
          const text = readText(join(abs, e.name));
          if (text === null) continue;
          count++;
          const q: WorkspaceQuery = parseQueryFile(rel, text);
          out.push({ ...q, rev: rev(text) });
        }
      }
    };
    walk(base, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  private readNotebooks(): WorkspaceNotebookView[] {
    const base = this.dir(NOTEBOOKS_DIR);
    let names: string[] = [];
    try {
      names = readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(NOTEBOOK_SUFFIX))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
    const out: WorkspaceNotebookView[] = [];
    for (const file of names.slice(0, MAX_WORKSPACE_FILES)) {
      const text = readText(join(base, file));
      const nb = text === null ? null : parseNotebookFile(text);
      if (!nb || text === null) continue;
      out.push({
        file,
        name: nb.name,
        ...(nb.connection ? { connection: nb.connection } : {}),
        cellCount: nb.cells.length,
        rev: rev(text),
      });
    }
    return out;
  }

  private profileView(p: WorkspaceProfile): WorkspaceProfileView {
    const key = workspacePasswordKey(this.id, p.id);
    const stored = this.deps.hasSecret(key) || this.deps.hasSecret(`${key}:none`);
    const base = {
      id: p.id,
      name: p.name,
      engine: p.engine,
      ...(p.group ? { group: p.group } : {}),
      ...(p.tag ? { tag: p.tag } : {}),
      readOnly: p.readOnly ?? false,
      hasPassword: this.deps.hasSecret(key),
      needsPassword: profileNeedsPassword(p.engine) && !stored,
    };
    try {
      const r = resolveProfile(p, this.deps.env);
      return { ...base, name: r.name, summary: summarize(r) };
    } catch (err) {
      return { ...base, summary: '', error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── connecting ──

  private findProfile(profileId: string): WorkspaceProfile {
    const text = readText(this.dir(CONNECTIONS_FILE));
    const found =
      text === null
        ? undefined
        : parseConnectionsFile(text).profiles.find((p) => p.id === profileId);
    if (!found) throw new Error(`No workspace connection "${profileId}"`);
    return found;
  }

  /** The profile as a connection config (env resolved), never with a password. */
  profileConfig(profileId: string): { config: ConnectionConfig; needsPassword: boolean } {
    const profile = this.findProfile(profileId);
    const config = this.buildConfig(profile, '');
    const key = workspacePasswordKey(this.id, profileId);
    const stored = this.deps.hasSecret(key) || this.deps.hasSecret(`${key}:none`);
    return { config, needsPassword: profileNeedsPassword(profile.engine) && !stored };
  }

  /** Full config for `ConnectionConnect` of a `ws:` id: rebuilt from the file, password from the vault. */
  connectConfig(connectionId: string): ConnectionConfig {
    const parsed = parseWorkspaceConnectionId(connectionId);
    if (!parsed || parsed.workspaceId !== this.id || !this.root) {
      throw new Error('That workspace is not open');
    }
    const profile = this.findProfile(parsed.profileId);
    const password = this.deps.getSecret(workspacePasswordKey(this.id, profile.id)) ?? '';
    return this.buildConfig(profile, password);
  }

  private buildConfig(profile: WorkspaceProfile, password: string): ConnectionConfig {
    let r: ResolvedProfile;
    try {
      r = resolveProfile(profile, this.deps.env);
    } catch (err) {
      if (err instanceof InterpolationError) throw new Error(err.message);
      throw err;
    }
    let database = r.database;
    if (r.engine === 'sqlite' || r.engine === 'duckdb') {
      // A file-database profile names a file inside the workspace, relative to its root.
      const abs = confineToRoot(this.need(), database);
      if (r.engine === 'sqlite') this.deps.allowSqlitePath(abs);
      database = abs;
    }
    return {
      id: workspaceConnectionId(this.id, profile.id),
      name: r.name,
      engine: r.engine,
      host: r.host,
      port: r.port,
      database,
      user: r.user,
      password,
      ssl: r.ssl,
      ...(r.tlsMode ? { tls: { mode: r.tlsMode } } : {}),
      readOnly: r.readOnly,
      ...(r.group ? { group: r.group } : {}),
      ...(r.bootstrapSql ? { bootstrapSql: r.bootstrapSql } : {}),
    };
  }

  setPassword(profileId: string, password: string): void {
    const profile = this.findProfile(profileId);
    const key = workspacePasswordKey(this.id, profile.id);
    if (password) {
      this.deps.putSecret(key, password);
      this.deps.putSecret(`${key}:none`, '');
    } else {
      this.deps.putSecret(key, '');
      this.deps.putSecret(`${key}:none`, '1');
    }
  }

  // ── writing ──

  private currentRev(abs: string): string | null {
    const text = readText(abs);
    return text === null ? null : rev(text);
  }

  private write(
    abs: string,
    text: string,
    baseRev: string | null | undefined,
    overwrite?: boolean,
  ) {
    const current = this.currentRev(abs);
    const next = rev(text);
    if (!overwrite && current !== null && current !== (baseRev ?? null) && current !== next) {
      return { ok: false, conflict: true, currentRev: current } as const;
    }
    if (current !== next) writeAtomic(abs, text);
    return { ok: true, rev: next } as const;
  }

  writeQuery(req: WorkspaceQueryWrite): WorkspaceWriteResult {
    const queriesDir = this.dir(QUERIES_DIR);
    let path: string;
    if (req.path !== undefined) path = assertQueryRelPath(req.path);
    else {
      const taken = new Set(this.readQueries([]).map((q) => q.path));
      path = newQueryPath(req.name, req.folder ?? '', taken);
    }
    const abs = confineToRoot(queriesDir, path);
    const text = serializeQueryFile({
      name: req.name,
      description: req.description,
      connection: req.connection,
      variables: req.variables,
      sql: req.sql,
    });
    const res = this.write(abs, text, req.baseRev, req.overwrite);
    return res.ok ? { ok: true, rev: res.rev, path } : res;
  }

  deleteQuery(path: string): void {
    const abs = confineToRoot(this.dir(QUERIES_DIR), assertQueryRelPath(path));
    rmSync(abs, { force: true });
  }

  writeSnippets(
    snippets: SnippetDef[],
    baseRev: string | null,
    overwrite?: boolean,
  ): WorkspaceWriteResult {
    const abs = this.dir(SNIPPETS_FILE);
    const res = this.write(abs, serializeSnippetsFile(snippets), baseRev || null, overwrite);
    return res.ok ? { ok: true, rev: res.rev, path: SNIPPETS_FILE } : res;
  }

  writeNotebook(
    nb: WorkspaceNotebook,
    file: string | null,
    baseRev: string | null,
    overwrite?: boolean,
  ): WorkspaceWriteResult & { file?: string } {
    const dir = this.dir(NOTEBOOKS_DIR);
    let name: string;
    if (file) name = assertFileName(file, NOTEBOOK_SUFFIX);
    else {
      const stem = notebookFileName(nb.name).slice(0, -NOTEBOOK_SUFFIX.length);
      name = `${stem}${NOTEBOOK_SUFFIX}`;
      for (let n = 2; existsSync(join(dir, name)); n++) name = `${stem}-${n}${NOTEBOOK_SUFFIX}`;
    }
    const abs = confineToRoot(dir, name);
    const res = this.write(abs, serializeNotebookFile(nb), baseRev, overwrite);
    return res.ok ? { ok: true, rev: res.rev, path: name, file: name } : res;
  }

  readNotebook(file: string): WorkspaceNotebook | null {
    const abs = confineToRoot(this.dir(NOTEBOOKS_DIR), assertFileName(file, NOTEBOOK_SUFFIX));
    const text = readText(abs);
    return text === null ? null : parseNotebookFile(text);
  }

  // ── watching ──

  private startWatch(): void {
    this.stopWatch();
    const root = this.root;
    if (!root) return;
    const fire = (): void => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        // `.plasma/` may have appeared or vanished: watch again.
        if (this.root === root) this.startWatch();
        this.deps.onChange();
      }, this.deps.debounceMs ?? 250);
    };
    try {
      const wsDir = join(root, WORKSPACE_DIR);
      if (existsSync(wsDir)) {
        this.watchers.push(watch(wsDir, { recursive: true }, fire));
      } else {
        // Not there yet: notice when the folder itself is created.
        this.watchers.push(
          watch(root, (_evt, name) => {
            if (name === WORKSPACE_DIR) fire();
          }),
        );
      }
      for (const w of this.watchers) w.on('error', () => undefined);
    } catch {
      // Watching is best-effort; the user can still reopen the workspace.
    }
  }

  private stopWatch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}

function summarize(r: ResolvedProfile): string {
  if (r.engine === 'sqlite' || r.engine === 'duckdb') return r.database;
  const login = r.user ? `${r.user}@` : '';
  const db =
    r.database && (r.engine === 'postgres' || r.engine === 'mysql') ? `/${r.database}` : '';
  return `${login}${r.host}:${r.port}${db}`;
}

// ─── Recent workspaces ───────────────────────────────────────────────

const MAX_RECENTS = 8;

export class RecentWorkspaces {
  constructor(private readonly file: string) {}

  list(): RecentWorkspace[] {
    const text = readText(this.file);
    if (text === null) return [];
    try {
      const raw = JSON.parse(text) as { recents?: unknown };
      if (!Array.isArray(raw.recents)) return [];
      return raw.recents
        .filter(
          (r): r is RecentWorkspace =>
            !!r &&
            typeof (r as RecentWorkspace).path === 'string' &&
            typeof (r as RecentWorkspace).name === 'string',
        )
        .slice(0, MAX_RECENTS);
    } catch {
      return [];
    }
  }

  has(path: string): boolean {
    return this.list().some((r) => r.path === path);
  }

  add(path: string): RecentWorkspace[] {
    const next = [
      { path, name: basename(path) },
      ...this.list().filter((r) => r.path !== path),
    ].slice(0, MAX_RECENTS);
    return this.save(next);
  }

  remove(path: string): RecentWorkspace[] {
    return this.save(this.list().filter((r) => r.path !== path));
  }

  private save(recents: RecentWorkspace[]): RecentWorkspace[] {
    try {
      writeAtomic(this.file, `${JSON.stringify({ version: 1, recents }, null, 2)}\n`);
    } catch {
      // Recents are a convenience.
    }
    return recents;
  }
}

export { PathConfinementError };
