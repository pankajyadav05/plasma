import { describe, expect, it } from 'vitest';
import { cleanIpcError, describeConnectError } from './errors';

describe('cleanIpcError', () => {
  it('strips the Electron IPC wrapper and error class', () => {
    expect(
      cleanIpcError(
        "Error invoking remote method 'plasma:conn:connect': ConnectionLostError: connection lost: Connection is closed.",
      ),
    ).toBe('connection lost: Connection is closed.');
    expect(cleanIpcError('plain message')).toBe('plain message');
  });
});

describe('describeConnectError', () => {
  it('explains a Redis socket closed after a rejected AUTH', () => {
    const msg = describeConnectError(
      "Error invoking remote method 'plasma:conn:connect': ConnectionLostError: connection lost: Connection is closed.",
      'redis',
    );
    expect(msg).toMatch(/^connection lost: Connection is closed\./);
    expect(msg).toMatch(/ACL user and password/);
  });

  it('explains a refused connection', () => {
    expect(describeConnectError('connect ECONNREFUSED 127.0.0.1:6380')).toMatch(
      /nothing is listening/,
    );
  });
});
