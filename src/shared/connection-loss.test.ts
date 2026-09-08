import { describe, expect, it } from 'vitest';
import { ConnectionLostError, isConnectionLostError } from './connection-loss';

/**
 * U27 — the reconnect path hinges on telling a dead transport from a
 * rejected statement. False negatives leave the user with the bug this
 * fixes (dead session until restart); false positives throw away a live
 * session over a typo in SQL, so the SQL-level cases matter as much.
 */

describe('isConnectionLostError', () => {
  it.each([
    // pg, observed against a socket reset mid-session
    'Connection terminated unexpectedly',
    'Client has encountered a connection error and is not queryable',
    'terminating connection due to administrator command',
    // ioredis
    'Connection is closed.',
    "Stream isn't writeable and enableOfflineQueue options is false",
    'max retries per request limit reached',
    // node socket / dns
    'read ECONNRESET',
    'connect ECONNREFUSED 127.0.0.1:5432',
    'getaddrinfo ENOTFOUND db.internal',
    'connect ETIMEDOUT 10.0.0.5:5432',
    'socket hang up',
  ])('treats %j as a lost transport', (message) => {
    expect(isConnectionLostError(new Error(message))).toBe(true);
  });

  it.each([
    'relation "users" does not exist',
    'syntax error at or near "SELCT"',
    'permission denied for table orders',
    'canceling statement due to statement timeout',
    'duplicate key value violates unique constraint "users_pkey"',
    'connection generation mismatch: edit batch is for generation 2, current is 3',
    'rejected: AI queries must be a single SQL statement',
  ])('leaves %j alone', (message) => {
    expect(isConnectionLostError(new Error(message))).toBe(false);
  });

  it('recognises the OpenSearch transport error classes by name', () => {
    const err = new Error('Response timeout');
    err.name = 'TimeoutError';
    expect(isConnectionLostError(err)).toBe(true);
  });

  it('recognises a socket error carrying only a code', () => {
    const err = Object.assign(new Error('write failed'), { code: 'EPIPE' });
    expect(isConnectionLostError(err)).toBe(true);
  });

  it('recognises its own error type regardless of wording', () => {
    expect(isConnectionLostError(new ConnectionLostError('primary went away'))).toBe(true);
    expect(new ConnectionLostError('primary went away').message).toBe(
      'connection lost: primary went away',
    );
  });

  it('does not double-prefix an already-prefixed reason', () => {
    expect(new ConnectionLostError('connection lost: aux died').message).toBe(
      'connection lost: aux died',
    );
  });

  it('ignores non-error values', () => {
    expect(isConnectionLostError(null)).toBe(false);
    expect(isConnectionLostError({ message: 'ECONNRESET' })).toBe(false);
  });
});
