import { describe, expect, it } from 'vitest';
import { readPublisherName, updatePolicy } from './update-policy';

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
