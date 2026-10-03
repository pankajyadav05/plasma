import { statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  type CliAction,
  type LaunchAction,
  cliActionsFromArgv,
  deepLinksFromArgv,
  looksLikeConnectionUrl,
  parseDeepLink,
  parseTargetTable,
  prefillFromConnectionUrl,
  redactSecrets,
} from '@shared/deep-link';
import { formatFromPath } from '@shared/import-parse';

/**
 * D2 — turns everything that can ask Plasma to do something from outside
 * (`plasma://` links, `open-url`, second-instance argv, the launcher's
 * flags) into `LaunchAction`s for the renderer, or opens a workspace.
 *
 * Links are untrusted: `connect` only pre-fills a dialog, a workspace link
 * is confirmed first. The launcher's `--plasma-*` flags come from the local
 * command line and skip that confirmation.
 */

export interface LaunchDeps {
  /** Ask the user whether to open this folder as a workspace. */
  confirmWorkspace(path: string): Promise<boolean>;
  openWorkspace(path: string): void;
  /** SQLite file named on the command line: main allows the connection to open it. */
  allowSqlitePath(path: string): void;
  sqliteFileProblem(path: string): string | null;
  /** A data file named on the command line may be read by the importer. */
  allowImportPath(path: string): void;
  /** Deliver to the renderer; false when it is not ready to receive. */
  send(action: LaunchAction): boolean;
  focusWindow(): void;
  log(message: string): void;
}

export class LaunchRouter {
  private pending: LaunchAction[] = [];
  private ready = false;

  constructor(private readonly deps: LaunchDeps) {}

  /** The renderer asks for what it missed and starts receiving live. */
  takePending(): LaunchAction[] {
    this.ready = true;
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** The window went away (macOS keeps the app alive); queue until a new one loads. */
  rendererGone(): void {
    this.ready = false;
  }

  private deliver(action: LaunchAction): void {
    if (this.ready && this.deps.send(action)) return;
    this.pending.push(action);
  }

  /** argv of this process (first launch) or of a second instance. */
  async handleArgv(argv: readonly string[], cwd?: string): Promise<void> {
    for (const link of deepLinksFromArgv(argv)) await this.handleUrl(link);
    for (const action of cliActionsFromArgv(argv)) await this.handleCli(action, cwd);
  }

  /** A `plasma://` URL (macOS `open-url`, or an argv entry). */
  async handleUrl(raw: string): Promise<void> {
    // Never log the raw link: it may carry a password.
    this.deps.log(`deep link received: ${redactSecrets(raw).slice(0, 200)}`);
    const parsed = parseDeepLink(raw);
    this.deps.focusWindow();
    if (parsed.kind === 'invalid') {
      this.deliver({ kind: 'error', message: parsed.message });
      return;
    }
    if (parsed.kind === 'connect') {
      this.deliver({ kind: 'connect', prefill: parsed.prefill });
      return;
    }
    if (!(await this.deps.confirmWorkspace(parsed.path))) return;
    this.openWorkspaceFolder(parsed.path);
  }

  private openWorkspaceFolder(path: string): void {
    try {
      if (!statSync(path).isDirectory()) throw new Error('not a folder');
      this.deps.openWorkspace(path);
      this.deliver({ kind: 'workspace' });
    } catch (err) {
      this.deliver({
        kind: 'error',
        message: `Could not open the workspace folder: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async handleCli(action: CliAction, cwd?: string): Promise<void> {
    this.deps.focusWindow();
    if (action.kind === 'open') {
      this.openTarget(action.target, cwd);
      return;
    }
    this.importFile(action, cwd);
  }

  private abs(p: string, cwd?: string): string {
    return isAbsolute(p) ? p : resolve(cwd ?? process.cwd(), p);
  }

  private openTarget(target: string, cwd?: string): void {
    if (target.toLowerCase().startsWith('plasma://')) {
      void this.handleUrl(target);
      return;
    }
    if (looksLikeConnectionUrl(target)) {
      try {
        this.deliver({ kind: 'connect', prefill: prefillFromConnectionUrl(target) });
      } catch (err) {
        this.deliver({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    const path = this.abs(target, cwd);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      this.deliver({ kind: 'error', message: `Nothing to open at ${path}` });
      return;
    }
    if (isDir) {
      this.openWorkspaceFolder(path);
      return;
    }
    const problem = this.deps.sqliteFileProblem(path);
    if (problem) {
      this.deliver({ kind: 'error', message: `${basename(path)}: ${problem}` });
      return;
    }
    this.deps.allowSqlitePath(path);
    this.deliver({
      kind: 'connect',
      prefill: {
        name: basename(path),
        engine: 'sqlite',
        host: 'localhost',
        port: 1,
        database: path,
        user: '',
        password: '',
        ssl: false,
        readOnly: false,
      },
    });
  }

  private importFile(action: Extract<CliAction, { kind: 'import' }>, cwd?: string): void {
    const path = this.abs(action.file, cwd);
    const target = parseTargetTable(action.table);
    if (!target) {
      this.deliver({ kind: 'error', message: `"${action.table}" is not a table name` });
      return;
    }
    let size: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      this.deliver({ kind: 'error', message: `Cannot read ${path}` });
      return;
    }
    let into: ReturnType<typeof prefillFromConnectionUrl>;
    try {
      into = prefillFromConnectionUrl(action.into);
    } catch (err) {
      this.deliver({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.deps.allowImportPath(path);
    this.deliver({
      kind: 'import',
      file: { path, name: basename(path), size, format: formatFromPath(path) },
      into,
      schema: target.schema,
      table: target.table,
    });
  }
}
