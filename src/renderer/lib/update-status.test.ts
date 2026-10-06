import { describe, expect, it } from 'vitest';
import { describeCheckedAt, describeUpdateStatus } from './update-status';

/**
 * `not-available` reports the version the update *feed* advertises. When a
 * publish job never ran (or the installed build points at an abandoned feed
 * URL) that number is older than the running app, and the About panel used
 * to present it as proof the user was current — the v0.0.15 "stuck on
 * latest" report. The panel must not claim "latest" in that state.
 */
describe('describeUpdateStatus — not-available', () => {
  it('confirms the running version when the feed agrees', () => {
    const line = describeUpdateStatus({ kind: 'not-available', version: '0.0.19' }, '0.0.19');
    expect(line).toContain('latest');
    expect(line).toContain('0.0.19');
  });

  it('flags a feed that advertises an older version than the running app', () => {
    const line = describeUpdateStatus({ kind: 'not-available', version: '0.0.18' }, '0.0.19');
    expect(line).not.toContain('latest');
    expect(line).toContain('0.0.18');
    expect(line).toContain('0.0.19');
  });

  it('orders versions numerically, not lexically', () => {
    const line = describeUpdateStatus({ kind: 'not-available', version: '0.0.9' }, '0.0.10');
    expect(line).not.toContain('latest');
  });
});

describe('describeUpdateStatus — states of the restart flow', () => {
  it('says why an update has to be downloaded by hand', () => {
    expect(
      describeUpdateStatus(
        {
          kind: 'available-manual',
          version: '3.2.2',
          downloadUrl: 'https://plasma.sh',
          reason: 'Move Plasma to Applications to get automatic updates.',
        },
        '3.2.0',
      ),
    ).toBe('Update v3.2.2 is available. Move Plasma to Applications to get automatic updates.');
    expect(
      describeUpdateStatus(
        { kind: 'available-manual', version: '3.2.2', downloadUrl: 'https://plasma.sh' },
        '3.2.0',
      ),
    ).toContain('Download it');
  });

  it('describes ready, restarting and error', () => {
    expect(describeUpdateStatus({ kind: 'downloaded', version: '3.2.2' }, '3.2.0')).toBe(
      'Update v3.2.2 is ready — restart to install.',
    );
    expect(describeUpdateStatus({ kind: 'restarting', version: '3.2.2' }, '3.2.0')).toContain(
      'Restarting',
    );
    expect(describeUpdateStatus({ kind: 'error', message: 'offline' }, '3.2.0')).toBe(
      'Update problem: offline',
    );
  });
});

describe('describeCheckedAt', () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  it('is relative for the first day', () => {
    expect(describeCheckedAt(null, now)).toBe('not checked yet');
    expect(describeCheckedAt(now - 10_000, now)).toBe('just now');
    expect(describeCheckedAt(now - 60_000, now)).toBe('1 minute ago');
    expect(describeCheckedAt(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(describeCheckedAt(now - 3 * 3_600_000, now)).toBe('3 hours ago');
  });
});
