import { Button } from '@/components/ui/button';
import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { Badge, EmptyState, SectionHeading } from '@/components/ui/view-parts';
import { Segmented } from '@/components/ui/workbench';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import {
  PG_CHECKS,
  type StatementsOutcome,
  runPgCheck,
  runStatementsCheck,
} from '@shared/health/pg-checks';
import {
  STATEMENTS_ENABLE_STEPS,
  type StatementRow,
  explainSql,
} from '@shared/health/pg-statements';
import {
  type CheckResult,
  type HealthFinding,
  STATUS_ORDER,
  fmtDurationMs,
  fmtInt,
  fmtPct,
  rowsToObjects,
  worstStatus,
} from '@shared/health/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityPanel } from './ActivityPanel';
import {
  CheckSection,
  FindingRow,
  FixDialog,
  HealthTile,
  type PendingFix,
  TileStrip,
} from './health-ui';

type Tab = 'overview' | 'activity' | 'queries' | 'indexes' | 'maintenance';

const pgQuery = async (sql: string, params: unknown[] | undefined, timeoutMs: number) =>
  rowsToObjects(await ipc.query.sideband(sql, params, { timeoutMs }));

interface TileDef {
  label: string;
  ids: string[];
  tab: Tab;
}

const TILES: TileDef[] = [
  { label: 'Cache hit', ids: ['ov-cache'], tab: 'overview' },
  { label: 'Connections', ids: ['ov-connections'], tab: 'overview' },
  { label: 'Long sessions', ids: ['ov-sessions'], tab: 'overview' },
  { label: 'Replication', ids: ['ov-slots', 'ov-replication'], tab: 'overview' },
  {
    label: 'Unused / duplicate indexes',
    ids: ['idx-unused', 'idx-duplicate', 'idx-invalid'],
    tab: 'indexes',
  },
  { label: 'Missing indexes', ids: ['idx-seqscan', 'idx-fk'], tab: 'indexes' },
  { label: 'Dead tuples and vacuum', ids: ['maint-vacuum'], tab: 'maintenance' },
  { label: 'Wraparound', ids: ['maint-wraparound'], tab: 'maintenance' },
  { label: 'Autovacuum', ids: ['maint-autovacuum'], tab: 'maintenance' },
  {
    label: 'Bloat (estimate)',
    ids: ['maint-table-bloat', 'maint-index-bloat'],
    tab: 'maintenance',
  },
];

function usePgChecks() {
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  const [statements, setStatements] = useState<StatementsOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const runId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++runId.current;
    setLoading(true);
    // The aux connection serialises work, so run one at a time and let
    // each tile fill in as soon as its check returns.
    for (const check of PG_CHECKS) {
      if (runId.current !== id) return;
      const r = await runPgCheck(check, pgQuery);
      if (runId.current !== id) return;
      setResults((prev) => ({ ...prev, [check.id]: r }));
    }
    const s = await runStatementsCheck(pgQuery);
    if (runId.current !== id) return;
    setStatements(s);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      runId.current++;
    };
  }, [refresh]);

  return { results, statements, loading, refresh };
}

function tileOf(def: TileDef, results: Record<string, CheckResult>) {
  const got = def.ids.map((id) => results[id]).filter((r): r is CheckResult => Boolean(r));
  if (got.length < def.ids.length) return null;
  const status = worstStatus(got.map((r) => r.status));
  const lead =
    got.find((r) => STATUS_ORDER[r.status] === STATUS_ORDER[status] && r.status !== 'ok') ?? got[0];
  const issues = got.reduce((a, r) => a + r.findings.filter((f) => f.status !== 'ok').length, 0);
  const summary =
    status === 'unknown'
      ? (lead?.summary ?? 'Unavailable')
      : got.length > 1 && issues > 0
        ? `${issues} to review`
        : (lead?.summary ?? '');
  return { status, summary };
}

export function PgHealth({ refreshKey }: { refreshKey: number }) {
  const [tab, setTab] = useState<Tab>('overview');
  const { results, statements, loading, refresh } = usePgChecks();
  const [fix, setFix] = useState<PendingFix | null>(null);
  const readOnly = useSession((s) => s.activeConfig?.readOnly === true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger
  useEffect(() => {
    if (refreshKey > 0) void refresh();
  }, [refreshKey]);

  const attention = useMemo(() => {
    const out: HealthFinding[] = [];
    for (const check of PG_CHECKS) {
      const r = results[check.id];
      if (!r || r.status === 'unknown') continue;
      out.push(...r.findings.filter((f) => f.status === 'warn' || f.status === 'crit'));
    }
    return out.sort((a, b) => STATUS_ORDER[b.status] - STATUS_ORDER[a.status]).slice(0, 8);
  }, [results]);

  const section = (id: string) => {
    const check = PG_CHECKS.find((c) => c.id === id);
    return (
      <CheckSection
        key={id}
        title={check?.title ?? id}
        result={results[id]}
        loading={loading}
        onFix={setFix}
      />
    );
  };

  const stmtsTile = statements
    ? {
        status: statements.state === 'ok' ? statements.result.status : ('unknown' as const),
        summary:
          statements.state === 'not-installed'
            ? 'Not enabled'
            : statements.state === 'unavailable'
              ? statements.result.summary
              : statements.result.summary,
      }
    : null;

  return (
    <>
      <TileStrip>
        {TILES.map((t) => {
          const r = tileOf(t, results);
          return (
            <HealthTile
              key={t.label}
              label={t.label}
              status={r?.status ?? 'unknown'}
              summary={r?.summary ?? ''}
              loading={r === null}
              onClick={() => setTab(t.tab)}
            />
          );
        })}
        <HealthTile
          label="Top queries"
          status={stmtsTile?.status ?? 'unknown'}
          summary={stmtsTile?.summary ?? ''}
          loading={stmtsTile === null}
          onClick={() => setTab('queries')}
        />
      </TileStrip>
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] px-3 py-1.5">
        <Segmented<Tab>
          ariaLabel="Health sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'activity', label: 'Activity' },
            { value: 'queries', label: 'Top queries' },
            { value: 'indexes', label: 'Indexes' },
            { value: 'maintenance', label: 'Vacuum and bloat' },
          ]}
        />
      </div>

      {/* The activity table keeps polling only while its tab is shown. */}
      <div className={tab === 'activity' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <ActivityPanel active={tab === 'activity'} />
      </div>

      {tab === 'overview' && (
        <div className="min-h-0 flex-1 overflow-auto pb-6">
          {attention.length > 0 && (
            <section aria-label="Needs attention">
              <SectionHeading>Needs attention</SectionHeading>
              <ul className="mx-4 mb-2 overflow-hidden rounded-[6px] border border-[var(--wb-separator)]">
                {attention.map((f) => (
                  <FindingRow key={f.id} finding={f} onFix={setFix} />
                ))}
              </ul>
            </section>
          )}
          {!loading && attention.length === 0 && (
            <p className="px-4 pt-4 text-[13px] text-[var(--wb-text-2)]">
              No warnings. Every check that could run came back healthy.
            </p>
          )}
          {section('ov-sessions')}
          {section('ov-cache')}
          {section('ov-connections')}
          {section('ov-slots')}
          {section('ov-replication')}
          {section('ov-dbsizes')}
          {section('ov-tables')}
        </div>
      )}

      {tab === 'queries' && <QueriesPanel outcome={statements} loading={loading} onFix={setFix} />}

      {tab === 'indexes' && (
        <div className="min-h-0 flex-1 overflow-auto pb-6">
          {section('idx-unused')}
          {section('idx-duplicate')}
          {section('idx-invalid')}
          {section('idx-seqscan')}
          {section('idx-fk')}
        </div>
      )}

      {tab === 'maintenance' && (
        <div className="min-h-0 flex-1 overflow-auto pb-6">
          {section('maint-vacuum')}
          {section('maint-wraparound')}
          {section('maint-autovacuum')}
          {section('maint-table-bloat')}
          {section('maint-index-bloat')}
        </div>
      )}

      <FixDialog
        fix={fix}
        readOnly={readOnly}
        onClose={() => setFix(null)}
        onDone={() => void refresh()}
      />
    </>
  );
}

type SortKey = 'totalMs' | 'meanMs' | 'calls';

function QueriesPanel({
  outcome,
  loading,
  onFix,
}: {
  outcome: StatementsOutcome | null;
  loading: boolean;
  onFix: (fix: PendingFix) => void;
}) {
  const openSql = useSession((s) => s.reuseHistoryQuery);
  const [sort, setSort] = useState<SortKey>('totalMs');
  const rows = useMemo(
    () => [...(outcome?.rows ?? [])].sort((a, b) => b[sort] - a[sort]),
    [outcome, sort],
  );

  if (!outcome) {
    return <EmptyState title={loading ? 'Reading pg_stat_statements…' : 'No data'} />;
  }
  if (outcome.state === 'not-installed') {
    return (
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <div className="mb-3 flex items-center gap-2">
          <Badge tone="warn">pg_stat_statements is not enabled</Badge>
        </div>
        <p className="mb-3 max-w-[640px] text-[13px] text-[var(--wb-text-2)]">
          This extension records every statement's call count, total and mean time, rows and cache
          hits. It is how Plasma finds the queries worth tuning.
        </p>
        <ol className="max-w-[640px] space-y-3">
          {STATEMENTS_ENABLE_STEPS.map((s) => (
            <li key={s.title}>
              <div className="text-[13px] font-medium text-[var(--wb-text)]">{s.title}</div>
              <div className="text-[12px] text-[var(--wb-text-2)]">{s.body}</div>
              {s.sql && (
                <Button
                  className="mt-1.5"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    onFix({
                      title: 'Enable pg_stat_statements in this database',
                      action: { label: 'Create extension', sql: s.sql as string },
                    })
                  }
                >
                  Preview SQL…
                </Button>
              )}
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (outcome.state === 'unavailable') {
    return (
      <EmptyState title={outcome.result.summary} hint={outcome.result.findings[0]?.evidence} />
    );
  }

  const columns: DataColumn<StatementRow>[] = [
    {
      key: 'query',
      label: 'Query',
      width: 420,
      sans: false,
      render: (r) => r.query.replace(/\s+/g, ' '),
      titleOf: (r) => r.query,
    },
    { key: 'calls', label: 'Calls', align: 'right', width: 90, render: (r) => fmtInt(r.calls) },
    {
      key: 'total',
      label: 'Total',
      align: 'right',
      width: 100,
      render: (r) => fmtDurationMs(r.totalMs),
    },
    {
      key: 'mean',
      label: 'Mean',
      align: 'right',
      width: 90,
      render: (r) => fmtDurationMs(r.meanMs),
    },
    { key: 'rows', label: 'Rows', align: 'right', width: 90, render: (r) => fmtInt(r.rows) },
    {
      key: 'hit',
      label: 'Hit %',
      align: 'right',
      width: 70,
      render: (r) => (r.hitPct === null ? null : fmtPct(r.hitPct, 0)),
    },
    {
      key: 'actions',
      label: '',
      sans: true,
      width: 170,
      render: (r) => (
        <span className="flex gap-1">
          <Button
            size="xs"
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation();
              openSql(explainSql(r.query));
            }}
          >
            Explain
          </Button>
          <Button
            size="xs"
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation();
              openSql(r.query);
            }}
          >
            Open in editor
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 py-2">
        <span className="text-[12px] text-[var(--wb-text-2)]">Sort by</span>
        <Segmented<SortKey>
          ariaLabel="Sort top queries"
          size="sm"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'totalMs', label: 'Total time' },
            { value: 'meanMs', label: 'Mean time' },
            { value: 'calls', label: 'Calls' },
          ]}
        />
        <span className="text-[12px] text-[var(--wb-text-3)]">
          Normalised statements show $1 placeholders; Explain uses GENERIC_PLAN (PostgreSQL 16+).
        </span>
      </div>
      {outcome.result.findings.length > 0 && (
        <ul className="mx-4 mb-2 overflow-hidden rounded-[6px] border border-[var(--wb-separator)]">
          {outcome.result.findings.slice(0, 4).map((f) => (
            <FindingRow key={f.id} finding={f} onFix={onFix} />
          ))}
        </ul>
      )}
      <div className="mx-4 mb-3 min-h-0 flex-1 overflow-hidden rounded-[6px] border border-[var(--wb-separator)]">
        <DataTable
          ariaLabel="Top queries"
          columns={columns}
          rows={rows}
          rowKey={(r, i) => `${r.queryId}:${i}`}
          rowNumbers={false}
          onActivate={(r) => openSql(r.query)}
          empty="pg_stat_statements has no entries for this database yet."
        />
      </div>
    </div>
  );
}
