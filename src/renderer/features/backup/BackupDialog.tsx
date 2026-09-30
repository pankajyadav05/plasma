import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/view-parts';
import { Segmented } from '@/components/ui/workbench';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import {
  type BackupFormat,
  type BackupRequest,
  type ToolInfo,
  checkToolVersion,
  defaultBackupName,
  parseServerMajor,
} from '@shared/pg-backup';
import { useEffect, useMemo, useState } from 'react';
import { CheckLine, FormRow, LogPane, formatBytes, useAdminJob } from './admin-parts';

type Scope = 'all' | 'schemas' | 'tables';

const FORMATS: { value: BackupFormat; label: string }[] = [
  { value: 'custom', label: 'Custom (.dump)' },
  { value: 'plain', label: 'Plain SQL' },
  { value: 'directory', label: 'Directory' },
  { value: 'tar', label: 'Tar' },
];

/** Tool detection + the version warning shared by backup and restore. */
export function useTool(tool: ToolInfo['tool'], open: boolean) {
  const serverVersion = useSession((s) => s.serverVersion);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setTools(null);
    ipc.admin
      .tools()
      .then((t) => alive && setTools(t))
      .catch(() => alive && setTools([]));
    return () => {
      alive = false;
    };
  }, [open]);
  const info = tools?.find((t) => t.tool === tool) ?? null;
  const check = checkToolVersion(tool, info?.major ?? null, parseServerMajor(serverVersion ?? ''));
  return { loading: tools === null, info, check };
}

export function ToolStatus({ loading, info, check }: ReturnType<typeof useTool>) {
  if (loading)
    return (
      <p className="text-[12px] text-[var(--wb-text-3)]">Looking for PostgreSQL client tools…</p>
    );
  if (!info?.path) {
    return (
      <p className="text-[12px] text-destructive" role="alert">
        Not found on PATH. Install the PostgreSQL client tools, or set their folder in Settings →
        Advanced.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--wb-text-2)]">
      <span className="truncate" title={info.path}>
        {info.version ?? info.path}
      </span>
      {check.level !== 'ok' && (
        <Badge tone={check.level === 'error' ? 'danger' : 'warn'}>Version mismatch</Badge>
      )}
      {check.message && (
        <p
          className={
            check.level === 'error' ? 'w-full text-destructive' : 'w-full text-[var(--wb-text-2)]'
          }
          role="alert"
        >
          {check.message}
        </p>
      )}
    </div>
  );
}

export function BackupDialog({
  open,
  onOpenChange,
}: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const activeConfig = useSession((s) => s.activeConfig);
  const schemaInfo = useSession((s) => s.schema);
  const tool = useTool('pg_dump', open);
  const job = useAdminJob();

  const [databases, setDatabases] = useState<string[]>([]);
  const [database, setDatabase] = useState('');
  const [format, setFormat] = useState<BackupFormat>('custom');
  const [dataScope, setDataScope] = useState<'all' | 'dataOnly' | 'schemaOnly'>('all');
  const [noOwner, setNoOwner] = useState(false);
  const [noPrivileges, setNoPrivileges] = useState(false);
  const [gzip, setGzip] = useState(false);
  const [jobs, setJobs] = useState('1');
  const [scope, setScope] = useState<Scope>('all');
  const [pickedSchemas, setPickedSchemas] = useState<Set<string>>(new Set());
  const [pickedTables, setPickedTables] = useState<Set<string>>(new Set());
  const [tableFilter, setTableFilter] = useState('');
  const [outputPath, setOutputPath] = useState('');

  const currentDb = activeConfig?.database ?? '';
  const isCurrent = database === currentDb;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset once per open
  useEffect(() => {
    if (!open) return;
    job.reset();
    setDatabase(currentDb);
    setOutputPath('');
    setScope('all');
    setPickedSchemas(new Set());
    setPickedTables(new Set());
    ipc.query
      .sideband(
        'SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY 1',
        undefined,
        {
          timeoutMs: 5000,
        },
      )
      .then((r) => setDatabases(r.rows.map((row) => String(row[0]))))
      .catch(() => setDatabases(currentDb ? [currentDb] : []));
  }, [open, currentDb]);

  const schemas = useMemo(
    () =>
      (schemaInfo?.schemas ?? [])
        .map((s) => s.name)
        .filter((n) => !n.startsWith('pg_') && n !== 'information_schema'),
    [schemaInfo],
  );
  const tables = useMemo(
    () =>
      (schemaInfo?.tables ?? [])
        .filter((t) => (t.kind === 'table' || t.kind === 'partitioned') && !t.partitionOf)
        .map((t) => ({ schema: t.schema, table: t.name })),
    [schemaInfo],
  );
  const shownTables = tables.filter((t) =>
    `${t.schema}.${t.table}`.toLowerCase().includes(tableFilter.toLowerCase()),
  );

  const extension =
    format === 'custom'
      ? 'dump'
      : format === 'tar'
        ? 'tar'
        : format === 'plain'
          ? gzip
            ? 'sql.gz'
            : 'sql'
          : '';
  const suggested = defaultBackupName(database || 'database', format, gzip);

  const browse = async () => {
    const picked =
      format === 'directory'
        ? await ipc.admin.pickPath({
            mode: 'save',
            title: 'Backup folder (created by pg_dump)',
            defaultPath: outputPath || suggested,
          })
        : await ipc.admin.pickPath({
            mode: 'save',
            title: 'Save backup as',
            defaultPath: outputPath || suggested,
            filters: extension
              ? [{ name: extension, extensions: [extension.split('.').pop() as string] }]
              : undefined,
          });
    if (picked) setOutputPath(picked);
  };

  const canRun =
    !job.state.running &&
    Boolean(tool.info?.path) &&
    tool.check.level !== 'error' &&
    database !== '' &&
    outputPath.trim() !== '' &&
    (scope === 'all' ||
      !isCurrent ||
      (scope === 'schemas' ? pickedSchemas.size > 0 : pickedTables.size > 0));

  const run = () => {
    const useSel = isCurrent && scope !== 'all';
    const req: BackupRequest = {
      database,
      format,
      scope: dataScope,
      noOwner,
      noPrivileges,
      gzip: format === 'plain' && gzip,
      schemas: useSel && scope === 'schemas' ? [...pickedSchemas] : [],
      tables:
        useSel && scope === 'tables'
          ? tables.filter((t) => pickedTables.has(`${t.schema}.${t.table}`))
          : [],
      jobs: format === 'directory' ? Math.max(1, Number.parseInt(jobs, 10) || 1) : undefined,
      outputPath: outputPath.trim(),
    };
    void job.start(() => ipc.admin.backup(req));
  };

  const result = job.state.result;

  return (
    <Dialog open={open} onOpenChange={(v) => (job.state.running ? undefined : onOpenChange(v))}>
      <DialogContent className="max-w-[640px]" data-testid="backup-dialog">
        <DialogHeader>
          <DialogTitle>Back up database</DialogTitle>
          <DialogDescription>Runs pg_dump against the connected server.</DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto pr-1">
          <FormRow label="Tool">
            <ToolStatus {...tool} />
          </FormRow>
          <FormRow label="Database">
            <Select value={database} onValueChange={setDatabase} disabled={job.state.running}>
              <SelectTrigger aria-label="Database">
                <SelectValue placeholder="Database" />
              </SelectTrigger>
              <SelectContent>
                {(databases.length ? databases : [database]).filter(Boolean).map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>
          <FormRow
            label="Objects"
            hint={
              isCurrent
                ? undefined
                : 'Choose the connected database to pick individual schemas or tables.'
            }
          >
            <Segmented<Scope>
              variant="track"
              value={scope}
              onChange={(v) => setScope(v)}
              options={[
                { value: 'all', label: 'Everything' },
                { value: 'schemas', label: 'Schemas' },
                { value: 'tables', label: 'Tables' },
              ]}
              ariaLabel="Objects to back up"
            />
            {isCurrent && scope === 'schemas' && (
              <div className="mt-2 max-h-32 overflow-y-auto rounded-[7px] bg-[var(--wb-field)] p-2">
                {schemas.map((s) => (
                  <CheckLine
                    key={s}
                    id={`bk-schema-${s}`}
                    label={s}
                    checked={pickedSchemas.has(s)}
                    onChange={(v) => setPickedSchemas((p) => toggled(p, s, v))}
                  />
                ))}
              </div>
            )}
            {isCurrent && scope === 'tables' && (
              <div className="mt-2 flex flex-col gap-1.5">
                <Input
                  placeholder="Filter tables"
                  value={tableFilter}
                  onChange={(e) => setTableFilter(e.target.value)}
                  aria-label="Filter tables"
                />
                <div className="max-h-36 overflow-y-auto rounded-[7px] bg-[var(--wb-field)] p-2">
                  {shownTables.slice(0, 500).map((t) => {
                    const id = `${t.schema}.${t.table}`;
                    return (
                      <CheckLine
                        key={id}
                        id={`bk-table-${id}`}
                        label={id}
                        checked={pickedTables.has(id)}
                        onChange={(v) => setPickedTables((p) => toggled(p, id, v))}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </FormRow>
          <FormRow label="Format">
            <Select
              value={format}
              onValueChange={(v) => setFormat(v as BackupFormat)}
              disabled={job.state.running}
            >
              <SelectTrigger aria-label="Format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORMATS.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>
          <FormRow label="Contents">
            <Segmented<'all' | 'dataOnly' | 'schemaOnly'>
              variant="track"
              value={dataScope}
              onChange={setDataScope}
              options={[
                { value: 'all', label: 'Schema and data' },
                { value: 'schemaOnly', label: 'Schema only' },
                { value: 'dataOnly', label: 'Data only' },
              ]}
              ariaLabel="Contents"
            />
          </FormRow>
          <FormRow label="Options">
            <div className="flex flex-col gap-1.5">
              <CheckLine
                id="bk-no-owner"
                label="No owner (skip ownership commands)"
                checked={noOwner}
                onChange={setNoOwner}
              />
              <CheckLine
                id="bk-no-priv"
                label="No privileges (skip GRANT / REVOKE)"
                checked={noPrivileges}
                onChange={setNoPrivileges}
              />
              <CheckLine
                id="bk-gzip"
                label="Compress with gzip"
                checked={gzip}
                onChange={setGzip}
                disabled={format !== 'plain'}
              />
              {format === 'directory' && (
                <div className="flex items-center gap-2 text-[13px] text-[var(--wb-text-2)]">
                  Parallel jobs
                  <Input
                    className="w-16"
                    inputMode="numeric"
                    value={jobs}
                    onChange={(e) => setJobs(e.target.value)}
                    aria-label="Parallel jobs"
                  />
                </div>
              )}
            </div>
          </FormRow>
          <FormRow label="Save to">
            <div className="flex gap-2">
              <Input
                value={outputPath}
                readOnly
                placeholder="Choose where to save…"
                aria-label="Output path"
              />
              <Button
                variant="secondary"
                onClick={() => void browse()}
                disabled={job.state.running}
              >
                Browse…
              </Button>
            </div>
          </FormRow>

          {(job.state.running ||
            job.state.log.length > 0 ||
            job.state.result ||
            job.state.error) && (
            <FormRow label="Log">
              <div className="flex flex-col gap-1.5">
                {job.state.command && (
                  <code
                    className="truncate text-[11.5px] text-[var(--wb-text-3)]"
                    title={job.state.command}
                  >
                    {job.state.command}
                  </code>
                )}
                <LogPane lines={job.state.log} />
                {job.state.error && (
                  <p className="text-[12px] text-destructive" role="alert">
                    {job.state.error}
                  </p>
                )}
                {result && (
                  <output
                    className={
                      result.ok
                        ? 'text-[12px] text-[var(--wb-text-2)]'
                        : 'text-[12px] text-destructive'
                    }
                  >
                    {result.ok
                      ? `Backup finished${result.bytes !== undefined ? ` (${formatBytes(result.bytes)})` : ''}.`
                      : (result.message ?? 'Backup failed.')}
                  </output>
                )}
              </div>
            </FormRow>
          )}
        </div>

        <DialogFooter>
          {job.state.running ? (
            <Button variant="secondary" onClick={job.cancel}>
              Cancel backup
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button variant="primary" onClick={run} disabled={!canRun}>
                Back up
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toggled(set: ReadonlySet<string>, key: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}
