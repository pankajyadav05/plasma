import { describe, expect, it } from 'vitest';
import { errorText, freshSessionPatch, setRoleSql } from './session-connection';

describe('session connection helpers', () => {
  it('resets per-session state for a new connection (B2)', () => {
    const patch = freshSessionPatch();
    expect(patch.schema).toBeNull();
    expect(patch.activeRole).toBeNull();
    expect(patch.availableRoles).toEqual([]);
    expect(patch.currentSchema).toBeNull();
    expect(patch.redisBulkMode).toBe(false);
    expect(patch.selectedRedisKeys.size).toBe(0);
    // Fresh objects each time — never shared between sessions.
    expect(freshSessionPatch().selectedRedisKeys).not.toBe(patch.selectedRedisKeys);
  });

  it('quotes role identifiers', () => {
    expect(setRoleSql('analyst')).toBe('SET ROLE "analyst"');
    expect(setRoleSql('we"ird')).toBe('SET ROLE "we""ird"');
  });

  it('strips the IPC wrapper from error messages', () => {
    expect(
      errorText(
        new Error(
          "Error invoking remote method 'plasma:query:run': Error: permission denied to set role",
        ),
      ),
    ).toBe('permission denied to set role');
  });
});
