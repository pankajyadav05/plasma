import type { RecoveryJournal, RecoveryLaunchInfo } from '@shared/recovery';
import { describe, expect, it, vi } from 'vitest';
import {
  type AnnounceDeps,
  announceNothingToRestore,
  announceOffers,
  announceRestored,
  announceTargetChanged,
  planRecoveryBoot,
} from './recovery-boot';

const journal = (id: string, over: Partial<RecoveryJournal> = {}): RecoveryJournal => ({
  v: 1,
  savedAt: 1,
  connectionId: id,
  connectionName: id,
  txnActive: false,
  strip: { v: 1, activeIndex: 0, tabs: [{ kind: 'sql', title: 'q', sql: 'select 1' }] },
  edits: [],
  ...over,
});

const info = (
  journals: RecoveryJournal[],
  over: Partial<RecoveryLaunchInfo> = {},
): RecoveryLaunchInfo => ({
  unclean: true,
  cause: 'exit',
  journals,
  announce: journals.map((j) => j.connectionId),
  hasLog: true,
  ...over,
});

const saved = [{ id: 'c1', name: 'Local' }];

describe('planRecoveryBoot', () => {
  it('does nothing without recovery info or when nothing is waiting', () => {
    expect(planRecoveryBoot(null, saved, [])).toEqual({
      resume: null,
      noticeOnly: null,
      offers: [],
    });
    expect(planRecoveryBoot(info([], { unclean: false, cause: null }), saved, [])).toEqual({
      resume: null,
      noticeOnly: null,
      offers: [],
    });
  });

  it('after a crash, reconnects a saved connection and restores its snapshot', () => {
    const plan = planRecoveryBoot(info([journal('c1')]), saved, []);
    expect(plan.resume).toMatchObject({ plan: { kind: 'saved', id: 'c1', name: 'Local' } });
    expect(plan.offers).toEqual([]);
  });

  it('reconnects a workspace profile through the workspace store', () => {
    const plan = planRecoveryBoot(info([journal('ws:0123456789ab:prod')]), saved, ['prod']);
    expect(plan.resume).toMatchObject({ plan: { kind: 'workspace', profileId: 'prod' } });
  });

  it('resumes only the newest reachable snapshot; the others are offered, one at a time (P1-4)', () => {
    const plan = planRecoveryBoot(
      info([
        journal('deleted', { savedAt: 9 }),
        journal('c1', { savedAt: 3 }),
        journal('c2', { savedAt: 2 }),
      ]),
      [...saved, { id: 'c2', name: 'Two' }],
      [],
    );
    expect(plan.resume?.journal.connectionId).toBe('c1');
    expect(plan.offers.map((o) => [o.journal.connectionId, o.restorable])).toEqual([
      ['deleted', false],
      ['c2', true],
    ]);
  });

  it('never reconnects on a clean launch, whatever is waiting (P1-4)', () => {
    const plan = planRecoveryBoot(
      info([journal('c1')], { unclean: false, cause: null }),
      saved,
      [],
    );
    expect(plan.resume).toBeNull();
    expect(plan.noticeOnly).toBeNull();
    expect(plan.offers.map((o) => o.journal.connectionId)).toEqual(['c1']);
  });

  it('offers only what was not announced before', () => {
    const plan = planRecoveryBoot(
      info([journal('c1')], { unclean: false, cause: null, announce: [] }),
      saved,
      [],
    );
    expect(plan.offers).toEqual([]);
  });

  it('a snapshot whose connection is gone is offered, not resumed', () => {
    const plan = planRecoveryBoot(info([journal('deleted')]), saved, []);
    expect(plan.resume).toBeNull();
    expect(plan.offers).toEqual([{ journal: expect.anything(), restorable: false }]);
    expect(plan.noticeOnly).toBeNull();
  });

  it('a crash with nothing worth restoring is reported, not acted on', () => {
    const empty = journal('c1', {
      strip: { v: 1, activeIndex: 0, tabs: [{ kind: 'sql', title: 'q', sql: '' }] },
    });
    expect(planRecoveryBoot(info([empty]), saved, []).noticeOnly).toBe('exit');
    expect(planRecoveryBoot(info([], { cause: 'renderer' }), saved, []).noticeOnly).toBe(
      'renderer',
    );
  });
});

describe('announcements', () => {
  const deps = (over: Partial<AnnounceDeps> = {}) => {
    const push = vi.fn(() => 'id');
    const d: AnnounceDeps = {
      push,
      dismiss: vi.fn(),
      discardEdits: vi.fn(),
      discardSnapshot: vi.fn(),
      openAsSql: vi.fn(),
      showLog: vi.fn(),
      hasLog: true,
      ...over,
    };
    return { push, deps: d };
  };
  type Toast = {
    id?: string;
    title: string;
    detail: string;
    actions: { label: string; run(): void }[];
  };
  const toast = (push: ReturnType<typeof vi.fn>, n = 0) => (push.mock.calls[n] as [Toast])[0];

  it('"Plasma closed unexpectedly. Restored 4 tabs and 3 unsaved edits." with both actions', () => {
    const { push, deps: d } = deps();
    announceRestored({ journal: journal('c1'), tabs: 4, edits: 3 }, 'exit', d);
    const t = toast(push);
    expect(t.title).toBe('Plasma closed unexpectedly');
    expect(t.detail).toContain('Restored 4 tabs and 3 unsaved edits.');
    expect(t.actions.map((a) => a.label)).toEqual(['Discard edits', 'Show crash log']);
    t.actions[0]?.run();
    t.actions[1]?.run();
    expect(d.discardEdits).toHaveBeenCalledOnce();
    expect(d.showLog).toHaveBeenCalledOnce();
  });

  it('carries the "may already be saved" and "could not be saved" notes from the snapshot', () => {
    const { push, deps: d } = deps();
    const j = journal('c1', {
      omitted: { tabs: ['big.sql'], edits: 1 },
      edits: [
        {
          tabIndex: 0,
          kind: 'insert',
          schema: 's',
          table: 't',
          pkValues: {},
          column: '',
          oldValue: null,
          newValue: null,
          values: { id: '1' },
          maybeCommitted: true,
        },
      ],
    });
    announceRestored({ journal: j, tabs: 1, edits: 1 }, 'exit', d);
    const t = toast(push);
    expect(t.detail).toContain('may already be saved');
    expect(t.detail).toContain('1 edit could not be saved');
    expect(t.detail).toContain('big.sql');
  });

  it('offers no "Discard edits" when no edits came back, and no log link without a log', () => {
    const { push, deps: d } = deps({ hasLog: false });
    announceRestored({ journal: journal('c1'), tabs: 2, edits: 0 }, 'exit', d);
    expect(toast(push).actions).toEqual([]);
  });

  it('reports a crash with nothing to restore', () => {
    const { push, deps: d } = deps();
    announceNothingToRestore('exit', d);
    expect(toast(push).detail).toBe('Nothing needed to be restored.');
  });

  it('offers snapshots one at a time with Discard and Keep for later', () => {
    const { push, deps: d } = deps();
    announceOffers(
      [
        { journal: journal('a', { edits: [], connectionName: 'Alpha' }), restorable: true },
        { journal: journal('b', { connectionName: 'Beta' }), restorable: false },
      ],
      d,
    );
    expect(push).toHaveBeenCalledTimes(1);
    const first = toast(push);
    expect(first.title).toBe('Unsaved work from an earlier session');
    expect(first.detail).toContain('“Alpha”');
    expect(first.detail).toContain('comes back when you connect to it');
    expect(first.detail).toContain('1 more after this');
    expect(first.actions.map((a) => a.label)).toEqual(['Discard', 'Keep for later']);

    first.actions[1]?.run(); // keep for later: shows the next, deletes nothing
    expect(d.discardSnapshot).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(2);
    const second = toast(push, 1);
    expect(second.detail).toContain('“Beta”');
    expect(second.detail).toContain('cannot be restored');
    second.actions[0]?.run(); // discard
    expect(d.discardSnapshot).toHaveBeenCalledWith('b');
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('a snapshot from another target is never applied; its SQL can be opened, or it discarded', () => {
    const { push, deps: d } = deps();
    announceTargetChanged(journal('c1'), d);
    const t = toast(push);
    expect(t.title).toBe('Saved work belongs to a different database');
    expect(t.actions.map((a) => a.label)).toEqual(['Open its SQL', 'Discard', 'Keep for later']);
    t.actions[0]?.run();
    expect(d.openAsSql).toHaveBeenCalledOnce();
  });
});
