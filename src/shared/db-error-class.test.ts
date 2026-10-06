import { describe, expect, it } from 'vitest';
import { describeDbErrorSafely } from './db-error-class';

describe('describeDbErrorSafely', () => {
  it('names the category and SQLSTATE, never the driver text', () => {
    const cases: Array<[string, string]> = [
      ["Duplicate entry 'alice@corp.com' for key 'users.email'", 'duplicate key (23505)'],
      ['duplicate key value violates unique constraint "users_email_key"', 'duplicate key (23505)'],
      ['permission denied for table users', 'permission denied (42501)'],
      ['syntax error at or near "FROM"', 'syntax error (42601)'],
      ['relation "orders" does not exist', 'table does not exist (42P01)'],
      ['column "x" does not exist', 'column does not exist (42703)'],
      ['customer alice has balance 12 (trigger)', 'the statement failed'],
      [
        'Constraint Error: Duplicate key "email: alice@corp.com" violates primary key',
        'duplicate key (23505)',
      ],
    ];
    for (const [msg, out] of cases) {
      const got = describeDbErrorSafely(msg);
      expect(got, msg).toBe(out);
      expect(got).not.toContain('alice');
    }
  });

  it('prefers an explicit SQLSTATE in the text', () => {
    expect(describeDbErrorSafely('error (SQLSTATE 23514) check constraint "c" violated')).toBe(
      'check constraint violation (23514)',
    );
    expect(describeDbErrorSafely('something odd, code: 0A000')).toBe(
      'the statement failed (0A000)',
    );
  });
});
