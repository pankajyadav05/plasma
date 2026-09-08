import { describe, expect, it } from 'vitest';
import { describeUpdateStatus } from './update-status';

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
