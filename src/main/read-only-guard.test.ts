import { describe, expect, it } from 'vitest';
import { ReadOnlyViolationError, assertAllowedOnReadOnly } from './read-only-guard';

const ok = (req: { kind: string } & Record<string, unknown>) =>
  expect(() => assertAllowedOnReadOnly(req)).not.toThrow();
const refused = (req: { kind: string } & Record<string, unknown>) =>
  expect(() => assertAllowedOnReadOnly(req)).toThrow(ReadOnlyViolationError);

describe('assertAllowedOnReadOnly (C1)', () => {
  it('refuses Postgres grid edit commits', () => {
    refused({ kind: 'commitEditBatch', connectionGen: 1, updates: [] });
  });

  it('refuses structure DDL and imports, but lets an import be cancelled', () => {
    refused({
      kind: 'applyDdl',
      request: { connectionGen: 1, transactional: ['DROP TABLE t'], concurrent: [] },
    });
    refused({ kind: 'importRun', job: {} });
    ok({ kind: 'importCancel', jobId: 'j' });
  });

  it('lets SQL through (the server enforces read-only) unless it flips the switch', () => {
    ok({ kind: 'query', sql: 'SELECT * FROM users' });
    ok({ kind: 'sidebandQuery', sql: 'SELECT * FROM pg_stat_activity' });
    refused({ kind: 'query', sql: 'SET default_transaction_read_only = off' });
    refused({ kind: 'query', sql: 'begin read write; delete from t' });
    refused({ kind: 'query', sql: 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE' });
    refused({ kind: 'query', sql: 'set transaction_read_only = off' });
  });

  it('allows transaction control and session plumbing', () => {
    for (const kind of [
      'beginTxn',
      'commitTxn',
      'rollbackTxn',
      'connect',
      'disconnect',
      'cancel',
      'introspect',
      'ping',
    ]) {
      ok({ kind });
    }
  });

  it('refuses Redis writes, deletes and TTL changes', () => {
    refused({ kind: 'redisWrite', op: {} });
    refused({ kind: 'redisDeleteKey', key: 'a' });
    refused({ kind: 'redisBulkDelete', keys: ['a'] });
    refused({ kind: 'redisSetTtl', key: 'a', seconds: 10 });
    refused({ kind: 'redisDeleteByPattern', match: 'a*', dryRun: false });
    ok({ kind: 'redisDeleteByPattern', match: 'a*', dryRun: true });
    ok({ kind: 'redisScan', cursor: '0' });
    ok({ kind: 'redisGetKey', key: 'a' });
  });

  it('only lets read-only Redis console commands through', () => {
    ok({ kind: 'redisCommand', parts: ['GET', 'a'] });
    ok({ kind: 'redisCommand', parts: ['hgetall', 'h'] });
    refused({ kind: 'redisCommand', parts: ['SET', 'a', '1'] });
    refused({ kind: 'redisCommand', parts: ['DEL', 'a'] });
    refused({ kind: 'redisCommand', parts: ['FLUSHALL'] });
    refused({ kind: 'redisCommand', parts: [] });
  });

  it('refuses restoring a backup (pg_restore / psql)', () => {
    refused({ kind: 'adminRestore' });
  });

  it('refuses OpenSearch index and document writes', () => {
    refused({ kind: 'osCreateIndex', name: 'x' });
    refused({ kind: 'osDeleteIndex', name: 'x' });
    refused({ kind: 'osRequest', method: 'PUT', path: '/x/_doc/1' });
    refused({ kind: 'osRequest', method: 'DELETE', path: '/x' });
    refused({ kind: 'osRequest', method: 'POST', path: '/x/_doc' });
    refused({ kind: 'osRequest', method: 'POST', path: '/x/_delete_by_query' });
    ok({ kind: 'osRequest', method: 'GET', path: '/_cat/indices' });
    ok({ kind: 'osRequest', method: 'POST', path: '/x/_search' });
    ok({ kind: 'osRequest', method: 'POST', path: '/x/_count?q=a' });
    ok({ kind: 'osSearch', index: 'x', body: '{}' });
  });

  it('only lets reading OpenSearch SQL through', () => {
    ok({ kind: 'osSql', query: 'SELECT * FROM x' });
    ok({ kind: 'osSql', query: '' }); // cursor page fetch
    refused({ kind: 'osSql', query: 'DELETE FROM x' });
  });

  it('classifies unknown future write kinds by name', () => {
    refused({ kind: 'osDeleteDocument' });
    refused({ kind: 'redisRenameKey' });
    ok({ kind: 'osNodesStats' });
  });

  it('lets ordinary Redis reads through on read-only connections (SC-10)', () => {
    for (const parts of [
      ['HVALS', 'h'],
      ['KEYS', 'user:*'],
      ['LINDEX', 'l', '0'],
      ['GETRANGE', 'k', '0', '3'],
    ]) {
      ok({ kind: 'redisCommand', parts });
    }
    refused({ kind: 'redisCommand', parts: ['EVAL', 'return 1', '0'] });
    refused({ kind: 'redisCommand', parts: ['SYNC'] });
    refused({ kind: 'redisCommand', parts: ['TOUCH', 'k'] });
  });

  it('classifies OpenSearch requests structurally, not by suffix (P0-3 / SC-31)', () => {
    ok({ kind: 'osRequest', method: 'POST', path: '/orders/_search', body: '{}' });
    ok({ kind: 'osRequest', method: 'GET', path: '/orders/_doc/1' });
    refused({ kind: 'osRequest', method: 'POST', path: '/orders/_doc/_search', body: '{"x":1}' });
    refused({ kind: 'osRequest', method: 'POST', path: '/orders/_create/_count', body: '{}' });
    refused({ kind: 'osRequest', method: 'POST', path: '/orders/_doc/1?routing=/_search' });
    refused({ kind: 'osRequest', method: 'POST', path: '/orders/_update/_mget', body: '{}' });
    refused({ kind: 'osRequest', method: 'DELETE', path: '/orders' });
    refused({ kind: 'osSql', query: 'DELETE FROM orders' });
    ok({ kind: 'osSql', query: 'SELECT 1' });
  });
});
