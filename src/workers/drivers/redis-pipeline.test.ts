import { describe, expect, it } from 'vitest';
import {
  classifyBulkDelete,
  pipelineCommandError,
  readAnalyzeMeta,
  readScanMeta,
} from './redis-pipeline';

describe('pipelineCommandError', () => {
  it('returns null for a successful tuple', () => {
    expect(pipelineCommandError([null, 1])).toBeNull();
  });

  it('returns the Error message for a command failure', () => {
    expect(pipelineCommandError([new Error('NOPERM this user has no permissions to run the \'del\' command'), null])).toBe(
      "NOPERM this user has no permissions to run the 'del' command",
    );
  });

  it('reports a missing reply', () => {
    expect(pipelineCommandError(undefined)).toBe('missing pipeline reply');
    expect(pipelineCommandError(null)).toBe('missing pipeline reply');
  });
});

describe('classifyBulkDelete', () => {
  it('treats mixed success and NOPERM as partial success', () => {
    const result = classifyBulkDelete(
      ['ok-key', 'denied-key', 'gone-key'],
      [
        [null, 1],
        [new Error('NOPERM'), null],
        [null, 0],
      ],
    );
    expect(result).toEqual({
      deleted: ['ok-key', 'gone-key'],
      failed: [{ key: 'denied-key', error: 'NOPERM' }],
    });
  });

  it('marks every key failed when the reply array is empty', () => {
    const result = classifyBulkDelete(['a', 'b'], []);
    expect(result.deleted).toEqual([]);
    expect(result.failed).toEqual([
      { key: 'a', error: 'missing pipeline reply' },
      { key: 'b', error: 'missing pipeline reply' },
    ]);
  });

  it('returns empty collections for an empty key list', () => {
    expect(classifyBulkDelete([], [])).toEqual({ deleted: [], failed: [] });
  });
});

describe('readScanMeta', () => {
  it('keeps measured type and ttl on success', () => {
    expect(readScanMeta([null, 'string'], [null, 5000])).toEqual({
      typeRaw: 'string',
      pttl: 5000,
      typeError: false,
      ttlError: false,
    });
  });

  it('uses unknown type and null ttl when commands error', () => {
    expect(
      readScanMeta([new Error('NOPERM'), null], [new Error('NOPERM'), null]),
    ).toEqual({
      typeRaw: 'unknown',
      pttl: null,
      typeError: true,
      ttlError: true,
    });
  });
});

describe('readAnalyzeMeta', () => {
  it('preserves a measured zero-byte size', () => {
    expect(readAnalyzeMeta([null, 'string'], [null, -1], [null, 0])).toEqual({
      typeRaw: 'string',
      pttl: -1,
      bytes: 0,
    });
  });

  it('uses null bytes when MEMORY USAGE fails instead of zero', () => {
    expect(
      readAnalyzeMeta([null, 'hash'], [null, -1], [new Error('NOPERM'), null]),
    ).toEqual({
      typeRaw: 'hash',
      pttl: -1,
      bytes: null,
    });
  });

  it('uses null bytes when the MEMORY USAGE reply is missing', () => {
    expect(readAnalyzeMeta([null, 'string'], [null, -1], undefined).bytes).toBeNull();
  });
});
