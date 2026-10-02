import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

/**
 * SC-16: a plain `.sql` restore is fed to `psql`, whose backslash
 * meta-commands can run shell commands (`\! cmd`, `\o |cmd`, `\g |cmd`,
 * `\copy … program`, backticks in any command's arguments) or read other
 * local files (`\i`). A backup from someone else is untrusted input, so the
 * whole script is scanned BEFORE psql starts (nothing runs on a refusal),
 * and any meta-command that is not one `pg_dump` itself emits is refused.
 *
 * Plain SQL is still arbitrary SQL — that is why the restore dialog warns
 * about it — but it can no longer reach the user's shell.
 */

/** Meta-commands a pg_dump script contains, at the start of a line. */
const ALLOWED_LINE_START = /^\\(?:connect(?:\s|$)|c\s|restrict\s|unrestrict\s|\.\s*$)/;
/**
 * COPY text data lines may start with a backslash escape. These are
 * data (or harmless), never a command that executes anything.
 */
const DATA_ESCAPE_START = /^\\(?:N|\\|[bfnrtv0-7]|x[0-9A-Fa-f])/;

/** Dangerous meta-commands anywhere on a line (they may follow SQL: `SELECT 1 \! id`). */
const MIDLINE_SHELL = /\\(?:!|(?:g|gx|o|w)\s*\|)|\\copy\b[^\n]*\bprogram\b/i;
/** A backslash command followed by backticks: psql runs the backticked text in a shell. */
const BACKTICK_ARGS = /\\[A-Za-z]+[^\n]*`/;

export type PsqlScriptProblem = { line: number; text: string; reason: string };

/** Judge one script line; null = fine. */
export function judgePsqlLine(line: string): string | null {
  const trimmed = line.replace(/^\s+/, '');
  if (trimmed.startsWith('\\') && !ALLOWED_LINE_START.test(trimmed)) {
    if (!DATA_ESCAPE_START.test(trimmed)) {
      return `psql meta-command ${trimmed.split(/\s/, 1)[0]} is not allowed in a restore`;
    }
  }
  if (MIDLINE_SHELL.test(line)) return 'it would run a shell command through psql';
  if (BACKTICK_ARGS.test(line)) return 'a psql command with backticks would run a shell command';
  return null;
}

/** Scan a whole script file; resolves with the first problem, or null. */
export async function scanPsqlScript(
  path: string,
  gunzip: boolean,
): Promise<PsqlScriptProblem | null> {
  const src = createReadStream(path);
  const stream = gunzip ? src.pipe(createGunzip()) : src;
  src.on('error', () => stream.destroy());
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let n = 0;
  try {
    for await (const line of rl) {
      n++;
      const reason = judgePsqlLine(line);
      if (reason) {
        return { line: n, text: line.length > 120 ? `${line.slice(0, 120)}…` : line, reason };
      }
    }
  } finally {
    rl.close();
    src.destroy();
  }
  return null;
}

export function describePsqlProblem(p: PsqlScriptProblem): string {
  return `Restore refused: line ${p.line} (${p.text.trim()}) — ${p.reason}. Review the script, or run it yourself in psql if you trust it.`;
}
