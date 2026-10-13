import { type ChildProcess, spawn } from 'node:child_process';

/**
 * One CLI child process: argv array (never a shell), stdout cut into lines with
 * a size cap, a short stderr tail, a hard timeout and a kill that takes the whole
 * process group with it. Nothing the child prints is logged.
 */

export const CLI_HARD_TIMEOUT_MS = 10 * 60_000;
export const CLI_MAX_LINE_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_CHARS = 1_500;

export interface CliExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The last bit of stderr; for building an error message only. */
  stderrTail: string;
  /** Set when the program could not be started at all. */
  spawnError?: string;
  timedOut: boolean;
  aborted: boolean;
  /** Lines that were longer than the cap and skipped. */
  skippedLines: number;
}

export interface CliProcess {
  readonly pid: number | undefined;
  write(obj: unknown): void;
  closeStdin(): void;
  kill(): void;
  done: Promise<CliExit>;
}

export interface SpawnOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxLineBytes?: number;
  onLine(line: string): void;
}

export function killTree(child: ChildProcess, force: boolean): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

export function spawnCli(opts: SpawnOptions): CliProcess {
  const maxLine = opts.maxLineBytes ?? CLI_MAX_LINE_BYTES;
  let timedOut = false;
  let aborted = false;
  let skippedLines = 0;
  let stderrTail = '';
  let spawnError: string | undefined;

  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    killTree(child, false);
    killTimer ??= setTimeout(() => killTree(child, true), 2_000);
    killTimer.unref?.();
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs ?? CLI_HARD_TIMEOUT_MS);
  timeout.unref?.();

  const onAbort = () => {
    aborted = true;
    kill();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });

  // stdout → lines
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let skipping = false;
  child.stdout.on('data', (chunk: Buffer) => {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl === -1) {
        const rest = chunk.subarray(start);
        if (!skipping) {
          pendingBytes += rest.length;
          if (pendingBytes > maxLine) {
            skipping = true;
            skippedLines++;
            pending = [];
            pendingBytes = 0;
          } else pending.push(rest);
        }
        return;
      }
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (skipping) {
        skipping = false;
        continue;
      }
      if (pendingBytes + piece.length > maxLine) {
        skippedLines++;
      } else {
        const line = Buffer.concat([...pending, piece])
          .toString('utf8')
          .replace(/\r$/, '');
        if (line) opts.onLine(line);
      }
      pending = [];
      pendingBytes = 0;
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
  });
  child.stdin.on('error', () => undefined);

  const done = new Promise<CliExit>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      // A final line without a newline.
      if (pendingBytes > 0 && !skipping) {
        const line = Buffer.concat(pending).toString('utf8').replace(/\r$/, '');
        if (line) opts.onLine(line);
      }
      // Nothing of the group may outlive the run.
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* group already empty */
        }
      }
      resolve({
        code,
        signal,
        stderrTail,
        ...(spawnError ? { spawnError } : {}),
        timedOut,
        aborted,
        skippedLines,
      });
    };
    child.once('error', (err: NodeJS.ErrnoException) => {
      spawnError = err.code ?? err.message;
      finish(null, null);
    });
    child.once('close', finish);
  });

  return {
    pid: child.pid,
    write(obj) {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(obj)}\n`);
    },
    closeStdin() {
      if (child.stdin.writable) child.stdin.end();
    },
    kill,
    done,
  };
}

/** The environment a CLI child gets: ours, minus what must not leak into it. */
export function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('PLASMA_')) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}
