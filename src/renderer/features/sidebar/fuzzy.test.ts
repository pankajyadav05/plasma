import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch } from './fuzzy';

describe('fuzzyMatch', () => {
  it('matches everything on an empty query', () => {
    expect(fuzzyMatch('', 'users')).toEqual({ score: 0, indices: [] });
  });

  it('matches in-order subsequences case-insensitively', () => {
    expect(fuzzyMatch('usac', 'user_accounts')?.indices).toEqual([0, 1, 5, 6]);
    expect(fuzzyMatch('UA', 'user_accounts')).not.toBeNull();
  });

  it('rejects out-of-order or missing characters', () => {
    expect(fuzzyMatch('xu', 'users')).toBeNull();
    expect(fuzzyMatch('sru', 'users')).toBeNull();
  });

  it('prefers word starts for scattered matches', () => {
    // "ua" should pick the "a" of "accounts", not the one inside "users_data".
    expect(fuzzyMatch('ua', 'user_accounts')?.indices).toEqual([0, 5]);
  });

  it('ranks exact > prefix > substring > subsequence', () => {
    const exact = fuzzyMatch('orders', 'orders')!.score;
    const prefix = fuzzyMatch('orders', 'orders_archive')!.score;
    const sub = fuzzyMatch('orders', 'old_orders')!.score;
    const seq = fuzzyMatch('orders', 'o_r_d_e_r_s')!.score;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(seq);
  });
});

describe('fuzzyFilter', () => {
  const names = ['payments', 'user_accounts', 'users', 'audit_log', 'user_sessions'];

  it('returns the input unchanged for an empty query', () => {
    expect(fuzzyFilter(names, '  ', (n) => n)).toEqual(names);
  });

  it('filters and ranks best-first', () => {
    expect(fuzzyFilter(names, 'users', (n) => n)[0]).toBe('users');
    expect(fuzzyFilter(names, 'uacc', (n) => n)).toEqual(['user_accounts']);
    expect(fuzzyFilter(names, 'zzz', (n) => n)).toEqual([]);
  });
});
