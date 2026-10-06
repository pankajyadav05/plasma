import { describe, expect, it, vi } from 'vitest';
import { announceUpdateOutcome, planResume } from './update-launch';

const base = {
  resume: true,
  connectionId: 'c1',
  logPath: null,
  downloadUrl: null,
};

describe('announceUpdateOutcome', () => {
  it('stays silent when the launch was not an update restart', () => {
    const push = vi.fn();
    announceUpdateOutcome(null, push);
    announceUpdateOutcome({ ...base, resume: false, outcome: 'none', version: null }, push);
    expect(push).not.toHaveBeenCalled();
  });

  it('announces a success with a link to the release notes', () => {
    const push = vi.fn();
    const open = vi.fn();
    announceUpdateOutcome({ ...base, outcome: 'updated', version: '3.2.2' }, push, open);
    const [toast] = push.mock.calls[0] as [{ title: string; actions: { run(): void }[] }];
    expect(toast.title).toBe('Updated to Plasma 3.2.2');
    toast.actions[0]?.run();
    expect(open).toHaveBeenCalledWith(
      'https://github.com/pankajyadav05/plasma/releases/tag/v3.2.2',
    );
  });

  it('reports a failure with the log path and the manual download', () => {
    const push = vi.fn();
    const open = vi.fn();
    announceUpdateOutcome(
      {
        ...base,
        outcome: 'failed',
        version: '3.2.2',
        logPath: '/u/logs/update-helper.log',
        downloadUrl: 'https://plasma.sh',
      },
      push,
      open,
    );
    const [toast] = push.mock.calls[0] as [
      { title: string; detail: string; tone: string; actions: { run(): void }[] },
    ];
    expect(toast.tone).toBe('warn');
    expect(toast.title).toBe('The update could not be installed');
    expect(toast.detail).toContain('/u/logs/update-helper.log');
    toast.actions[0]?.run();
    expect(open).toHaveBeenCalledWith('https://plasma.sh');
  });

  it('does not link a version that is not a plain release number', () => {
    const push = vi.fn();
    announceUpdateOutcome({ ...base, outcome: 'updated', version: '3.2.2/../x' }, push);
    expect((push.mock.calls[0] as [{ actions: unknown[] }])[0].actions).toEqual([]);
  });
});

describe('planResume', () => {
  const saved = [{ id: 'c1', name: 'Local' }];
  const info = (connectionId: string | null, resume = true) => ({
    resume,
    connectionId,
    outcome: 'updated' as const,
    version: '3.2.2',
    logPath: null,
    downloadUrl: null,
  });

  it('reconnects a saved connection', () => {
    expect(planResume(info('c1'), saved, [])).toEqual({ kind: 'saved', id: 'c1', name: 'Local' });
  });

  it('reconnects a team-workspace profile, which is not a saved connection', () => {
    const id = 'ws:0123456789ab:prod-ro';
    expect(planResume(info(id), saved, ['dev', 'prod-ro'])).toEqual({
      kind: 'workspace',
      connectionId: id,
      profileId: 'prod-ro',
    });
  });

  it('does nothing for a profile the reopened workspace no longer has, or a normal launch', () => {
    expect(planResume(info('ws:0123456789ab:gone'), saved, ['dev'])).toBeNull();
    expect(planResume(info('unknown'), saved, [])).toBeNull();
    expect(planResume(info('c1', false), saved, [])).toBeNull();
    expect(planResume(info(null), saved, [])).toBeNull();
    expect(planResume(null, saved, [])).toBeNull();
  });
});
