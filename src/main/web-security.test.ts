import { describe, expect, it } from 'vitest';
import { isAllowedPermission, isAppUrl, isSafeExternalUrl } from './web-security';

describe('isSafeExternalUrl (C19)', () => {
  it('allows http, https and mailto', () => {
    expect(isSafeExternalUrl('https://example.com/x')).toBe(true);
    expect(isSafeExternalUrl('http://example.com')).toBe(true);
    expect(isSafeExternalUrl('mailto:a@b.c')).toBe(true);
  });
  it('rejects file, smb, custom schemes and garbage', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('smb://host/share')).toBe(false);
    expect(isSafeExternalUrl('ms-msdt:/id')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('not a url')).toBe(false);
  });
});

describe('isAppUrl (C19/C34)', () => {
  const file = '/opt/plasma/out/renderer/index.html';
  it('accepts the built renderer file, with hash or query', () => {
    expect(isAppUrl('file:///opt/plasma/out/renderer/index.html', { file })).toBe(true);
    expect(isAppUrl('file:///opt/plasma/out/renderer/index.html#/x?y=1', { file })).toBe(true);
  });
  it('rejects other files and remote pages', () => {
    expect(isAppUrl('file:///tmp/evil.html', { file })).toBe(false);
    expect(isAppUrl('https://evil.example', { file })).toBe(false);
    expect(isAppUrl('', { file })).toBe(false);
  });
  it('accepts the dev server origin only when configured', () => {
    const entry = { file, devUrl: 'http://localhost:5173' };
    expect(isAppUrl('http://localhost:5173/', entry)).toBe(true);
    expect(isAppUrl('http://localhost:5174/', entry)).toBe(false);
    expect(isAppUrl('http://localhost:5173/', { file })).toBe(false);
  });
});

describe('isAllowedPermission', () => {
  it('only allows clipboard writes', () => {
    expect(isAllowedPermission('clipboard-sanitized-write')).toBe(true);
    expect(isAllowedPermission('media')).toBe(false);
    expect(isAllowedPermission('notifications')).toBe(false);
  });
});
