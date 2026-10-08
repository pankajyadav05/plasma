import type { SafeRunReport, SafeRunStep } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import { historySql, recordOfReport } from './safe-run-record';

const step = (index: number, status: SafeRunStep['status']) =>
  ({
    index,
    status,
    statement: `UPDATE t${index} SET v = 1`,
    affected: status === 'done' ? 2 : 0,
    durationMs: 3,
  }) as SafeRunStep;

const report = (statuses: SafeRunStep['status'][], indices?: number[]) =>
  ({
    runId: 'r',
    affected: 0,
    durationMs: 1,
    steps: statuses.map((s, i) => step(indices?.[i] ?? i + 1, s)),
  }) as SafeRunReport;

describe('safe run history record', () => {
  it('stores a single statement exactly as typed', () => {
    const rec = recordOfReport(
      { runId: 'r', affected: 4, durationMs: 1 } as SafeRunReport,
      'DELETE FROM t;',
      5,
    );
    expect(historySql(rec)).toBe('DELETE FROM t;');
    expect(rec.statements).toEqual([
      { index: 1, sql: 'DELETE FROM t;', affected: 4, durationMs: 1 },
    ]);
  });

  it('stores a complete script as typed', () => {
    const rec = recordOfReport(report(['done', 'done']), 'A; B;', 5);
    expect(historySql(rec)).toBe('A; B;');
  });

  it('after a failure only the committed statements are stored, with a note', () => {
    const rec = recordOfReport(report(['done', 'done', 'failed', 'notRun']), 'A; B; C; D;', 5);
    const sql = historySql(rec);
    expect(sql).toMatch(/^-- Safe Run committed 2 of 4 statements \(1, 2\)\n/);
    expect(sql).toContain('UPDATE t1 SET v = 1;');
    expect(sql).not.toContain('t3');
    expect(sql).not.toContain('t4');
  });

  it('after an undo the original size is remembered', () => {
    const first = recordOfReport(report(['done', 'done', 'done']), 'A; B; C;', 5);
    const after = recordOfReport(report(['done', 'done']), 'A; B; C;', 5, first);
    expect(after.scriptSize).toBe(3);
    expect(historySql(after)).toMatch(/committed 2 of 3 statements \(1, 2\)/);
  });
});
