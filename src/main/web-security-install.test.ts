import { beforeEach, describe, expect, it, vi } from 'vitest';

const defaultSession = vi.hoisted(() => ({
  setPermissionRequestHandler: vi.fn(),
  setPermissionCheckHandler: vi.fn(),
  setDevicePermissionHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  session: { defaultSession },
}));

import { installWebSecurity } from './web-security';

describe('installWebSecurity permissions (SC-28)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies every web permission, asynchronous and synchronous, except clipboard writes', () => {
    installWebSecurity({ file: '/app/index.html' });

    const request = defaultSession.setPermissionRequestHandler.mock.calls[0]?.[0];
    const check = defaultSession.setPermissionCheckHandler.mock.calls[0]?.[0];
    const device = defaultSession.setDevicePermissionHandler.mock.calls[0]?.[0];
    expect(request).toBeTypeOf('function');
    expect(check).toBeTypeOf('function');
    expect(device).toBeTypeOf('function');

    for (const permission of ['media', 'geolocation', 'notifications', 'midi', 'hid', 'serial']) {
      const callback = vi.fn();
      request({}, permission, callback);
      expect(callback).toHaveBeenCalledWith(false);
      expect(check({}, permission)).toBe(false);
    }
    const callback = vi.fn();
    request({}, 'clipboard-sanitized-write', callback);
    expect(callback).toHaveBeenCalledWith(true);
    expect(check({}, 'clipboard-sanitized-write')).toBe(true);
    expect(device({})).toBe(false);
  });
});
