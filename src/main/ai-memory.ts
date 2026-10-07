import { randomUUID } from 'node:crypto';
import {
  type MemoryCheck,
  checkMemoryText,
  isMemoryEnabled,
  isMemorySource,
  memoryPromptSection,
} from '@shared/ai-memory';
import type { MemoryNote } from '@shared/protocol';
import type Database from 'better-sqlite3';

/**
 * Database memory: short notes per saved connection, read by every AI request
 * bound to it (see `@shared/ai-memory` for the rules). Plain SQLite rows; a
 * note never holds a secret (the rules refuse one), and deleting a
 * connection deletes its notes.
 */

export function ensureMemoryTable(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS ai_memory (
      id            TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      text          TEXT NOT NULL,
      source        TEXT NOT NULL,
      created_at    INTEGER,
      updated_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ai_memory_connection ON ai_memory (connection_id);
  `);
}

interface Row {
  id: string;
  connection_id: string;
  text: string;
  source: string;
  created_at: number | null;
  updated_at: number | null;
}

const toNote = (r: Row): MemoryNote => ({
  id: r.id,
  connectionId: r.connection_id,
  text: r.text,
  source: r.source,
  createdAt: r.created_at ?? 0,
  updatedAt: r.updated_at ?? r.created_at ?? 0,
});

/** A connection's notes, newest-updated first. */
export function listMemory(d: Database.Database, connectionId: string): MemoryNote[] {
  return d
    .prepare<[string], Row>(
      'SELECT * FROM ai_memory WHERE connection_id = ? ORDER BY updated_at DESC, created_at DESC, id',
    )
    .all(connectionId)
    .map(toNote);
}

export function getMemory(d: Database.Database, id: string): MemoryNote | null {
  const row = d.prepare<[string], Row>('SELECT * FROM ai_memory WHERE id = ?').get(id);
  return row ? toNote(row) : null;
}

export type MemoryWrite = { ok: true; note: MemoryNote } | { ok: false; error: string };

/** What `addMemory` would refuse, without writing. */
export function checkAddMemory(
  d: Database.Database,
  connectionId: string,
  text: string,
): MemoryCheck {
  return checkMemoryText(text, listMemory(d, connectionId));
}

export function addMemory(
  d: Database.Database,
  connectionId: string,
  text: string,
  source: string,
  now: number = Date.now(),
): MemoryWrite {
  if (!isMemorySource(source)) return { ok: false, error: 'Unknown source for a note.' };
  const checked = checkAddMemory(d, connectionId, text);
  if (!checked.ok) return checked;
  const id = randomUUID().replace(/-/g, '');
  d.prepare(
    'INSERT INTO ai_memory (id, connection_id, text, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, connectionId, checked.text, source, now, now);
  return {
    ok: true,
    note: { id, connectionId, text: checked.text, source, createdAt: now, updatedAt: now },
  };
}

export function updateMemory(
  d: Database.Database,
  id: string,
  text: string,
  now: number = Date.now(),
): MemoryWrite {
  const cur = getMemory(d, id);
  if (!cur) return { ok: false, error: 'That note is gone.' };
  const checked = checkMemoryText(text, listMemory(d, cur.connectionId), { selfId: id });
  if (!checked.ok) return checked;
  d.prepare('UPDATE ai_memory SET text = ?, updated_at = ? WHERE id = ?').run(
    checked.text,
    now,
    id,
  );
  return { ok: true, note: { ...cur, text: checked.text, updatedAt: now } };
}

export function deleteMemory(d: Database.Database, id: string): boolean {
  return d.prepare('DELETE FROM ai_memory WHERE id = ?').run(id).changes > 0;
}

/** A deleted connection takes its notes with it. */
export function deleteMemoryForConnection(d: Database.Database, connectionId: string): void {
  d.prepare('DELETE FROM ai_memory WHERE connection_id = ?').run(connectionId);
}

/**
 * The memory section of an AI request bound to `connectionId`: null when the
 * chat has no connection, the connection's "Use memory" switch is off, or it
 * has no notes. Only that connection's notes are ever read.
 */
export function memoryForPrompt(
  d: Database.Database,
  connectionId: string | null | undefined,
  settings: { connectionAiMemory?: Record<string, boolean> },
): { text: string; count: number } | null {
  if (!connectionId || !isMemoryEnabled(connectionId, settings)) return null;
  return memoryPromptSection(listMemory(d, connectionId));
}
