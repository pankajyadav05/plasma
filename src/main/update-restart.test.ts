import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INSTALL_HANDOVER_MS,
  MARKER_MAX_AGE_MS,
  type RestartMarker,
  clearRestartMarker,
  evaluateRestartMarker,
  installHandoverPending,
  isInstallHandover,
  markerPath,
  parseRestartMarker,
  readRestartMarker,
  writeRestartMarker,
} from './update-restart';

const NOW = 1_800_000_000_000;
const marker = (over: Partial<RestartMarker> = {}): RestartMarker => ({
  v: 1,
  platform: 'darwin',
  fromVersion: '3.2.0',
  expectedVersion: '3.2.2',
  at: NOW - 4_000,
  connectionId: 'conn-1',
  workspaceRoot: null,
  logPath: null,
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plasma-marker-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('restart marker file', () => {
  it('round-trips and is removed once read', () => {
    expect(readRestartMarker(dir)).toBeNull();
    writeRestartMarker(dir, marker({ workspaceRoot: '/work/a b' }));
    expect(readRestartMarker(dir)).toEqual(marker({ workspaceRoot: '/work/a b' }));
    clearRestartMarker(dir);
    expect(existsSync(markerPath(dir))).toBe(false);
    expect(readRestartMarker(dir)).toBeNull();
  });

  it('writes atomically (no temp file left behind)', () => {
    writeRestartMarker(dir, marker());
    expect(readFileSync(markerPath(dir), 'utf8')).toContain('"expectedVersion":"3.2.2"');
    expect(existsSync(`${markerPath(dir)}.${process.pid}.tmp`)).toBe(false);
  });

  it('ignores a corrupt or foreign file', () => {
    writeFileSync(markerPath(dir), '{not json');
    expect(readRestartMarker(dir)).toBeNull();
    writeFileSync(markerPath(dir), JSON.stringify({ v: 2 }));
    expect(readRestartMarker(dir)).toBeNull();
    expect(parseRestartMarker({ ...marker(), at: 'yesterday' })).toBeNull();
    expect(parseRestartMarker({ ...marker(), expectedVersion: 3 })).toBeNull();
  });

  it('drops odd field values instead of trusting them', () => {
    expect(parseRestartMarker({ ...marker(), connectionId: 42, workspaceRoot: '' })).toMatchObject({
      connectionId: null,
      workspaceRoot: null,
    });
  });
});

describe('evaluateRestartMarker', () => {
  it('has nothing to say without a marker', () => {
    expect(evaluateRestartMarker(null, '3.2.0', NOW)).toEqual({ outcome: 'none', resume: false });
  });

  it('reports success when the running version reached the expected one (or passed it)', () => {
    expect(evaluateRestartMarker(marker(), '3.2.2', NOW)).toEqual({
      outcome: 'updated',
      resume: true,
      version: '3.2.2',
    });
    expect(evaluateRestartMarker(marker(), '3.3.0', NOW)).toMatchObject({ outcome: 'updated' });
  });

  it('reports failure when the old version came back, and still resumes the session', () => {
    expect(evaluateRestartMarker(marker(), '3.2.0', NOW)).toEqual({
      outcome: 'failed',
      resume: true,
      expectedVersion: '3.2.2',
    });
  });

  it('ignores a marker that is too old or from the future', () => {
    expect(
      evaluateRestartMarker(marker({ at: NOW - MARKER_MAX_AGE_MS - 1 }), '3.2.0', NOW),
    ).toEqual({ outcome: 'none', resume: false });
    expect(evaluateRestartMarker(marker({ at: NOW + 60_000 }), '3.2.0', NOW).outcome).toBe('none');
  });
});

describe('install handover', () => {
  it('is pending only while a fresh marker exists', () => {
    expect(installHandoverPending(dir, NOW)).toBe(false);
    writeRestartMarker(dir, marker({ at: NOW - 1_000 }));
    expect(installHandoverPending(dir, NOW)).toBe(true);
    expect(isInstallHandover(marker({ at: NOW - INSTALL_HANDOVER_MS - 1 }), NOW)).toBe(false);
    expect(isInstallHandover(null, NOW)).toBe(false);
  });
});
