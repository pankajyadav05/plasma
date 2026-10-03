import { describe, expect, it } from 'vitest';
import { EMPTY_AUDIT_FILTER, auditFilterOf } from './audit-filter';

describe('auditFilterOf', () => {
  it('leaves everything unset for the empty draft', () => {
    expect(auditFilterOf(EMPTY_AUDIT_FILTER)).toEqual({
      connectionId: undefined,
      from: undefined,
      to: undefined,
      outcome: undefined,
      text: undefined,
    });
  });

  it('turns days into a local-time range that includes the whole last day', () => {
    const f = auditFilterOf({
      ...EMPTY_AUDIT_FILTER,
      fromDate: '2026-10-01',
      toDate: '2026-10-02',
    });
    expect(f.from).toBe(new Date(2026, 9, 1).getTime());
    expect(f.to).toBe(new Date(2026, 9, 3).getTime() - 1);
  });

  it('ignores malformed dates and trims text', () => {
    const f = auditFilterOf({
      connectionId: 'c1',
      fromDate: 'yesterday',
      toDate: '',
      outcome: 'error',
      text: '  drop  ',
    });
    expect(f).toMatchObject({
      connectionId: 'c1',
      from: undefined,
      outcome: 'error',
      text: 'drop',
    });
  });
});
