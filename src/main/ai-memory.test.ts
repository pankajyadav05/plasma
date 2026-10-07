import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addMemory,
  deleteMemory,
  deleteMemoryForConnection,
  ensureMemoryTable,
  listMemory,
  memoryForPrompt,
  updateMemory,
} from './ai-memory';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  ensureMemoryTable(db);
});

const add = (c: string, text: string, source = 'user', now = 1000) => {
  const r = addMemory(db, c, text, source, now);
  if (!r.ok) throw new Error(r.error);
  return r.note;
};

describe('ai memory store', () => {
  it('adds, lists newest-updated first, updates and deletes', () => {
    const a = add('c1', 'first', 'user', 1000);
    const b = add('c1', 'second', 'agent', 2000);
    expect(listMemory(db, 'c1').map((n) => n.text)).toEqual(['second', 'first']);
    expect(b.source).toBe('agent');

    const u = updateMemory(db, a.id, '  first   edited ', 3000);
    expect(u).toMatchObject({ ok: true, note: { text: 'first edited', updatedAt: 3000 } });
    expect(listMemory(db, 'c1').map((n) => n.text)).toEqual(['first edited', 'second']);
    expect(listMemory(db, 'c1')[0]?.createdAt).toBe(1000);

    expect(deleteMemory(db, a.id)).toBe(true);
    expect(deleteMemory(db, a.id)).toBe(false);
    expect(listMemory(db, 'c1')).toHaveLength(1);
  });

  it('accepts mcp:<client> sources and refuses unknown ones', () => {
    expect(addMemory(db, 'c1', 'from claude', 'mcp:Claude Code').ok).toBe(true);
    expect(addMemory(db, 'c1', 'from nobody', 'robot')).toEqual({
      ok: false,
      error: 'Unknown source for a note.',
    });
  });

  it('refuses duplicates, secrets and empty text without writing', () => {
    add('c1', 'orders.amount is in cents');
    expect(addMemory(db, 'c1', 'ORDERS.amount is  in cents', 'user')).toEqual({
      ok: false,
      error: 'Already remembered.',
    });
    expect(addMemory(db, 'c1', 'password = hunter2hunter2', 'user')).toEqual({
      ok: false,
      error: "Memory can't hold passwords or keys.",
    });
    expect(addMemory(db, 'c1', '  ', 'user').ok).toBe(false);
    expect(listMemory(db, 'c1')).toHaveLength(1);
    // The same text on another connection is fine.
    expect(addMemory(db, 'c2', 'orders.amount is in cents', 'user').ok).toBe(true);
  });

  it('caps at 100 notes per connection', () => {
    for (let i = 0; i < 100; i++) add('c1', `note ${i}`);
    expect(addMemory(db, 'c1', 'one too many', 'user').ok).toBe(false);
    expect(addMemory(db, 'c2', 'other connection', 'user').ok).toBe(true);
  });

  it('refuses an update that duplicates another note or holds a secret', () => {
    const a = add('c1', 'alpha');
    add('c1', 'beta');
    expect(updateMemory(db, a.id, 'Beta')).toEqual({ ok: false, error: 'Already remembered.' });
    expect(updateMemory(db, a.id, 'token: abcdefghijklmnop').ok).toBe(false);
    expect(updateMemory(db, 'missing', 'x').ok).toBe(false);
  });

  it('deleting a connection deletes only its notes', () => {
    add('c1', 'a');
    add('c2', 'b');
    deleteMemoryForConnection(db, 'c1');
    expect(listMemory(db, 'c1')).toEqual([]);
    expect(listMemory(db, 'c2')).toHaveLength(1);
  });
});

describe('memoryForPrompt', () => {
  it('holds only the bound connection notes', () => {
    add('c1', 'rule for one');
    add('c2', 'rule for two');
    const m = memoryForPrompt(db, 'c1', {});
    expect(m?.count).toBe(1);
    expect(m?.text).toContain('rule for one');
    expect(m?.text).not.toContain('rule for two');
  });

  it('is empty when the switch is off, there is no connection, or no notes', () => {
    add('c1', 'rule for one');
    expect(memoryForPrompt(db, 'c1', { connectionAiMemory: { c1: false } })).toBeNull();
    expect(memoryForPrompt(db, null, {})).toBeNull();
    expect(memoryForPrompt(db, 'c3', {})).toBeNull();
    // Another connection's switch does not matter.
    expect(memoryForPrompt(db, 'c1', { connectionAiMemory: { c2: false } })).not.toBeNull();
  });
});
