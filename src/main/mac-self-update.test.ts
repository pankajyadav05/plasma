import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type FetchBody,
  type RunCommand,
  STAGE_MARKER,
  buildHelperScript,
  checkBundleInfo,
  downloadVerified,
  findAppBundle,
  launchHelper,
  macInstallEligibility,
  pickMacZip,
  readBundleInfo,
  removePendingDownloads,
  removeStages,
  shQuote,
  stageUpdate,
} from './mac-self-update';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plasma-macself-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('findAppBundle', () => {
  it('resolves the .app from the executable path', () => {
    expect(findAppBundle('/Applications/Plasma.app/Contents/MacOS/Plasma')).toBe(
      '/Applications/Plasma.app',
    );
    expect(findAppBundle('/Users/a b/Apps/Plasma.app/Contents/MacOS/Plasma')).toBe(
      '/Users/a b/Apps/Plasma.app',
    );
  });
  it('is null outside a bundle', () => {
    expect(findAppBundle('/usr/local/bin/node')).toBeNull();
    expect(findAppBundle('/.app/x')).toBeNull();
  });
});

describe('macInstallEligibility', () => {
  const bundle = '/Applications/Plasma.app';
  it('allows a writable install in Applications', () => {
    expect(macInstallEligibility({ bundlePath: bundle, writability: 'writable' })).toEqual({
      ok: true,
    });
  });
  it('refuses an App-Translocated copy', () => {
    const r = macInstallEligibility({
      bundlePath: '/private/var/folders/xy/T/AppTranslocation/ABC-123/d/Plasma.app',
      writability: 'writable',
    });
    expect(r).toEqual({
      ok: false,
      reason: 'Move Plasma to Applications to get automatic updates.',
    });
  });
  it('refuses a read-only volume such as a mounted dmg', () => {
    const r = macInstallEligibility({
      bundlePath: '/Volumes/Plasma/Plasma.app',
      writability: 'read-only',
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('Move Plasma to Applications');
  });
  it('refuses an app whose own files the user cannot delete', () => {
    const r = macInstallEligibility({
      bundlePath: bundle,
      writability: 'writable',
      bundleWritable: false,
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('Move Plasma to Applications');
  });

  it('refuses a folder the user cannot write to, and an unknown bundle', () => {
    const denied = macInstallEligibility({ bundlePath: bundle, writability: 'denied' });
    expect(denied.ok).toBe(false);
    expect((denied as { reason: string }).reason).toContain('/Applications');
    expect(macInstallEligibility({ bundlePath: null, writability: 'writable' }).ok).toBe(false);
  });
});

describe('pickMacZip', () => {
  const files = [
    { url: 'Plasma-3.2.2-arm64.dmg', sha512: 'a' },
    { url: 'Plasma-3.2.2-arm64.zip', sha512: 'b', size: 5 },
  ];
  it('takes the arm64 zip of this exact version', () => {
    expect(pickMacZip(files, '3.2.2', 'arm64')?.sha512).toBe('b');
  });
  it('refuses other versions, other architectures and non-plain names', () => {
    expect(pickMacZip(files, '3.2.3', 'arm64')).toBeNull();
    expect(pickMacZip(files, '3.2.2', 'x64')).toBeNull();
    expect(
      pickMacZip([{ url: '../x/Plasma-3.2.2-arm64.zip', sha512: 'b' }], '3.2.2', 'arm64'),
    ).toBeNull();
    expect(
      pickMacZip([{ url: 'https://evil/Plasma-3.2.2-arm64.zip', sha512: 'b' }], '3.2.2', 'arm64'),
    ).toBeNull();
  });
});

function body(parts: Buffer[], over: Partial<FetchBody> = {}): () => Promise<FetchBody> {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: (async function* () {
      for (const p of parts) yield p;
    })(),
    ...over,
  });
}
const sha = (b: Buffer) => createHash('sha512').update(b).digest('base64');

describe('downloadVerified', () => {
  const data = Buffer.from('zip bytes zip bytes');

  it('streams to the final name only when the sha512 matches the signed one', async () => {
    const dest = join(dir, 'pending', 'Plasma-3.2.2-arm64.zip');
    const seen: number[] = [];
    await downloadVerified({
      url: 'https://cdn.example.com/Plasma-3.2.2-arm64.zip',
      dest,
      sha512: sha(data),
      size: data.length,
      fetchImpl: body([data.subarray(0, 5), data.subarray(5)]),
      onProgress: (p) => seen.push(p.percent),
      now: () => 1_000_000,
    });
    expect(readFileSync(dest)).toEqual(data);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(seen.at(-1)).toBe(100);
  });

  it('deletes a download whose hash differs and never creates the final file', async () => {
    const dest = join(dir, 'z.zip');
    await expect(
      downloadVerified({
        url: 'https://cdn.example.com/z.zip',
        dest,
        sha512: sha(Buffer.from('other')),
        fetchImpl: body([data]),
      }),
    ).rejects.toThrow(/sha512/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('stops a stream that outgrows the signed size', async () => {
    const dest = join(dir, 'z.zip');
    await expect(
      downloadVerified({
        url: 'https://cdn.example.com/z.zip',
        dest,
        sha512: sha(data),
        size: 4,
        fetchImpl: body([data]),
      }),
    ).rejects.toThrow(/larger/);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('gives up on a stalled connection instead of waiting forever', async () => {
    const dest = join(dir, 'stall.zip');
    const hang = async (_url: string, signal: AbortSignal): Promise<FetchBody> => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: (async function* () {
        yield data.subarray(0, 3);
        await new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      })(),
    });
    await expect(
      downloadVerified({
        url: 'https://cdn.example.com/z.zip',
        dest,
        sha512: sha(data),
        fetchImpl: hang,
        idleTimeoutMs: 40,
      }),
    ).rejects.toThrow(/stalled/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes to a part file of its own, so two downloads never share one', async () => {
    const dest = join(dir, 'two.zip');
    let seen: string[] = [];
    const slow = async (): Promise<FetchBody> => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: (async function* () {
        yield data.subarray(0, 4);
        seen = readdirSync(dir);
        yield data.subarray(4);
      })(),
    });
    await downloadVerified({
      url: 'https://cdn.example.com/z.zip',
      dest,
      sha512: sha(data),
      fetchImpl: slow,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^two\.zip\.[0-9a-f]{8}\.part$/);
  });

  it('refuses plain http and error responses', async () => {
    await expect(
      downloadVerified({ url: 'http://cdn.example.com/z.zip', dest: join(dir, 'a'), sha512: 'x' }),
    ).rejects.toThrow(/https/);
    await expect(
      downloadVerified({
        url: 'https://cdn.example.com/z.zip',
        dest: join(dir, 'b'),
        sha512: 'x',
        fetchImpl: body([], { ok: false, status: 404 }),
      }),
    ).rejects.toThrow(/404/);
  });
});

describe('checkBundleInfo', () => {
  const expected = { identifier: 'sh.plasma.app', version: '3.2.2' };
  it('accepts the expected bundle', () => {
    expect(checkBundleInfo({ identifier: 'sh.plasma.app', version: '3.2.2' }, expected)).toBeNull();
  });
  it('refuses another identifier, another version and an unreadable plist', () => {
    expect(checkBundleInfo({ identifier: 'com.evil.app', version: '3.2.2' }, expected)).toMatch(
      /com\.evil\.app/,
    );
    expect(checkBundleInfo({ identifier: 'sh.plasma.app', version: '3.2.1' }, expected)).toMatch(
      /3\.2\.1/,
    );
    expect(checkBundleInfo({ identifier: null, version: null }, expected)).not.toBeNull();
    expect(checkBundleInfo(null, expected)).toMatch(/Info\.plist/);
  });
});

/** A `run` that fakes ditto / plutil / codesign for a bundle with the given plist. */
function fakeRun(opts: {
  identifier?: string;
  version?: string;
  codesign?: number;
  apps?: string[];
  ditto?: number;
}): RunCommand {
  return async (cmd, args) => {
    if (cmd.endsWith('ditto')) {
      const target = args[3] as string;
      for (const app of opts.apps ?? ['Plasma.app'])
        mkdirSync(join(target, app, 'Contents'), { recursive: true });
      return { code: opts.ditto ?? 0, stdout: '', stderr: '' };
    }
    if (cmd.endsWith('plutil')) {
      return {
        code: 0,
        stdout: JSON.stringify({
          CFBundleIdentifier: opts.identifier ?? 'sh.plasma.app',
          CFBundleShortVersionString: opts.version ?? '3.2.2',
        }),
        stderr: '',
      };
    }
    if (cmd.endsWith('codesign')) {
      expect(args.slice(0, 3)).toEqual(['--verify', '--deep', '--strict']);
      return {
        code: opts.codesign ?? 0,
        stdout: '',
        stderr: opts.codesign ? 'invalid signature' : '',
      };
    }
    throw new Error(`unexpected command ${cmd}`);
  };
}

describe('stageUpdate', () => {
  const base = () => ({
    zipPath: join(dir, 'Plasma-3.2.2-arm64.zip'),
    stageRoot: join(dir, 'pending-update'),
    version: '3.2.2',
    expectedIdentifier: 'sh.plasma.app',
  });
  const leftovers = () => (existsSync(base().stageRoot) ? readdirSync(base().stageRoot) : []);

  it('unpacks, checks and returns a staged bundle that carries our marker', async () => {
    const staged = await stageUpdate({ ...base(), run: fakeRun({}) });
    expect(staged.bundle).toBe(join(staged.stageDir, 'Plasma.app'));
    expect(existsSync(join(staged.stageDir, STAGE_MARKER))).toBe(true);
  });

  it('refuses a bundle with another identifier and removes what it unpacked', async () => {
    await expect(
      stageUpdate({ ...base(), run: fakeRun({ identifier: 'com.evil.app' }) }),
    ).rejects.toThrow(/com\.evil\.app/);
    expect(leftovers()).toEqual([]);
  });

  it('refuses a bundle whose version is not the one the manifest announced', async () => {
    await expect(stageUpdate({ ...base(), run: fakeRun({ version: '3.1.0' }) })).rejects.toThrow(
      /version 3\.1\.0/,
    );
    expect(leftovers()).toEqual([]);
  });

  it('refuses a bundle that fails codesign verification', async () => {
    await expect(stageUpdate({ ...base(), run: fakeRun({ codesign: 1 }) })).rejects.toThrow(
      /codesign verification/,
    );
    expect(leftovers()).toEqual([]);
  });

  it('refuses an archive that does not hold exactly one app, or does not unpack', async () => {
    await expect(
      stageUpdate({ ...base(), run: fakeRun({ apps: ['Plasma.app', 'Other.app'] }) }),
    ).rejects.toThrow(/exactly one/);
    await expect(stageUpdate({ ...base(), run: fakeRun({ ditto: 1 }) })).rejects.toThrow(/ditto/);
    expect(leftovers()).toEqual([]);
  });

  it('reads the two Info.plist keys from plutil output', async () => {
    expect(await readBundleInfo('/x/Plasma.app', fakeRun({}))).toEqual({
      identifier: 'sh.plasma.app',
      version: '3.2.2',
    });
    expect(
      await readBundleInfo('/x/Plasma.app', async () => ({ code: 1, stdout: '', stderr: 'no' })),
    ).toBeNull();
  });
});

describe('shQuote', () => {
  it('survives spaces, quotes, dollars and backticks in a real shell', () => {
    for (const nasty of ['a b', "it's", `"dq"`, '$HOME `id` $(id)', "'; rm -rf / #", 'new\nline']) {
      const r = spawnSync('/bin/sh', ['-c', `printf %s ${shQuote(nasty)}`], { encoding: 'utf8' });
      expect(r.stdout).toBe(nasty);
    }
  });
  it('rejects NUL', () => {
    expect(() => shQuote('a\0b')).toThrow();
  });
});

describe('buildHelperScript', () => {
  const plan = {
    pid: 4242,
    oldBundle: "/Applications/Pla'sma $1.app",
    newBundle: '/u/pending-update/stage-1/Plasma.app',
    stageDir: '/u/pending-update/stage-1',
    stageRoot: '/u/pending-update',
    id: '1700000000abcd',
  };

  it('embeds every path as a single-quoted literal', () => {
    const script = buildHelperScript(plan);
    expect(script).toContain(`OLD='/Applications/Pla'\\''sma $1.app'`);
    expect(script).toContain(`BACKUP='/Applications/Pla'\\''sma $1.app.old-1700000000abcd'`);
    expect(script).toContain(`PID='4242'`);
    expect(script.startsWith('#!/bin/sh')).toBe(true);
  });

  it('is valid shell', () => {
    const file = join(dir, 'helper.sh');
    writeFileSync(file, buildHelperScript(plan));
    expect(spawnSync('/bin/sh', ['-n', file]).status).toBe(0);
  });

  it('only ever removes names it derived, through a guard', () => {
    const script = buildHelperScript(plan);
    const rms = script.split('\n').filter((l) => /\brm -rf\b/.test(l));
    expect(rms).toEqual(['  rm -rf -- "$1"']);
    const calls = script.split('\n').filter((l) => l.includes('safe_rm "'));
    for (const c of calls)
      expect(c).toMatch(/safe_rm "\$(BACKUP|FRESH|BAD|STAGE)" "\$(PARENT|STAGE_ROOT)"/);
  });

  it('rejects an invalid pid or id', () => {
    expect(() => buildHelperScript({ ...plan, pid: 1 })).toThrow();
    expect(() => buildHelperScript({ ...plan, id: 'x; rm -rf /' })).toThrow();
  });
});

/** Runs the real script under /bin/sh against a scratch "Applications" folder. */
describe('the helper, executed', () => {
  let apps: string;
  let stageRoot: string;
  let stageDir: string;
  let tools: string;
  let log: string;
  let deadPid: number;
  const oldName = "Plasma x'y.app";

  function fakeTool(name: string, body: string): string {
    const p = join(tools, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  function run(
    opts: {
      openExit?: number;
      pid?: number;
      newExists?: boolean;
      marker?: boolean;
      root?: string;
      wait?: number;
    } = {},
  ) {
    if (opts.newExists !== false) {
      mkdirSync(join(stageDir, 'Plasma.app', 'Contents'), { recursive: true });
      writeFileSync(join(stageDir, 'Plasma.app', 'Contents', 'version'), 'new');
    }
    if (opts.marker !== false) writeFileSync(join(stageDir, STAGE_MARKER), '3.2.2\n');
    const oldBundle = join(apps, oldName);
    const script = buildHelperScript({
      pid: opts.pid ?? deadPid,
      oldBundle,
      newBundle: join(stageDir, 'Plasma.app'),
      stageDir,
      stageRoot: opts.root ?? stageRoot,
      id: '42',
      waitHalfSeconds: opts.wait ?? 4,
      tools: {
        open: fakeTool('open', `echo "open $*" >> '${log}'; exit \${OPEN_EXIT:-0}`),
        xattr: fakeTool('xattr', `echo "xattr $*" >> '${log}'`),
        ditto: fakeTool('ditto', `echo "ditto $*" >> '${log}'; cp -R "$1" "$2"`),
      },
    });
    const file = join(dir, 'helper.sh');
    writeFileSync(file, script);
    const r = spawnSync('/bin/sh', [file], {
      encoding: 'utf8',
      env: { ...process.env, OPEN_EXIT: String(opts.openExit ?? 0) },
    });
    return { status: r.status, out: r.stdout + r.stderr, oldBundle };
  }

  beforeEach(() => {
    apps = join(dir, 'Apps folder');
    stageRoot = join(dir, 'pending-update');
    stageDir = join(stageRoot, 'stage-3.2.2-deadbeef');
    tools = join(dir, 'tools');
    log = join(dir, 'calls.log');
    mkdirSync(join(apps, oldName, 'Contents'), { recursive: true });
    writeFileSync(join(apps, oldName, 'Contents', 'version'), 'old');
    writeFileSync(join(apps, 'precious.txt'), 'not ours');
    mkdirSync(join(apps, 'Other.app'));
    mkdirSync(stageDir, { recursive: true });
    mkdirSync(tools);
    deadPid = spawnSync('/bin/true').pid ?? 999999;
  });

  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');

  it('swaps the bundle, opens the new one and removes only what it created', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(readFileSync(join(r.oldBundle, 'Contents', 'version'), 'utf8')).toBe('new');
    // old backup, temp copy and staging folder are gone; everything else is untouched
    expect(readdirSync(apps).sort()).toEqual(['Other.app', "Plasma x'y.app", 'precious.txt']);
    expect(existsSync(stageDir)).toBe(false);
    expect(existsSync(stageRoot)).toBe(true);
    expect(calls()).toContain(`xattr -dr com.apple.quarantine ${r.oldBundle}`);
    expect(calls()).toContain(`open -n ${r.oldBundle}`);
  });

  it('puts the old app back and reopens it when the new one does not open', () => {
    const r = run({ openExit: 1 });
    expect(r.status).toBe(1);
    expect(readFileSync(join(r.oldBundle, 'Contents', 'version'), 'utf8')).toBe('old');
    expect(readdirSync(apps).sort()).toEqual(['Other.app', "Plasma x'y.app", 'precious.txt']);
    expect(calls().match(/open -n/g)?.length).toBe(2);
  });

  it('leaves the installed app alone when the staged bundle is gone, and reopens it', () => {
    const r = run({ newExists: false });
    expect(r.status).toBe(1);
    expect(readFileSync(join(r.oldBundle, 'Contents', 'version'), 'utf8')).toBe('old');
    expect(calls()).toContain('open -n');
  });

  it('does not touch the staging folder when it lacks our marker', () => {
    const r = run({ marker: false });
    expect(r.status).toBe(0);
    expect(existsSync(stageDir)).toBe(true);
  });

  it('refuses to remove a staging folder outside the staging root', () => {
    const r = run({ root: join(dir, 'somewhere-else') });
    expect(r.status).toBe(0);
    expect(r.out).toContain('refusing to remove');
    expect(existsSync(stageDir)).toBe(true);
  });

  it('cleans up even when the app folder has ".." in a name', () => {
    const odd = join(dir, 'my..apps');
    mkdirSync(join(odd, 'Plasma.app', 'Contents'), { recursive: true });
    writeFileSync(join(odd, 'Plasma.app', 'Contents', 'version'), 'old');
    mkdirSync(join(stageDir, 'Plasma.app', 'Contents'), { recursive: true });
    writeFileSync(join(stageDir, 'Plasma.app', 'Contents', 'version'), 'new');
    writeFileSync(join(stageDir, STAGE_MARKER), 'x');
    const file = join(dir, 'odd.sh');
    writeFileSync(
      file,
      buildHelperScript({
        pid: deadPid,
        oldBundle: join(odd, 'Plasma.app'),
        newBundle: join(stageDir, 'Plasma.app'),
        stageDir,
        stageRoot,
        id: '7',
        waitHalfSeconds: 2,
        tools: {
          open: fakeTool('open', 'exit 0'),
          xattr: fakeTool('xattr', 'exit 0'),
          ditto: fakeTool('ditto', 'exit 1'),
        },
      }),
    );
    expect(spawnSync('/bin/sh', [file]).status).toBe(0);
    expect(readdirSync(odd)).toEqual(['Plasma.app']);
    expect(readFileSync(join(odd, 'Plasma.app', 'Contents', 'version'), 'utf8')).toBe('new');
  });

  it('does not swap a bundle that is running again', () => {
    const exe = join(apps, oldName, 'Contents', 'MacOS');
    mkdirSync(exe, { recursive: true });
    writeFileSync(join(exe, 'Plasma'), '#!/bin/sh\nsleep 20\n', { mode: 0o755 });
    const child = spawn(join(exe, 'Plasma'), [], { stdio: 'ignore' });
    try {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.out).toContain('running again');
      expect(readFileSync(join(r.oldBundle, 'Contents', 'version'), 'utf8')).toBe('old');
      expect(calls()).toBe('');
    } finally {
      child.kill();
    }
  });

  it('keeps no copy of the old app in the Applications folder', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(readdirSync(apps).filter((n) => /\.(old|new|bad)-/.test(n))).toEqual([]);
  });

  it('gives up without changing anything when the app does not quit in time', () => {
    const r = run({ pid: process.pid, wait: 1 });
    expect(r.status).toBe(1);
    expect(readFileSync(join(r.oldBundle, 'Contents', 'version'), 'utf8')).toBe('old');
    expect(existsSync(join(stageDir, 'Plasma.app'))).toBe(true);
    expect(calls()).toBe('');
  });
});

describe('removePendingDownloads', () => {
  it('removes our zips and staging folders and nothing else', () => {
    const root = join(dir, 'pending-update');
    mkdirSync(join(root, 'stage-3.2.2-0123abcd'), { recursive: true });
    mkdirSync(join(root, 'mine'));
    writeFileSync(join(root, 'Plasma-3.2.2-arm64.zip'), 'z');
    writeFileSync(join(root, 'Plasma-3.2.2-arm64.zip.part'), 'z');
    writeFileSync(join(root, 'keep.txt'), 'k');
    removePendingDownloads(root);
    expect(readdirSync(root).sort()).toEqual(['keep.txt', 'mine']);
    removePendingDownloads(join(dir, 'does-not-exist'));
  });

  it('can keep the zip that is current, and can drop only the staging folders', () => {
    const root = join(dir, 'pending-update');
    mkdirSync(join(root, 'stage-3.2.2-0123abcd'), { recursive: true });
    writeFileSync(join(root, 'Plasma-3.2.1-arm64.zip'), 'old');
    writeFileSync(join(root, 'Plasma-3.2.2-arm64.zip'), 'current');
    removeStages(root);
    expect(readdirSync(root).sort()).toEqual(['Plasma-3.2.1-arm64.zip', 'Plasma-3.2.2-arm64.zip']);
    removePendingDownloads(root, 'Plasma-3.2.2-arm64.zip');
    expect(readdirSync(root)).toEqual(['Plasma-3.2.2-arm64.zip']);
  });
});

describe('launchHelper', () => {
  it('starts the helper detached and returns its pid', async () => {
    const stage = join(dir, 'stage');
    mkdirSync(stage);
    const log = join(dir, 'logs', 'helper.log');
    const pid = launchHelper({
      script: '#!/bin/sh\necho started\n',
      stageDir: stage,
      logPath: log,
    });
    expect(pid).toBeGreaterThan(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(readFileSync(log, 'utf8')).toContain('started');
  });
});
