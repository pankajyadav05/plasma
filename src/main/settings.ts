import { ensureOpenTabsTable, getDb } from './db';
import {
  type OpenTabsSnapshot,
  type PersistedOpenTab,
  PersistedOpenTab as PersistedOpenTabSchema,
} from '@shared/protocol';

/**
 * Key-value settings store backed by SQLite.
 * Values are JSON-serialized strings; callers get/set typed values.
 *
 * Also owns the U25 `open_tabs` persistence helpers (session restore).
 * SQL drafts are stored plaintext — same exposure class as query_history
 * (planner Q2).
 */

export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb()
    .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
    .get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting<T>(key: string, value: T): void {
  const serialized = JSON.stringify(value);
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, serialized);
}

export function getAllSettings(): Record<string, unknown> {
  const rows = getDb()
    .prepare<[], { key: string; value: string }>('SELECT key, value FROM settings')
    .all();
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

// ─── Open tabs (U25 session restore) ─────────────────────────────────

interface OpenTabRow {
  connection_id: string;
  position: number;
  tab_id: string;
  kind: string;
  title: string;
  sql: string;
  state_json: string;
  is_active: number;
  updated_at: number;
}

function parseStateJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowToPersisted(row: OpenTabRow): PersistedOpenTab {
  const state = parseStateJson(row.state_json);
  return PersistedOpenTabSchema.parse({
    id: row.tab_id,
    title: row.title,
    kind: row.kind,
    sql: row.sql,
    ...state,
  });
}

/**
 * Load persisted tabs for a connection, ordered by position.
 * Returns an empty snapshot when nothing was saved.
 */
export function loadOpenTabs(connectionId: string): OpenTabsSnapshot {
  ensureOpenTabsTable();
  const rows = getDb()
    .prepare<[string], OpenTabRow>(
      `SELECT * FROM open_tabs
         WHERE connection_id = ?
         ORDER BY position ASC`,
    )
    .all(connectionId);

  if (rows.length === 0) {
    return { tabs: [], activeTabId: null };
  }

  const tabs = rows.map(rowToPersisted);
  const active = rows.find((r) => r.is_active === 1);
  return {
    tabs,
    activeTabId: active?.tab_id ?? tabs[0]?.id ?? null,
  };
}

/**
 * Replace the entire open-tab set for a connection in one transaction.
 * Passing an empty tabs array clears the saved session for that connection.
 */
export function saveOpenTabs(connectionId: string, snapshot: OpenTabsSnapshot): void {
  ensureOpenTabsTable();
  const db = getDb();
  const now = Date.now();
  const activeId = snapshot.activeTabId;

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM open_tabs WHERE connection_id = ?').run(connectionId);

    const insert = db.prepare(
      `INSERT INTO open_tabs
         (connection_id, position, tab_id, kind, title, sql, state_json, is_active, updated_at)
         VALUES (@connectionId, @position, @tabId, @kind, @title, @sql, @stateJson, @isActive, @updatedAt)`,
    );

    snapshot.tabs.forEach((tab, position) => {
      const {
        id,
        title,
        kind,
        sql,
        ...rest
      } = tab;
      insert.run({
        connectionId,
        position,
        tabId: id,
        kind,
        title,
        sql: sql ?? '',
        stateJson: JSON.stringify(rest),
        isActive: activeId === id ? 1 : 0,
        updatedAt: now,
      });
    });
  });
  tx();
}

/** Drop any saved session for a connection (e.g. on vault delete). */
export function clearOpenTabs(connectionId: string): void {
  ensureOpenTabsTable();
  getDb().prepare('DELETE FROM open_tabs WHERE connection_id = ?').run(connectionId);
}
