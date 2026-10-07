import type { RecoveryJournal, RecoveryLaunchInfo } from '@shared/recovery';
import { describe, expect, it, vi } from 'vitest';
import {
  type AnnounceDeps,
  announceNothingToRestore,
  announceRestored,
  announceUnrestorable,
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

const info = (over: Partial<RecoveryLaunchInfo> = {}): RecoveryLaunchInfo => ({
  unclean: true,
  cause: 'exit',
  journals: [],
  hasLog: true,
  ...over,
});

const saved = [{ id: 'c1', name: 'Local' }];

describe('planRecoveryBoot', () => {
  it('does nothing after a clean exit', () => {
    expect(planRecoveryBoot(null, saved, [])).toEqual({ kind: 'none' });
    expect(planRecoveryBoot(info({ unclean: false, cause: null }), saved, [])).toEqual({
      kind: 'none',
    });
  });

  it('reconnects a saved connection and restores its snapshot', () => {
    const plan = planRecoveryBoot(info({ journals: [journal('c1')] }), saved, []);
    expect(plan).toMatchObject({
      kind: 'resume',
      plan: { kind: 'saved', id: 'c1', name: 'Local' },
    });
  });

  it('reconnects a workspace profile through the workspace store', () => {
    const plan = planRecoveryBoot(info({ journals: [journal('ws:0123456789ab:prod')] }), saved, [
      'prod',
    ]);
    expect(plan).toMatchObject({ kind: 'resume', plan: { kind: 'workspace', profileId: 'prod' } });
  });

  it('picks the newest snapshot whose connection still exists', () => {
    const plan = planRecoveryBoot(
      info({
        journals: [journal('deleted', { savedAt: 9 }), journal('c1', { savedAt: 3 })],
      }),
      saved,
      [],
    );
    expect(plan).toMatchObject({ kind: 'resume', journal: { connectionId: 'c1' } });
  });

  it('keeps a snapshot whose connection is gone, and says so', () => {
    const plan = planRecoveryBoot(info({ journals: [journal('deleted')] }), saved, []);
    expect(plan.kind).toBe('unrestorable');
  });

  it('a crash with nothing worth restoring is reported, not acted on', () => {
    const empty = journal('c1', {
      strip: { v: 1, activeIndex: 0, tabs: [{ kind: 'sql', title: 'q', sql: '' }] },
    });
    expect(planRecoveryBoot(info({ journals: [empty] }), saved, [])).toEqual({
      kind: 'notice-only',
      cause: 'exit',
    });
    expect(planRecoveryBoot(info({ cause: 'renderer' }), saved, [])).toEqual({
      kind: 'notice-only',
      cause: 'renderer',
    });
  });
});

describe('announcements', () => {
  const deps = (over: Partial<AnnounceDeps> = {}) => {
    const push = vi.fn(() => 'id');
    return {
      push,
      deps: {
        push,
        discardEdits: vi.fn(),
        showLog: vi.fn(),
        hasLog: true,
        ...over,
      } as AnnounceDeps,
    };
  };

  it('"Plasma closed unexpectedly. Restored 4 tabs and 3 unsaved edits." with both actions', () => {
    const { push, deps: d } = deps();
    announceRestored({ journal: journal('c1'), tabs: 4, edits: 3 }, 'exit', d);
    const toast = (
      push.mock.calls[0] as unknown as [
        { title: string; detail: string; actions: { label: string; run(): void }[] },
      ]
    )[0];
    expect(toast.title).toBe('Plasma closed unexpectedly');
    expect(toast.detail).toContain('Restored 4 tabs and 3 unsaved edits.');
    expect(toast.actions.map((a) => a.label)).toEqual(['Discard edits', 'Show crash log']);
    toast.actions[0]?.run();
    toast.actions[1]?.run();
    expect(d.discardEdits).toHaveBeenCalledOnce();
    expect(d.showLog).toHaveBeenCalledOnce();
  });

  it('offers no "Discard edits" when no edits came back, and no log link without a log', () => {
    const { push, deps: d } = deps({ hasLog: false });
    announceRestored({ journal: journal('c1'), tabs: 2, edits: 0 }, 'exit', d);
    const toast = (push.mock.calls[0] as unknown as [{ actions: unknown[] }])[0];
    expect(toast.actions).toEqual([]);
  });

  it('reports a crash with nothing to restore, and one that could not be restored', () => {
    const a = deps();
    announceNothingToRestore('exit', a.deps);
    expect((a.push.mock.calls[0] as unknown as [{ detail: string }])[0].detail).toBe(
      'Nothing needed to be restored.',
    );
    const b = deps();
    announceUnrestorable(journal('gone'), b.deps);
    expect((b.push.mock.calls[0] as unknown as [{ detail: string }])[0].detail).toContain('kept');
  });
});
