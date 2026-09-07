/**
 * Pure helpers for inspecting ioredis `pipeline.exec()` replies.
 *
 * `exec()` resolves to an array of `[error, result]` tuples — individual
 * command errors do NOT reject the promise. Callers that ignore the error
 * slot silently treat ACL / OOM / WRONGTYPE failures as success (or as
 * measured zeros). These helpers surface that distinction.
 */

export type PipelineTuple = [Error | null, unknown] | null | undefined;

export type RedisBulkDeleteFailure = { key: string; error: string };

export type RedisBulkDeleteResult = {
  /** Keys whose DEL command completed without a per-command error. */
  deleted: string[];
  /** Keys whose DEL command returned a command-level error. */
  failed: RedisBulkDeleteFailure[];
};

/** Extract a human-readable error from one pipeline tuple, or null on success. */
export function pipelineCommandError(entry: PipelineTuple): string | null {
  if (entry == null) return 'missing pipeline reply';
  const err = entry[0];
  if (err == null) return null;
  if (err instanceof Error) return err.message || err.name || 'command failed';
  return String(err);
}

/**
 * Classify bulk DEL pipeline replies into deleted vs failed keys.
 * A DEL that returns 0 (key already absent) is still a successful command.
 */
export function classifyBulkDelete(
  keys: string[],
  results: Array<[Error | null, unknown] | null> | null | undefined,
): RedisBulkDeleteResult {
  const deleted: string[] = [];
  const failed: RedisBulkDeleteFailure[] = [];
  const rows = results ?? [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const err = pipelineCommandError(rows[i]);
    if (err) failed.push({ key, error: err });
    else deleted.push(key);
  }
  return { deleted, failed };
}

export type ScanMetaFields = {
  typeRaw: string;
  /** null = unavailable / error; number = measured PTTL (may be -1/-2). */
  pttl: number | null;
  typeError: boolean;
  ttlError: boolean;
};

/** Read TYPE + PTTL tuples for one key; errors → unknown type / null ttl. */
export function readScanMeta(
  typeEntry: PipelineTuple,
  ttlEntry: PipelineTuple,
): ScanMetaFields {
  const typeErr = pipelineCommandError(typeEntry);
  const ttlErr = pipelineCommandError(ttlEntry);
  const typeRaw = typeErr ? 'unknown' : String(typeEntry?.[1] ?? 'unknown');
  let pttl: number | null;
  if (ttlErr) {
    pttl = null;
  } else {
    const n = Number(ttlEntry?.[1] ?? -1);
    pttl = Number.isFinite(n) ? n : null;
  }
  return {
    typeRaw,
    pttl,
    typeError: typeErr != null,
    ttlError: ttlErr != null,
  };
}

export type AnalyzeMetaFields = {
  typeRaw: string;
  pttl: number | null;
  /** null = MEMORY USAGE unavailable (ACL/error); 0 = measured empty key. */
  bytes: number | null;
};

/** Read TYPE + PTTL + MEMORY USAGE tuples; never coerce errors to zero. */
export function readAnalyzeMeta(
  typeEntry: PipelineTuple,
  ttlEntry: PipelineTuple,
  memEntry: PipelineTuple,
): AnalyzeMetaFields {
  const scan = readScanMeta(typeEntry, ttlEntry);
  const memErr = pipelineCommandError(memEntry);
  let bytes: number | null = null;
  if (!memErr && memEntry != null && memEntry[1] != null) {
    const n = Number(memEntry[1]);
    bytes = Number.isFinite(n) ? n : null;
  }
  return { typeRaw: scan.typeRaw, pttl: scan.pttl, bytes };
}
