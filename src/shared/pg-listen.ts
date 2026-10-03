import { z } from 'zod';

/**
 * Postgres LISTEN/NOTIFY tail. The worker listens on a dedicated connection
 * (never the primary, which stays free for queries and keeps its txn state)
 * and batches notifications to main the same way Redis pub/sub is batched.
 */
export const PgNotification = z.object({
  channel: z.string(),
  payload: z.string(),
  /** Backend pid of the notifying session; 0 for Plasma's own flood notices. */
  pid: z.number().int().nonnegative(),
  timestamp: z.number(),
});
export type PgNotification = z.infer<typeof PgNotification>;

/** Channel name of the synthetic notification carrying the drop counter. */
export const PG_LISTEN_SYSTEM_CHANNEL = '(plasma)';

export const PG_LISTEN_MAX_CHANNELS = 50;
/** Postgres limits NOTIFY payloads to just under 8000 bytes. */
export const PG_NOTIFY_MAX_PAYLOAD_BYTES = 7999;

/** Channel names are identifiers: no control characters, at most 63 bytes. */
export function isValidListenChannel(name: string): boolean {
  return (
    name.length > 0 &&
    Buffer.byteLength(name, 'utf8') <= 63 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters on purpose
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

/** Quote an identifier for LISTEN/UNLISTEN (they take identifiers, not parameters). */
export function quoteListenChannel(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export const PgListenRequest = z.object({
  channel: z.string().refine(isValidListenChannel, 'invalid channel name'),
});
export const PgNotifyRequest = z.object({
  channel: z.string().refine(isValidListenChannel, 'invalid channel name'),
  payload: z
    .string()
    .refine((s) => Buffer.byteLength(s, 'utf8') <= PG_NOTIFY_MAX_PAYLOAD_BYTES, 'payload too large')
    .default(''),
});
