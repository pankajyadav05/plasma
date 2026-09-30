import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createGunzip } from 'node:zlib';
import {
  type AdminJobEvent,
  type PgTool,
  type ToolInfo,
  type ToolInvocation,
  parseToolMajor,
  toolCandidates,
} from '@shared/pg-backup';
import { logger } from './logger';

/**
 * Runs pg_dump / pg_restore / psql as child processes.
 *
 * Always `spawn(binary, argsArray)` with `shell: false` — the argv comes
 * from `pg-backup.ts` builders, never from a concatenated string. The
 * password travels in PGPASSWORD only.
 */

const TOOLS: readonly PgTool[] = ['pg_dump', 'pg_restore', 'psql'];

function usualDirs(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/opt/homebrew/opt/libpq/bin',
      '/usr/local/opt/libpq/bin',
      '/Applications/Postgres.app/Contents/Versions/latest/bin',
    ];
  }
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    return ['18', '17', '16', '15', '14'].map((v) => `${pf}\\PostgreSQL\\${v}\\bin`);
  }
  return ['18', '17', '16', '15', '14', '13']
    .map((v) => `/usr/lib/postgresql/${v}/bin`)
    .concat(`${homedir()}/.local/bin`);
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function resolveTool(tool: PgTool, binDir: string): Promise<string | null> {
  for (const candidate of toolCandidates(
    tool,
    binDir,
    process.env.PATH ?? '',
    process.platform,
    usualDirs(),
  )) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function versionOf(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(path, ['--version'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim().split('\n')[0] ?? '');
    });
  });
}

export async function detectTools(binDir: string): Promise<ToolInfo[]> {
  return Promise.all(
    TOOLS.map(async (tool): Promise<ToolInfo> => {
      const path = await resolveTool(tool, binDir);
      if (!path) return { tool, path: null, version: null, major: null };
      try {
        const version = await versionOf(path);
        return { tool, path, version, major: parseToolMajor(version) };
      } catch (err) {
        return {
          tool,
          path,
          version: null,
          major: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

interface Job {
  child: ChildProcess;
  canceled: boolean;
}

const jobs = new Map<string, Job>();

export interface RunJobOptions {
  invocation: ToolInvocation;
  binDir: string;
  emit: (event: AdminJobEvent) => void;
  /** Feed this file to the child's stdin (gunzipped when `gunzip`). */
  stdinFile?: { path: string; gunzip: boolean };
  /** Backup: stat this path when the process succeeds. */
  outputPath?: string;
}

/** Split a chunk into whole lines, keeping the unfinished tail. */
export function takeLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (buffer + chunk).split(/\r?\n|\r/);
  const rest = parts.pop() ?? '';
  return { lines: parts.filter((l) => l !== ''), rest };
}

export async function startJob(opts: RunJobOptions): Promise<string> {
  const { invocation, emit } = opts;
  const bin = await resolveTool(invocation.tool, opts.binDir);
  if (!bin) {
    throw new Error(
      `${invocation.tool} was not found. Install the PostgreSQL client tools or set their folder in Settings → Advanced.`,
    );
  }
  const jobId = randomUUID();
  const child = spawn(bin, invocation.args, {
    env: { ...process.env, ...invocation.env },
    shell: false,
    windowsHide: true,
    stdio: [opts.stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const job: Job = { child, canceled: false };
  jobs.set(jobId, job);

  const buffers = { out: '', err: '' };
  const pump = (key: 'out' | 'err') => (data: Buffer) => {
    const { lines, rest } = takeLines(buffers[key], data.toString('utf8'));
    buffers[key] = rest;
    if (lines.length) emit({ jobId, type: 'log', text: lines.join('\n') });
  };
  child.stdout?.on('data', pump('out'));
  child.stderr?.on('data', pump('err'));

  let settled = false;
  const finish = (ev: Omit<Extract<AdminJobEvent, { type: 'done' }>, 'jobId' | 'type'>) => {
    if (settled) return;
    settled = true;
    jobs.delete(jobId);
    for (const key of ['out', 'err'] as const) {
      if (buffers[key].trim()) emit({ jobId, type: 'log', text: buffers[key] });
    }
    emit({ jobId, type: 'done', ...ev });
  };

  child.on('error', (err) => {
    finish({ ok: false, canceled: false, exitCode: null, message: err.message });
  });
  child.on('close', async (code) => {
    const canceled = job.canceled;
    let bytes: number | undefined;
    if (code === 0 && opts.outputPath) {
      try {
        const st = await stat(opts.outputPath);
        bytes = st.isDirectory() ? undefined : st.size;
      } catch {
        /* output not readable */
      }
    }
    finish({
      ok: code === 0 && !canceled,
      canceled,
      exitCode: code,
      message: canceled
        ? 'Canceled.'
        : code === 0
          ? null
          : `${invocation.tool} exited with code ${code}.`,
      ...(bytes !== undefined ? { bytes } : {}),
    });
  });

  if (opts.stdinFile && child.stdin) {
    const stdin = child.stdin;
    stdin.on('error', () => undefined); // child exited early (EPIPE)
    const src = createReadStream(opts.stdinFile.path);
    src.on('error', (err) => {
      emit({ jobId, type: 'log', text: `Cannot read ${opts.stdinFile?.path}: ${err.message}` });
      child.kill();
    });
    if (opts.stdinFile.gunzip) {
      const gz = createGunzip();
      gz.on('error', (err) => {
        emit({ jobId, type: 'log', text: `Cannot decompress: ${err.message}` });
        child.kill();
      });
      src.pipe(gz).pipe(stdin);
    } else {
      src.pipe(stdin);
    }
  }
  logger.info(`[plasma] started ${invocation.display}`);
  return jobId;
}

export function cancelJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.canceled = true;
  job.child.kill('SIGTERM');
  // A wedged child gets SIGKILL after a grace period.
  setTimeout(() => {
    if (jobs.has(jobId)) job.child.kill('SIGKILL');
  }, 5000).unref();
  return true;
}

export function cancelAllJobs(): void {
  for (const id of [...jobs.keys()]) cancelJob(id);
}
