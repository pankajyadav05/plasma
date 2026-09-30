import { describe, expect, it } from 'vitest';
import { readPublisherName, resolveWindow, updatePolicy } from './update-policy';

describe('updatePolicy (C20)', () => {
  it('installs silently only when Windows verifies a publisher', () => {
    expect(updatePolicy('win32', 'Plasma Ltd')).toEqual({
      autoDownload: true,
      autoInstallOnAppQuit: true,
      signatureVerified: true,
    });
    expect(updatePolicy('win32', null).autoInstallOnAppQuit).toBe(false);
    expect(updatePolicy('darwin', null).autoInstallOnAppQuit).toBe(false);
    expect(updatePolicy('linux', 'x').signatureVerified).toBe(false);
  });
});

describe('readPublisherName', () => {
  it('parses scalar, inline-list and block-list forms', () => {
    expect(readPublisherName('provider: generic\npublisherName: Plasma Ltd\n')).toBe('Plasma Ltd');
    expect(readPublisherName("publisherName: ['Plasma Ltd']\n")).toBe('Plasma Ltd');
    expect(readPublisherName('publisherName:\n  - Plasma Ltd\nupdaterCacheDirName: x\n')).toBe(
      'Plasma Ltd',
    );
  });
  it('returns null when absent', () => {
    expect(readPublisherName('provider: generic\nurl: https://x\n')).toBeNull();
  });
});

describe('resolveWindow (C33)', () => {
  it('reads a getter on every call so a reopened window is followed', () => {
    let current: { id: number } | null = { id: 1 };
    const get = resolveWindow(() => current);
    expect(get()).toEqual({ id: 1 });
    current = null;
    expect(get()).toBeNull();
    current = { id: 2 };
    expect(get()).toEqual({ id: 2 });
  });
  it('wraps a fixed window', () => {
    const w = { id: 3 };
    expect(resolveWindow(w)()).toBe(w);
    expect(resolveWindow<{ id: number }>(null)()).toBeNull();
  });
});
