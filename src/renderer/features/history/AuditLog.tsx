import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge, EmptyState, ViewFooter } from '@/components/ui/view-parts';
import { Pill } from '@/components/ui/workbench';
import { cleanIpcError } from '@/lib/errors';
import { formatDuration } from '@/lib/format';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { AuditEntry, AuditVerifyResult } from '@shared/audit';
import { Download, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type AuditFilterDraft, EMPTY_AUDIT_FILTER, auditFilterOf } from './audit-filter';

const SOURCE_LABEL: Record<AuditEntry['source'], string> = {
  editor: 'Editor',
  'grid-commit': 'Grid commit',
  'safe-run': 'Safe Run',
  structure: 'Structure',
  import: 'Import',
  ai: 'AI suggestion',
  notify: 'NOTIFY',
};

const PAGE = 500;

/**
 * Local audit log (History → Audit): every statement run on Prod-tagged
 * connections (or all of them, per Settings), newest first, with filters,
 * CSV / JSON export and a hash-chain integrity check.
 */
export function AuditLog() {
  const savedConnections = useSession((s) => s.savedConnections);
  const [draft, setDraft] = useState<AuditFilterDraft>(EMPTY_AUDIT_FILTER);
  const [text, setText] = useState('');
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<AuditVerifyResult | 'running' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Debounce the free-text search into the filter.
  useEffect(() => {
    const t = window.setTimeout(() => setDraft((d) => (d.text === text ? d : { ...d, text })), 200);
    return () => window.clearTimeout(t);
  }, [text]);

  const filter = useMemo(() => auditFilterOf(draft), [draft]);

  const load = useCallback(async () => {
    try {
      setRows(await ipc.audit.list({ ...filter, limit: PAGE }));
      setError(null);
    } catch (err) {
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const connName = useMemo(() => {
    const map = new Map(savedConnections.map((c) => [c.id, c.name]));
    return (e: AuditEntry) => map.get(e.connectionId ?? '') ?? e.connectionName;
  }, [savedConnections]);

  const runVerify = async () => {
    setVerify('running');
    try {
      setVerify(await ipc.audit.verify());
    } catch (err) {
      setVerify(null);
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    }
  };

  const exportAs = async (format: 'csv' | 'json') => {
    setNote(null);
    try {
      const res = await ipc.audit.export({ format, filter });
      if (res.ok) setNote(`Exported ${res.rows.toLocaleString()} rows to ${res.path}`);
    } catch (err) {
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    }
  };

  const columns = useMemo<DataColumn<AuditEntry>[]>(
    () => [
      {
        key: 'time',
        label: 'time',
        width: 150,
        render: (e) => new Date(e.ts).toLocaleString(),
      },
      { key: 'conn', label: 'connection', width: 140, render: connName, titleOf: connName },
      { key: 'user', label: 'user', width: 100, render: (e) => e.dbUser || '–' },
      {
        key: 'source',
        label: 'source',
        width: 110,
        sans: true,
        render: (e) => SOURCE_LABEL[e.source] ?? e.source,
      },
      {
        key: 'outcome',
        label: 'outcome',
        width: 80,
        sans: true,
        render: (e) => <Badge tone={e.outcome === 'ok' ? 'neutral' : 'danger'}>{e.outcome}</Badge>,
      },
      {
        key: 'rows',
        label: 'rows',
        width: 70,
        align: 'right',
        render: (e) => (e.affectedRows === null ? '–' : e.affectedRows.toLocaleString()),
      },
      {
        key: 'ms',
        label: 'duration',
        width: 90,
        align: 'right',
        render: (e) => (e.durationMs === null ? '–' : formatDuration(e.durationMs)),
      },
      {
        key: 'statement',
        label: 'statement',
        render: (e) => e.statement.replace(/\s+/g, ' ').slice(0, 400),
        titleOf: (e) => e.statement.slice(0, 2000),
      },
    ],
    [connName],
  );

  const current = rows.find((r) => r.id === selected) ?? null;
  const selectedIndex = current ? rows.indexOf(current) : null;
  const select = (key: keyof AuditFilterDraft, v: string) => setDraft((d) => ({ ...d, [key]: v }));

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="audit-log">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--wb-separator)] px-2.5 py-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--wb-text-2)]" />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search statements, users, errors…"
            className="pl-7"
            aria-label="Search the audit log"
          />
        </div>
        <Select
          value={draft.connectionId || 'all'}
          onValueChange={(v) => select('connectionId', v === 'all' ? '' : v)}
        >
          <SelectTrigger className="w-[160px]" aria-label="Connection filter">
            <SelectValue placeholder="Connection" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All connections</SelectItem>
            {savedConnections.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={draft.outcome} onValueChange={(v) => select('outcome', v)}>
          <SelectTrigger className="w-[120px]" aria-label="Outcome filter">
            <SelectValue placeholder="Outcome" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any outcome</SelectItem>
            <SelectItem value="ok">Succeeded</SelectItem>
            <SelectItem value="error">Errors</SelectItem>
          </SelectContent>
        </Select>
        <label
          htmlFor="audit-from"
          className="flex items-center gap-1 text-[12px] text-[var(--wb-text-2)]"
        >
          From
          <Input
            type="date"
            value={draft.fromDate}
            onChange={(e) => select('fromDate', e.target.value)}
            className="w-[130px]"
            id="audit-from"
            aria-label="From date"
          />
        </label>
        <label
          htmlFor="audit-to"
          className="flex items-center gap-1 text-[12px] text-[var(--wb-text-2)]"
        >
          To
          <Input
            type="date"
            value={draft.toDate}
            onChange={(e) => select('toDate', e.target.value)}
            className="w-[130px]"
            id="audit-to"
            aria-label="To date"
          />
        </label>
        <Pill onClick={() => void load()} title="Reload">
          <RefreshCw />
        </Pill>
      </div>

      {error && (
        <div
          role="alert"
          className="shrink-0 border-b border-[var(--wb-separator)] px-3 py-1.5 text-[13px] text-destructive"
        >
          {error}
        </div>
      )}
      {verify && verify !== 'running' && (
        <output
          data-testid="audit-verify-result"
          className={
            verify.ok
              ? 'block shrink-0 border-b border-[var(--wb-separator)] px-3 py-1.5 text-[13px] text-[var(--wb-text)]'
              : 'block shrink-0 border-b border-[var(--wb-separator)] px-3 py-1.5 text-[13px] text-destructive'
          }
        >
          {verify.ok
            ? `Log intact: ${verify.checked.toLocaleString()} rows verified, every hash matches its row and its predecessor.`
            : `Log integrity check failed. ${verify.reason ?? ''}`}
        </output>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No audited statements"
          hint="Statements run on connections tagged Prod are recorded here. Turn on “Audit every connection” in Settings to record the rest."
        />
      ) : (
        <DataTable
          ariaLabel="Audit log"
          columns={columns}
          rows={rows}
          rowKey={(e) => String(e.id)}
          selectedIndex={selectedIndex}
          onSelect={(e) => setSelected(e.id)}
          rowNumbers={false}
        />
      )}

      {current && (
        <div className="max-h-[32%] shrink-0 overflow-auto border-t border-[var(--wb-separator)] bg-[var(--wb-sidebar)] px-3 py-2 text-[12px]">
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-[var(--wb-text)]">
            {current.statement}
          </pre>
          {current.error && <div className="mt-1 text-destructive">{current.error}</div>}
          <div className="mt-1 font-mono text-[11px] text-[var(--wb-text-3)]">
            #{current.id} · hash {current.hash.slice(0, 16)}… · prev {current.prevHash.slice(0, 16)}
            …
          </div>
        </div>
      )}

      <ViewFooter>
        <span className="tabular-nums">
          {rows.length.toLocaleString()} {rows.length === 1 ? 'entry' : 'entries'}
          {rows.length === PAGE ? ` (newest ${PAGE})` : ''}
        </span>
        {note && (
          <span className="min-w-0 truncate text-[12px] text-[var(--wb-text-2)]">· {note}</span>
        )}
        <div className="flex-1" />
        <Pill onClick={() => void runVerify()} disabled={verify === 'running'}>
          <ShieldCheck />
          {verify === 'running' ? 'Verifying…' : 'Verify log integrity'}
        </Pill>
        <Pill onClick={() => void exportAs('csv')} disabled={rows.length === 0}>
          <Download />
          CSV
        </Pill>
        <Pill onClick={() => void exportAs('json')} disabled={rows.length === 0}>
          <Download />
          JSON
        </Pill>
      </ViewFooter>
    </div>
  );
}
