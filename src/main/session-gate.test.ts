import { describe, expect, it } from 'vitest';
import { SessionGate, connectOrCleanUp } from './session-gate';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('SessionGate (SC-29)', () => {
  it('runs session changes one at a time, in order', async () => {
    const gate = new SessionGate();
    const log: string[] = [];
    const a = gate.serialize(async () => {
      log.push('a:start');
      await tick();
      log.push('a:end');
    });
    const b = gate.serialize(async () => {
      log.push('b:start');
    });
    await Promise.all([a, b]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('makes other requests wait until the in-flight change is done', async () => {
    const gate = new SessionGate();
    let sessionReadOnly = false;
    const change = gate.serialize(async () => {
      await tick();
      sessionReadOnly = true; // the connect lands on a read-only session
    });
    expect(gate.busy).toBe(true);
    await gate.settled();
    // A guard evaluated now sees the final session, not the old writable one.
    expect(sessionReadOnly).toBe(true);
    await change;
    expect(gate.busy).toBe(false);
  });

  it('keeps going after a failed change', async () => {
    const gate = new SessionGate();
    await expect(gate.serialize(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(gate.serialize(async () => 7)).resolves.toBe(7);
    await gate.settled();
    expect(gate.busy).toBe(false);
  });
});

describe('connectOrCleanUp (SC-07)', () => {
  it('cleans up and rethrows the original error when the attempt fails', async () => {
    let cleaned: unknown = null;
    await expect(
      connectOrCleanUp(
        () => Promise.reject(new Error('host key rejected')),
        (e) => {
          cleaned = e;
        },
      ),
    ).rejects.toThrow('host key rejected');
    expect(cleaned).toBeInstanceOf(Error);
  });

  it('does not clean up on success', async () => {
    let cleaned = false;
    await expect(
      connectOrCleanUp(
        async () => 'ok',
        () => {
          cleaned = true;
        },
      ),
    ).resolves.toBe('ok');
    expect(cleaned).toBe(false);
  });

  it('still reports the connect error when the cleanup itself fails', async () => {
    await expect(
      connectOrCleanUp(
        () => Promise.reject(new Error('tunnel timeout')),
        () => Promise.reject(new Error('disconnect failed')),
      ),
    ).rejects.toThrow('tunnel timeout');
  });
});
