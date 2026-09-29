import { describe, expect, it } from 'vitest';
import { osWriteAccess } from './os-write';

describe('osWriteAccess (S1)', () => {
  const base = { connected: true, readOnly: false, editMode: true, tag: undefined };

  it('allows writes in edit mode on a writable connection', () => {
    expect(osWriteAccess(base)).toEqual({ canWrite: true, reason: null, prod: false });
  });

  it('blocks read-only connections even in edit mode', () => {
    const a = osWriteAccess({ ...base, readOnly: true });
    expect(a.canWrite).toBe(false);
    expect(a.reason).toMatch(/Read-only/);
  });

  it('blocks writes in safe mode', () => {
    const a = osWriteAccess({ ...base, editMode: false });
    expect(a.canWrite).toBe(false);
    expect(a.reason).toMatch(/edit mode/);
  });

  it('flags prod connections for confirmation', () => {
    expect(osWriteAccess({ ...base, tag: 'prod' }).prod).toBe(true);
    expect(osWriteAccess({ ...base, tag: 'dev' }).prod).toBe(false);
  });

  it('blocks when disconnected', () => {
    expect(osWriteAccess({ ...base, connected: false }).canWrite).toBe(false);
  });
});
