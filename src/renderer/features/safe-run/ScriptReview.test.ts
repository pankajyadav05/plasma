import type { SafeRunState } from '@/stores/session-safe-run';
import type { SafeRunReport, SafeRunStep } from '@shared/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ScriptReview } from './ScriptReview';

const step = (index: number, status: SafeRunStep['status']): SafeRunStep => ({
  index,
  status,
  error: status === 'failed' ? 'duplicate key' : null,
  kind: 'update',
  statement: `UPDATE t${index} SET v = 1`,
  affected: status === 'done' ? 3 : 0,
  affectedExact: true,
  estimateRows: null,
  mode: 'after-only',
  note: null,
  keyKind: 'none',
  keyColumns: [],
  beforeColumns: [],
  before: null,
  beforeCtids: null,
  beforeTotal: 0,
  afterColumns: [],
  after: [],
  afterCtids: null,
  afterTotal: 0,
  durationMs: 2,
  beforeTruncated: false,
  afterTruncated: false,
  notices: [],
});

function render(
  statuses: SafeRunStep['status'][],
  phase: SafeRunState['phase'] = 'review',
  extra: Partial<SafeRunState> = {},
) {
  const steps = statuses.map((s, i) => step(i + 1, s));
  const failed = steps.find((s) => s.status === 'failed');
  const report = {
    runId: 'r',
    kind: 'update',
    statement: 'script',
    nested: false,
    affected: steps.reduce((n, s) => n + s.affected, 0),
    affectedExact: true,
    estimateRows: null,
    mode: 'after-only',
    note: null,
    keyKind: 'none',
    keyColumns: [],
    beforeColumns: [],
    before: null,
    beforeCtids: null,
    beforeTotal: 0,
    afterColumns: [],
    after: [],
    afterCtids: null,
    afterTotal: 0,
    durationMs: 1,
    expiresAt: Date.now() + 60_000,
    timeoutSec: 60,
    txnState: 'active',
    steps,
    failedAt: failed?.index ?? null,
  } as SafeRunReport;
  const sr: SafeRunState = {
    tabId: 't',
    sql: 'script',
    phase,
    report,
    error: null,
    endReason: null,
    outcomeUnknown: false,
    notice: null,
    finishing: null,
    connectionGen: 1,
    token: 1,
    nudge: 0,
    ...extra,
  };
  return renderToStaticMarkup(
    createElement(ScriptReview, {
      sr,
      report,
      steps,
      threshold: 1000,
      msLeft: 60_000,
      pulse: false,
      onCommit: vi.fn(),
      onCommitPartial: vi.fn(),
      onRollback: vi.fn(),
      onUndo: vi.fn(),
      onClose: vi.fn(),
    }),
  );
}

describe('ScriptReview', () => {
  it('lists every statement and offers commit all, undo and roll back', () => {
    const html = render(['done', 'done', 'done']);
    for (const n of [1, 2, 3]) expect(html).toContain(`data-testid="safe-run-statement-${n}"`);
    expect(html).toContain('data-testid="safe-run-commit"');
    expect(html).toContain('data-testid="safe-run-undo-last"');
    expect(html).toContain('data-testid="safe-run-rollback"');
    expect(html).not.toContain('safe-run-commit-partial');
    expect(html).toContain('Safe Run · 3 statements · 9 rows changed in total');
  });

  it('after a failure there is no Commit all, only the labelled partial commit', () => {
    const html = render(['done', 'done', 'failed', 'notRun']);
    expect(html).not.toContain('data-testid="safe-run-commit"');
    expect(html).toContain('data-testid="safe-run-commit-partial"');
    expect(html).toContain('Commit 1–2');
    expect(html).toContain('Failed at statement 3');
    expect(html).toContain('duplicate key');
    expect(html).toContain('data-testid="safe-run-rollback"');
  });

  it('shows no decision buttons once the run has ended', () => {
    const html = render(['done', 'done'], 'committed');
    expect(html).not.toContain('safe-run-commit"');
    expect(html).not.toContain('safe-run-rollback');
    expect(html).toContain('Committed 2 statements');
  });
});

describe('ScriptReview status line', () => {
  const statusOf = (html: string) => /data-testid="safe-run-status">([^<]*)</.exec(html)?.[1] ?? '';

  it('never says rolled back when the outcome is unknown or the run did not finish', () => {
    expect(statusOf(render(['done', 'done'], 'failed', { outcomeUnknown: true }))).toBe(
      'Outcome unknown',
    );
    expect(statusOf(render(['done', 'done'], 'failed'))).toBe('Did not finish');
  });
  it('shows the end state, not "failed at", after a partial commit or a roll back', () => {
    expect(statusOf(render(['done', 'failed', 'notRun'], 'committed'))).toBe(
      'Committed statements before 2',
    );
    expect(statusOf(render(['done', 'failed', 'notRun'], 'rolledBack'))).toBe('Rolled back');
    expect(statusOf(render(['done', 'failed', 'notRun'], 'review'))).toBe('Failed at statement 2');
  });
  it('words the partial-commit tooltip to include undone statements', () => {
    const html = render(['done', 'failed']);
    expect(html).toContain('any you undid');
  });
});
