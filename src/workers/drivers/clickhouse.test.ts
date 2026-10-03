import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  clickhouseReturnsRows,
  friendlyClickhouseError,
  jsonLines,
  normalizeClickhouseCell,
} from './clickhouse';

describe('normalizeClickhouseCell', () => {
  it('turns 64-bit integers into numbers only when they are safe', () => {
    expect(normalizeClickhouseCell('42', 'UInt64')).toBe(42);
    expect(normalizeClickhouseCell('-7', 'Nullable(Int64)')).toBe(-7);
    expect(normalizeClickhouseCell('18446744073709551615', 'UInt64')).toBe('18446744073709551615');
    expect(normalizeClickhouseCell('9007199254740993', 'Int64')).toBe('9007199254740993');
  });

  it('leaves everything else alone and rescues an unquoted unsafe integer', () => {
    expect(normalizeClickhouseCell('12.34', 'Decimal(10, 2)')).toBe('12.34');
    expect(normalizeClickhouseCell('abc', 'String')).toBe('abc');
    expect(normalizeClickhouseCell(['a'], 'Array(String)')).toEqual(['a']);
    expect(normalizeClickhouseCell(1.8446744073709552e19, 'UInt64')).toBe('18446744073709552000');
    expect(normalizeClickhouseCell(5, 'UInt8')).toBe(5);
  });
});

describe('clickhouseReturnsRows', () => {
  it('separates queries from commands', () => {
    for (const sql of [
      'SELECT 1',
      ' with x as (select 1) select * from x',
      'SHOW TABLES',
      'DESCRIBE t',
      'EXPLAIN SELECT 1',
      '(SELECT 1) UNION ALL (SELECT 2)',
      'EXISTS TABLE t',
    ]) {
      expect(clickhouseReturnsRows(sql), sql).toBe(true);
    }
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'CREATE TABLE t (a Int8) ENGINE = Memory',
      'ALTER TABLE t UPDATE a = 1 WHERE 1',
      'DROP TABLE t',
      'OPTIMIZE TABLE t',
      'SYSTEM FLUSH LOGS',
    ]) {
      expect(clickhouseReturnsRows(sql), sql).toBe(false);
    }
  });
});

describe('jsonLines', () => {
  it('splits a body into lines across chunk boundaries, including multi-byte characters', async () => {
    const bytes = Buffer.from('["a","é"]\n[1,2]\n[3');
    const chunks = [bytes.subarray(0, 7), bytes.subarray(7, 12), bytes.subarray(12)];
    const out: string[] = [];
    for await (const line of jsonLines(Readable.from(chunks))) out.push(line);
    expect(out).toEqual(['["a","é"]', '[1,2]', '[3']);
  });
});

describe('friendlyClickhouseError', () => {
  it('names timeouts and cancellations the way the other engines do', () => {
    const timeout = Object.assign(new Error('Timeout exceeded: elapsed 1.0 seconds'), {
      code: '159',
    });
    expect(friendlyClickhouseError(timeout).message).toBe(
      'canceling statement due to statement timeout',
    );
    const killed = Object.assign(new Error('Query was cancelled'), { code: '394' });
    expect(friendlyClickhouseError(killed).message).toBe('canceling statement due to user request');
    expect(friendlyClickhouseError(new Error('Table x does not exist')).message).toBe(
      'Table x does not exist',
    );
  });
});
