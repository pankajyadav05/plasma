import type { RedisGetKeyOpts, RedisWriteOp } from '@shared/protocol';
import { classifyRedisCommand } from '@shared/redis-command-policy';

/**
 * Argument parsing + read-only policy for the Redis IPC handlers in
 * main/index.ts. Pure so it can be unit-tested (S1/S4). Accepts both the
 * current object payloads and the legacy bare string / array forms.
 */

export class RedisReadOnlyError extends Error {
  constructor(what: string) {
    super(`read-only connection: ${what} is not allowed`);
    this.name = 'RedisReadOnlyError';
  }
}

function optDb(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function parseRedisGetKeyArgs(raw: unknown): { key: string; opts?: RedisGetKeyOpts } {
  if (typeof raw === 'string') return { key: raw };
  const p = obj(raw);
  if (typeof p.key !== 'string') throw new Error('key must be a string');
  const o = obj(p.opts);
  const opts: RedisGetKeyOpts = {};
  const db = optDb(o.db);
  if (db !== undefined) opts.db = db;
  if (typeof o.cursor === 'string') opts.cursor = o.cursor;
  if (typeof o.count === 'number' && o.count > 0) opts.count = Math.min(5000, Math.floor(o.count));
  if (typeof o.match === 'string' && o.match) opts.match = o.match;
  if (o.reverse === true) opts.reverse = true;
  return { key: p.key, opts };
}

export function parseRedisKeyArgs(raw: unknown): { key: string; db?: number } {
  if (typeof raw === 'string') return { key: raw };
  const p = obj(raw);
  if (typeof p.key !== 'string') throw new Error('key must be a string');
  return { key: p.key, db: optDb(p.db) };
}

const TTL_MODES = new Set(['expire', 'pexpire', 'expireat', 'persist']);

export function parseRedisSetTtlArgs(raw: unknown): {
  key: string;
  seconds: number;
  db?: number;
  mode?: 'expire' | 'pexpire' | 'expireat' | 'persist';
} {
  const p = obj(raw);
  if (typeof p.key !== 'string') throw new Error('key must be a string');
  if (typeof p.seconds !== 'number' || !Number.isFinite(p.seconds)) {
    throw new Error('seconds must be a number');
  }
  const mode =
    typeof p.mode === 'string' && TTL_MODES.has(p.mode)
      ? (p.mode as 'expire' | 'pexpire' | 'expireat' | 'persist')
      : undefined;
  return { key: p.key, seconds: Math.floor(p.seconds), db: optDb(p.db), mode };
}

export function parseRedisCommandArgs(raw: unknown): { parts: string[]; db?: number } {
  const p = Array.isArray(raw) ? { parts: raw } : obj(raw);
  if (!Array.isArray(p.parts)) throw new Error('parts must be an array');
  const parts = p.parts.map((x) => String(x));
  if (parts.length === 0) throw new Error('empty command');
  return { parts, db: optDb((p as Record<string, unknown>).db) };
}

export function parseRedisBulkDeleteArgs(raw: unknown): { keys: string[]; db?: number } {
  const p = Array.isArray(raw) ? { keys: raw } : obj(raw);
  if (!Array.isArray(p.keys)) throw new Error('keys must be an array');
  return {
    keys: p.keys.map((k) => String(k)),
    db: optDb((p as Record<string, unknown>).db),
  };
}

export function parseRedisWriteArgs(raw: unknown): { op: RedisWriteOp; db?: number } {
  const p = obj(raw);
  // Legacy: the op itself (has `kind`). Current: { op, db }.
  if (typeof p.kind === 'string') return { op: p as unknown as RedisWriteOp };
  if (!p.op || typeof p.op !== 'object') throw new Error('op required');
  return { op: p.op as RedisWriteOp, db: optDb(p.db) };
}

export function parseRedisScanArgs(raw: unknown): {
  cursor: string;
  match?: string;
  count: number;
  db?: number;
  minResults?: number;
  budgetMs?: number;
  type?: string;
} {
  const o = obj(raw);
  const num = (v: unknown, max: number) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(max, Math.floor(v)) : undefined;
  return {
    cursor: typeof o.cursor === 'string' && o.cursor ? o.cursor : '0',
    match: typeof o.match === 'string' && o.match ? o.match : undefined,
    count: num(o.count, 10_000) ?? 500,
    db: optDb(o.db),
    minResults: num(o.minResults, 10_000),
    budgetMs: num(o.budgetMs, 30_000),
    type: typeof o.type === 'string' && o.type ? o.type : undefined,
  };
}

export function parseRedisPatternDeleteArgs(raw: unknown): {
  match: string;
  db?: number;
  dryRun: boolean;
  limit: number;
} {
  const o = obj(raw);
  if (typeof o.match !== 'string' || !o.match) throw new Error('pattern required');
  const limit =
    typeof o.limit === 'number' && o.limit > 0 ? Math.min(1_000_000, Math.floor(o.limit)) : 100_000;
  // Anything but an explicit `false` is a dry run — deleting must be deliberate.
  return { match: o.match, db: optDb(o.db), dryRun: o.dryRun !== false, limit };
}

/** Analyzer sample cap (R14): default 5000, clamped to the protocol max. */
export function clampAnalyzeSample(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 5000;
  return Math.min(50_000, Math.floor(v));
}

/** S1: throw when a read-only connection attempts this redis-cli command. */
export function assertRedisCommandAllowed(parts: string[], readOnly: boolean): void {
  if (!readOnly) return;
  const v = classifyRedisCommand(parts);
  if (v.access === 'write' && v.mode !== 'refuse') {
    throw new RedisReadOnlyError(`${v.verb} (a write command)`);
  }
}

export function assertRedisWritable(readOnly: boolean, what: string): void {
  if (readOnly) throw new RedisReadOnlyError(what);
}
