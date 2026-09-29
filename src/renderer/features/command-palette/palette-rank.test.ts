import { describe, expect, it } from 'vitest';
import { rankItems, scoreText } from './palette-rank';

const item = (group: string, label: string, keywords?: string[]) => ({ group, label, keywords });

describe('palette ranking (VF23 / H1)', () => {
  it('puts a prefix match above a scattered-letter match', () => {
    const ranked = rankItems('ord', [
      item('Actions', 'Toggle dark mode'),
      item('Tables', 'orders', ['public.orders']),
    ]);
    expect(ranked.map((r) => r.label)).toEqual(['orders', 'Toggle dark mode']);
  });

  it('orders exact > prefix > word prefix > substring > subsequence', () => {
    const q = 'user';
    const s = (t: string) => scoreText(q, t);
    expect(s('user')).toBeGreaterThan(s('users'));
    expect(s('users')).toBeGreaterThan(s('app_users'));
    expect(s('app_users')).toBeGreaterThan(s('superusers'));
    expect(s('superusers')).toBeGreaterThan(s('u_s_e_r'));
    expect(s('nothing')).toBe(-1);
  });

  it('matches multi-word queries against word starts', () => {
    expect(scoreText('tog dark', 'Toggle dark mode')).toBeGreaterThan(0);
  });

  it('caps a group after filtering, so table 101+ is findable', () => {
    const tables = Array.from({ length: 500 }, (_, i) => item('Tables', `t_${i}`));
    const ranked = rankItems('t_450', tables, { limitPerGroup: { Tables: 100 } });
    expect(ranked[0]?.label).toBe('t_450');
    const all = rankItems('t_', tables, { limitPerGroup: { Tables: 100 } });
    expect(all).toHaveLength(100);
  });

  it('uses keywords (qualified names) with the label winning ties', () => {
    const ranked = rankItems('sales.or', [item('Tables', 'orders', ['sales.orders'])]);
    expect(ranked).toHaveLength(1);
  });
});
