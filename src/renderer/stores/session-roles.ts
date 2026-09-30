/** Role slice: SET ROLE / RESET ROLE and the RLS policy badge. */
import { ipc } from '@/lib/ipc';
import { buildRolesSql } from '@/lib/table-query';
import { errorText, setRoleSql } from './session-connection';
import { activeTab } from './session-tab-model';
import { LOOKUP_TIMEOUT_MS, loadTableTab } from './session-table-query';
import type { SliceCreator } from './session-types';

export interface RolesSlice {
  // ── role + RLS ──
  /** The role currently SET on the worker connection. null = backend default. */
  activeRole: string | null;
  availableRoles: string[];
  /** G2 / C15: why the last SET ROLE / RESET ROLE failed, or a role that was lost on reconnect. */
  roleError: string | null;
  // Role + RLS
  loadAvailableRoles(): Promise<void>;
  setActiveRole(role: string | null): Promise<void>;
}

export const createRolesSlice: SliceCreator<RolesSlice> = (set, get) => ({
  activeRole: null,
  roleError: null,
  availableRoles: [],

  async loadAvailableRoles() {
    try {
      const { sql, params } = buildRolesSql();
      const res = await ipc.query.sideband(sql, params, { timeoutMs: LOOKUP_TIMEOUT_MS });
      const roles = res.rows.map((r) => (r[0] as string | null) ?? '').filter((s) => s.length > 0);
      set({ availableRoles: roles });
    } catch (err) {
      console.error('[plasma] loadAvailableRoles failed', err);
    }
  },

  async setActiveRole(role) {
    try {
      if (role === null) {
        await ipc.query.run('RESET ROLE', undefined, { internal: true });
      } else {
        // Identifier interpolation is unavoidable for SET ROLE; we
        // cross-check against the loaded role list so an unfamiliar name
        // gets rejected client-side first.
        const allowed = get().availableRoles.includes(role);
        if (!allowed) throw new Error(`unknown role: ${role}`);
        await ipc.query.run(setRoleSql(role), undefined, { internal: true });
      }
      set({ activeRole: role, roleError: null });
      // Re-run the active table tab so the new role's RLS policies apply.
      const tab = activeTab(get());
      if (tab?.kind === 'table') {
        loadTableTab(set, get, tab.id);
      }
    } catch (err) {
      // G2: say why instead of failing silently.
      console.error('[plasma] setActiveRole failed', err);
      set({ roleError: errorText(err) });
    }
  },
});
