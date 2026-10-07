/**
 * Database memory: short notes the user (or the agent, with approval) keeps
 * about one connection, sent with every AI request bound to it. The rules
 * live here, pure, so main (which enforces them) and the renderer (which
 * explains them) agree.
 */
import { containsSecret } from './redact-secrets';

export const MEMORY_MAX_CHARS = 500;
export const MEMORY_MAX_NOTES = 100;
/** All notes together, as they appear in a prompt. */
export const MEMORY_PROMPT_MAX_CHARS = 6000;

export const MEMORY_ERR_EMPTY = 'Write a note first.';
export const MEMORY_ERR_LONG = `A note can be at most ${MEMORY_MAX_CHARS} characters.`;
export const MEMORY_ERR_DUPLICATE = 'Already remembered.';
export const MEMORY_ERR_SECRET = "Memory can't hold passwords or keys.";
export const MEMORY_ERR_FULL = `This database already has ${MEMORY_MAX_NOTES} notes. Forget one first.`;

export const MEMORY_SECTION_TITLE =
  'Notes about this database (from the user; trust them over guesses)';

/** `user`, `agent`, or `mcp:<client name>`. */
export function isMemorySource(source: string): boolean {
  return source === 'user' || source === 'agent' || /^mcp:.{1,80}$/.test(source);
}

/** The label of a source badge: "You", "Assistant", or the MCP client's name. */
export function memorySourceLabel(source: string): string {
  if (source === 'user') return 'You';
  if (source === 'agent') return 'Assistant';
  if (source.startsWith('mcp:')) return source.slice(4).trim() || 'MCP client';
  return source;
}

/** A note is one paragraph: every run of whitespace (newlines included) becomes one space. */
export function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const norm = (t: string) => normalizeMemoryText(t).toLowerCase();

export type MemoryCheck = { ok: true; text: string } | { ok: false; error: string };

/**
 * Whether `text` can become a note, given the notes the connection has.
 * `selfId` is the note being edited (it may keep its own text).
 */
export function checkMemoryText(
  text: string,
  existing: ReadonlyArray<{ id: string; text: string }>,
  opts: { selfId?: string } = {},
): MemoryCheck {
  const clean = normalizeMemoryText(text);
  if (clean.length === 0) return { ok: false, error: MEMORY_ERR_EMPTY };
  if (clean.length > MEMORY_MAX_CHARS) return { ok: false, error: MEMORY_ERR_LONG };
  if (containsSecret(clean)) return { ok: false, error: MEMORY_ERR_SECRET };
  const others = existing.filter((n) => n.id !== opts.selfId);
  const key = norm(clean);
  if (others.some((n) => norm(n.text) === key)) return { ok: false, error: MEMORY_ERR_DUPLICATE };
  if (opts.selfId === undefined && others.length >= MEMORY_MAX_NOTES) {
    return { ok: false, error: MEMORY_ERR_FULL };
  }
  return { ok: true, text: clean };
}

/** The first 6 characters of a note's id: what the model sees as `m:<shortid>`. */
export const memoryShortId = (id: string): string => id.slice(0, 6);
export const memoryRef = (id: string): string => `m:${memoryShortId(id)}`;

/** The note a model's `m:<shortid>` (or a full id) points at; null when none or ambiguous. */
export function findMemoryByRef<T extends { id: string }>(
  notes: readonly T[],
  ref: string,
): T | null {
  const key = ref
    .trim()
    .replace(/^\[?m:/, '')
    .replace(/\]$/, '');
  if (!key) return null;
  const exact = notes.find((n) => n.id === key);
  if (exact) return exact;
  const hits = notes.filter((n) => memoryShortId(n.id) === key);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

export interface MemoryPromptNote {
  id: string;
  text: string;
  updatedAt: number;
}

export interface MemoryForPrompt {
  /** The note lines, newest-updated first, plus a line saying how many were left out. */
  block: string;
  included: number;
  total: number;
}

/** Notes as prompt lines, newest-updated first, within `MEMORY_PROMPT_MAX_CHARS`. */
export function formatMemoryForPrompt(notes: readonly MemoryPromptNote[]): MemoryForPrompt {
  const sorted = [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
  const lines: string[] = [];
  let used = 0;
  for (const n of sorted) {
    const line = `- [${memoryRef(n.id)}] ${n.text}`;
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (used + cost > MEMORY_PROMPT_MAX_CHARS) break;
    lines.push(line);
    used += cost;
  }
  const left = sorted.length - lines.length;
  if (left > 0) {
    lines.push(
      `(${left} older ${left === 1 ? 'note was' : 'notes were'} left out to keep this short.)`,
    );
  }
  return { block: lines.join('\n'), included: sorted.length - left, total: sorted.length };
}

/** The system-prompt section for a request, or null when there is nothing to send. */
export function memoryPromptSection(notes: readonly MemoryPromptNote[]): {
  text: string;
  count: number;
} | null {
  if (notes.length === 0) return null;
  const f = formatMemoryForPrompt(notes);
  return { text: `--- ${MEMORY_SECTION_TITLE} ---\n${f.block}`, count: f.included };
}

/** Whether memory is sent for a connection: on unless the user turned it off. */
export function isMemoryEnabled(
  connectionId: string | null | undefined,
  settings: { connectionAiMemory?: Record<string, boolean> },
): boolean {
  if (!connectionId) return false;
  return settings.connectionAiMemory?.[connectionId] !== false;
}

/** The tool message for an approved / declined memory card. */
export function memoryActionResult(
  name: 'remember' | 'forget',
  res: {
    outcome: 'applied' | 'rejected' | 'failed' | 'cancelled';
    note?: string;
    memoryId?: string;
  },
): string {
  if (res.outcome === 'applied') {
    return JSON.stringify(
      name === 'remember'
        ? { remembered: true, ...(res.memoryId ? { id: memoryRef(res.memoryId) } : {}) }
        : { forgotten: true },
    );
  }
  if (res.outcome === 'failed') {
    return JSON.stringify({ error: (res.note ?? 'The note was not saved.').slice(0, 300) });
  }
  return JSON.stringify({
    outcome: res.outcome,
    ...(res.note ? { note: res.note.slice(0, 300) } : {}),
  });
}
