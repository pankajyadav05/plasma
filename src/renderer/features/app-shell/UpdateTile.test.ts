import { describe, expect, it } from 'vitest';
import { viewFor } from './UpdateTile';

describe('update tile', () => {
  it('checks when idle, up to date or after an error', () => {
    expect(viewFor({ kind: 'idle' }, false)).toMatchObject({ label: 'Updates', action: 'check' });
    expect(viewFor({ kind: 'not-available', version: '3.2.3' }, true)).toMatchObject({
      label: 'Up to date',
      action: 'check',
    });
    expect(viewFor({ kind: 'not-available', version: '3.2.3' }, false).label).toBe('Updates');
    expect(viewFor({ kind: 'error', message: 'offline' }, false)).toMatchObject({
      label: 'Retry',
      action: 'check',
      warn: true,
    });
  });

  it('does nothing while checking, downloading or restarting', () => {
    expect(viewFor({ kind: 'checking' }, false).action).toBeNull();
    expect(viewFor({ kind: 'available', version: '3.2.4' }, false).action).toBeNull();
    expect(
      viewFor(
        { kind: 'downloading', percent: 41.6, bytesPerSecond: 1, transferred: 1, total: 2 },
        false,
      ),
    ).toMatchObject({ label: '42%', action: null });
    expect(viewFor({ kind: 'restarting', version: '3.2.4' }, false).action).toBeNull();
  });

  it('installs once downloaded, or opens the download when it cannot self-install', () => {
    expect(viewFor({ kind: 'downloaded', version: '3.2.4' }, false)).toMatchObject({
      label: 'Restart',
      action: 'install',
      accent: true,
    });
    expect(
      viewFor(
        {
          kind: 'available-manual',
          version: '3.2.4',
          downloadUrl: 'https://x',
          reason: 'Portable build',
        },
        false,
      ),
    ).toMatchObject({ label: 'Update', action: 'install' });
  });
});
