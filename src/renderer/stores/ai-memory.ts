import { ipc } from '@/lib/ipc';
import type { MemoryNote } from '@shared/protocol';
import { create } from 'zustand';

/**
 * The notes of the connections the UI has looked at, and which connection's
 * memory view is open. Main owns the rules and the data; this only mirrors it
 * so the AI panel's count and the memory view stay in step.
 */
interface MemoryState {
  notes: Record<string, MemoryNote[]>;
  /** The memory view is open for this saved connection. */
  viewing: { id: string; name: string } | null;
  load(connectionId: string): Promise<MemoryNote[]>;
  add(
    connectionId: string,
    text: string,
    source?: string,
  ): Promise<{ ok: true; note: MemoryNote } | { ok: false; error: string }>;
  update(
    connectionId: string,
    id: string,
    text: string,
  ): Promise<{ ok: true; note: MemoryNote } | { ok: false; error: string }>;
  remove(connectionId: string, id: string): Promise<void>;
  open(connection: { id: string; name: string }): void;
  close(): void;
}

export const useMemory = create<MemoryState>((set, get) => ({
  notes: {},
  viewing: null,
  async load(connectionId) {
    try {
      const list = await ipc.memory.list(connectionId);
      set((s) => ({ notes: { ...s.notes, [connectionId]: list } }));
      return list;
    } catch {
      return get().notes[connectionId] ?? [];
    }
  },
  async add(connectionId, text, source = 'user') {
    try {
      const res = await ipc.memory.add({ connectionId, text, source });
      if (res.ok) await get().load(connectionId);
      return res;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  async update(connectionId, id, text) {
    try {
      const res = await ipc.memory.update({ connectionId, id, text });
      if (res.ok) await get().load(connectionId);
      return res;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  async remove(connectionId, id) {
    try {
      await ipc.memory.delete({ connectionId, id });
    } finally {
      await get().load(connectionId);
    }
  },
  open: (viewing) => set({ viewing }),
  close: () => set({ viewing: null }),
}));
