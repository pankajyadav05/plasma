import {
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
import type { RecoveryJournal } from '@shared/recovery';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MARKER_FILE,
  RecoveryRuntime,
  beginSession,
  endSession,
  readPending,
  resolvePending,
  saveJournal,
  stageJournal,
  writeFileAtomic,
} from './session-recovery';

const NOW = Date.now();
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plasma-recovery-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const info = (over: Partial<Parameters<typeof beginSession>[1]> = {}) => ({
  version: '3.2.2',
  now: 1_000,
  pid: 42,
  updateRestart: false,
  ...over,
});

const journal = (over: Partial<RecoveryJournal> = {}): RecoveryJournal => ({
  v: 1,
  savedAt: NOW,
  connectionId: 'c1',
  txnActive: false,
  strip: { v: 1, activeIndex: 0, tabs: [{ kind: 'sql', title: 'query-1.sql', sql: 'select 1' }] },
  edits: [],
  ...over,
});

const emptyJournal = (id = 'c1') =>
  journal({
    connectionId: id,
    strip: { v: 1, activeIndex: 0, tabs: [{ kind: 'sql', title: 'q', sql: '' }] },
  });

const live = () => join(dir, 'recovery', 'journal.json');

describe('session marker', () => {
  it('first run and a clean quit are not crashes', () => {
    expect(beginSession(dir, info()).previous.kind).toBe('clean');
    endSession(dir);
    expect(existsSync(join(dir, MARKER_FILE))).toBe(false);
    expect(beginSession(dir, info()).previous.kind).toBe('clean');
  });

  it('a run that never reached its clean exit is reported next time, with its version', () => {
    beginSession(dir, info({ version: '3.2.1', now: 7 }));
    const next = beginSession(dir, info());
    expect(next.previous).toEqual({ kind: 'unclean', startedAt: 7, version: '3.2.1' });
  });

  it('this run writes its own marker again after reporting', () => {
    beginSession(dir, info());
    beginSession(dir, info());
    expect(JSON.parse(readFileSync(join(dir, MARKER_FILE), 'utf8')).pid).toBe(42);
  });

  it('a garbled marker still counts as unclean', () => {
    writeFileSync(join(dir, MARKER_FILE), '{"v":1,"pid"');
    expect(beginSession(dir, info()).previous.kind).toBe('unclean');
  });

  it('an update restart is not a crash', () => {
    beginSession(dir, info());
    expect(beginSession(dir, info({ updateRestart: true })).previous.kind).toBe('update');
  });

  it('a clean quit also drops the live snapshot (nothing to recover)', () => {
    beginSession(dir, info());
    saveJournal(dir, journal());
    endSession(dir);
    expect(existsSync(live())).toBe(false);
  });
});

describe('journal writes', () => {
  it('stores a valid snapshot atomically and leaves no temp file behind', () => {
    expect(saveJournal(dir, journal())).toBe(true);
    expect(JSON.parse(readFileSync(live(), 'utf8')).connectionId).toBe('c1');
    expect(readdirSync(join(dir, 'recovery')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses anything that is not a journal and keeps the previous snapshot', () => {
    saveJournal(dir, journal({ savedAt: NOW + 1 }));
    for (const bad of [{}, 'x', 5, { ...journal(), v: 9 }]) {
      expect(saveJournal(dir, bad)).toBe(false);
    }
    expect(JSON.parse(readFileSync(live(), 'utf8')).savedAt).toBe(NOW + 1);
  });

  it('null clears the snapshot', () => {
    saveJournal(dir, journal());
    expect(saveJournal(dir, null)).toBe(true);
    expect(existsSync(live())).toBe(false);
  });

  it('a kill in the middle of a write leaves the previous complete file readable', () => {
    saveJournal(dir, journal({ savedAt: NOW + 5 }));
    // What a kill between "write temp" and "rename" leaves: a half-written temp file.
    writeFileSync(`${live()}.999.tmp`, '{"v":1,"savedAt":6,"connec');
    expect(stageJournal(dir)?.savedAt).toBe(NOW + 5);
  });

  it('writeFileAtomic replaces a file whole', () => {
    const p = join(dir, 'x', 'f.json');
    writeFileAtomic(p, 'one');
    writeFileAtomic(p, 'two');
    expect(readFileSync(p, 'utf8')).toBe('two');
  });
});

describe('after a crash', () => {
  it('sets the snapshot aside, so the new session cannot overwrite it', () => {
    saveJournal(dir, journal({ edits: [] }));
    expect(stageJournal(dir)?.connectionId).toBe('c1');
    expect(existsSync(live())).toBe(false);
    saveJournal(dir, emptyJournal()); // the new session writes its own
    expect(readPending(dir).map((j) => j.connectionId)).toEqual(['c1']);
    expect(readPending(dir)[0]?.strip.tabs[0]?.sql).toBe('select 1');
  });

  it('keeps one snapshot per connection, newest first', () => {
    saveJournal(dir, journal({ connectionId: 'a', savedAt: NOW + 1 }));
    stageJournal(dir);
    saveJournal(dir, journal({ connectionId: 'b', savedAt: NOW + 9 }));
    stageJournal(dir);
    expect(readPending(dir).map((j) => j.connectionId)).toEqual(['b', 'a']);
  });

  it('an empty snapshot never replaces one that has content for the same connection', () => {
    saveJournal(dir, journal({ savedAt: NOW + 1 }));
    stageJournal(dir);
    saveJournal(dir, emptyJournal());
    const kept = stageJournal(dir);
    expect(kept?.strip.tabs[0]?.sql).toBe('select 1');
    expect(readPending(dir)[0]?.strip.tabs[0]?.sql).toBe('select 1');
  });

  it('a corrupt snapshot is ignored and set aside, not retried forever', () => {
    mkdirSync(join(dir, 'recovery'), { recursive: true });
    writeFileSync(live(), '{not json');
    expect(stageJournal(dir)).toBeNull();
    expect(existsSync(live())).toBe(false);
    expect(existsSync(`${live()}.corrupt`)).toBe(true);
  });

  it('a corrupt pending file is ignored and set aside; good ones still load', () => {
    saveJournal(dir, journal({ connectionId: 'good' }));
    stageJournal(dir);
    const pendingDir = join(dir, 'recovery', 'pending');
    writeFileSync(join(pendingDir, 'zz.json'), '[[[');
    expect(readPending(dir).map((j) => j.connectionId)).toEqual(['good']);
    expect(existsSync(join(pendingDir, 'zz.json.corrupt'))).toBe(true);
  });

  it('is restored or discarded only on request', () => {
    saveJournal(dir, journal({ connectionId: 'a' }));
    stageJournal(dir);
    saveJournal(dir, journal({ connectionId: 'b' }));
    stageJournal(dir);
    resolvePending(dir, 'a');
    expect(readPending(dir).map((j) => j.connectionId)).toEqual(['b']);
    resolvePending(dir);
    expect(readPending(dir)).toEqual([]);
  });
});

describe('RecoveryRuntime', () => {
  it('a crash is offered with its snapshot; resolving ends the offer', async () => {
    const first = new RecoveryRuntime(dir);
    first.start(info());
    await first.save(journal({ edits: [] }));
    // ...power cut: no first.end()...
    const second = new RecoveryRuntime(dir);
    expect(second.start(info()).kind).toBe('unclean');
    const launch = second.launchInfo(true);
    expect(launch).toMatchObject({ unclean: true, cause: 'exit', hasLog: true, announce: ['c1'] });
    expect(launch.journals.map((j) => j.connectionId)).toEqual(['c1']);
    // the new session's own writes do not disturb it
    await second.save(emptyJournal());
    expect(second.launchInfo(true).journals[0]?.strip.tabs[0]?.sql).toBe('select 1');
    second.resolve('c1');
    expect(second.launchInfo(true)).toMatchObject({ unclean: false, cause: null, journals: [] });
  });

  it('a clean quit leaves nothing to offer', async () => {
    const first = new RecoveryRuntime(dir);
    first.start(info());
    await first.save(journal());
    first.end();
    const second = new RecoveryRuntime(dir);
    expect(second.start(info()).kind).toBe('clean');
    expect(second.launchInfo(false)).toMatchObject({ unclean: false, journals: [], announce: [] });
  });

  it('a crash with nothing saved is still reported, without a snapshot', () => {
    new RecoveryRuntime(dir).start(info());
    const next = new RecoveryRuntime(dir);
    next.start(info());
    expect(next.launchInfo(false)).toMatchObject({ unclean: true, cause: 'exit', journals: [] });
    next.resolve();
    expect(next.launchInfo(false).unclean).toBe(false);
  });

  it('a snapshot nobody restored is announced once, never as a crash, on later clean launches (P1-4)', async () => {
    const first = new RecoveryRuntime(dir);
    first.start(info());
    await first.save(journal());
    // crash; the second run announces it, then quits cleanly without restoring
    const second = new RecoveryRuntime(dir);
    second.start(info());
    expect(second.launchInfo(false).announce).toEqual(['c1']);
    second.end();
    const third = new RecoveryRuntime(dir);
    expect(third.start(info()).kind).toBe('clean');
    const again = third.launchInfo(false);
    expect(again.journals).toHaveLength(1); // still restorable when its connection is opened
    expect(again.unclean).toBe(false);
    expect(again.cause).toBeNull();
    expect(again.announce).toEqual([]);
    third.end();
    const fourth = new RecoveryRuntime(dir);
    fourth.start(info());
    expect(fourth.launchInfo(false).announce).toEqual([]);
  });

  it('a snapshot older than two weeks is let go', async () => {
    const first = new RecoveryRuntime(dir);
    first.start(info());
    await first.save(journal({ savedAt: NOW - 15 * 24 * 3600 * 1000 }));
    const second = new RecoveryRuntime(dir);
    second.start(info());
    expect(second.launchInfo(false).journals).toEqual([]);
  });

  it('several snapshots are all kept and announced, newest first', async () => {
    const rt = new RecoveryRuntime(dir);
    rt.start(info());
    await rt.save(journal({ connectionId: 'a', savedAt: NOW - 5 }));
    stageJournal(dir);
    await rt.save(journal({ connectionId: 'b', savedAt: NOW - 1 }));
    stageJournal(dir);
    const launch = rt.launchInfo(false);
    expect(launch.journals.map((j) => j.connectionId)).toEqual(['b', 'a']);
    rt.resolve('b');
    expect(rt.launchInfo(false).journals.map((j) => j.connectionId)).toEqual(['a']);
  });

  it('a snapshot whose restore could not be written down is set aside, not restored twice (P2-1)', async () => {
    const rt = new RecoveryRuntime(dir);
    rt.start(info());
    await rt.save(journal());
    stageJournal(dir);
    rt.resolve('c1', true);
    expect(readPending(dir)).toEqual([]);
    expect(readdirSync(join(dir, 'recovery', 'pending')).some((f) => f.endsWith('.restored'))).toBe(
      true,
    );
  });

  it('a window crash sets the snapshot aside and reloads, until it keeps crashing', async () => {
    const rt = new RecoveryRuntime(dir);
    rt.start(info());
    await rt.save(journal());
    expect(rt.rendererGone(1_000).reload).toBe(true);
    expect(rt.launchInfo(false)).toMatchObject({ cause: 'renderer' });
    expect(rt.launchInfo(false).journals).toHaveLength(1);
    expect(existsSync(live())).toBe(false);
    expect(rt.rendererGone(2_000).reload).toBe(true);
    expect(rt.rendererGone(3_000).reload).toBe(true);
    expect(rt.rendererGone(4_000).reload).toBe(false);
  });

  it('never writes a statement anywhere: the snapshot holds text only', async () => {
    const rt = new RecoveryRuntime(dir);
    rt.start(info());
    await rt.save(
      journal({
        strip: {
          v: 1,
          activeIndex: 0,
          tabs: [{ kind: 'sql', title: 'q', sql: 'delete from users' }],
        },
      }),
    );
    const text = readFileSync(live(), 'utf8');
    expect(JSON.parse(text).strip.tabs[0].sql).toBe('delete from users');
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      ['connectionId', 'edits', 'savedAt', 'strip', 'txnActive', 'v'].sort(),
    );
  });

  it('coalesces a burst of writes: the last one wins and every caller is told', async () => {
    const rt = new RecoveryRuntime(dir);
    rt.start(info());
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => rt.save(journal({ savedAt: NOW + n, txnActive: n === 5 }))),
    );
    expect(results.every(Boolean)).toBe(true);
    expect(JSON.parse(readFileSync(live(), 'utf8')).savedAt).toBe(NOW + 5);
  });

  it('a write after a clean quit never brings the file back', async () => {
    const rt = new RecoveryRuntime(dir);
    rt.start(info());
    await rt.save(journal());
    rt.end();
    expect(await rt.save(journal())).toBe(false);
    expect(existsSync(live())).toBe(false);
  });

  it('one oversized edit does not cost the snapshot: it is left out and counted (P2-1)', async () => {
    const rt = new RecoveryRuntime(dir);
    rt.start(info());
    const edit = (value: string) => ({
      tabIndex: 0,
      kind: 'update' as const,
      schema: 's',
      table: 't',
      pkValues: { id: '1' },
      column: 'c',
      oldValue: 'x',
      newValue: value,
    });
    const bad = { ...edit('y'), kind: 'truncate' };
    await rt.save(
      journal({
        edits: [edit('ok'), edit('z'.repeat(5 * 1024 * 1024)), bad as never, edit('ok2')],
      }),
    );
    const saved = JSON.parse(readFileSync(live(), 'utf8'));
    expect(saved.edits.map((e: { newValue: string }) => e.newValue)).toEqual(['ok', 'ok2']);
    expect(saved.omitted).toEqual({ tabs: [], edits: 2 });
    expect(saved.strip.tabs[0].sql).toBe('select 1');
  });
});
