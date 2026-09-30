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
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import {
  type RestoreRequest,
  detectRestoreKind,
  isSafeRestoreDatabaseName,
} from '@shared/pg-backup';
import { useEffect, useState } from 'react';
import { ToolStatus, useTool } from './BackupDialog';
import { CheckLine, FormRow, LogPane, useAdminJob } from './admin-parts';

type Kind = 'archive' | 'plain';

export function RestoreDialog({
  open,
  onOpenChange,
}: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const activeConfig = useSession((s) => s.activeConfig);
  const confirmUserSql = useSession((s) => s.confirmUserSql);
  const readOnly = activeConfig?.readOnly === true;
  const currentDb = activeConfig?.database ?? '';
  const [kind, setKind] = useState<Kind>('archive');
  const tool = useTool(kind === 'archive' ? 'pg_restore' : 'psql', open);
  const job = useAdminJob();

  const [databases, setDatabases] = useState<string[]>([]);
  const [database, setDatabase] = useState('');
  const [filePath, setFilePath] = useState('');
  const [isDir, setIsDir] = useState(false);
  const [clean, setClean] = useState(false);
  const [ifExists, setIfExists] = useState(false);
  const [noOwner, setNoOwner] = useState(false);
  const [singleTx, setSingleTx] = useState(false);
  const [jobs, setJobs] = useState('1');
  const [armed, setArmed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset once per open
  useEffect(() => {
    if (!open) return;
    job.reset();
    setDatabase(currentDb);
    setFilePath('');
    setIsDir(false);
    setArmed(false);
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

  const choose = (path: string | null, dir: boolean) => {
    if (!path) return;
    setFilePath(path);
    setIsDir(dir);
    setKind(detectRestoreKind(path, null, dir));
    setArmed(false);
  };
  const pickFile = async () =>
    choose(await ipc.admin.pickPath({ mode: 'open', title: 'Choose a backup file' }), false);
  const pickDir = async () =>
    choose(await ipc.admin.pickPath({ mode: 'directory', title: 'Choose a backup folder' }), true);

  const dbOk = kind === 'plain' || isSafeRestoreDatabaseName(database);
  const canRun =
    !readOnly &&
    !job.state.running &&
    Boolean(tool.info?.path) &&
    filePath !== '' &&
    database !== '' &&
    dbOk;

  const run = async () => {
    const req: RestoreRequest = {
      filePath,
      database,
      kind,
      clean: kind === 'archive' && clean,
      ifExists: kind === 'archive' && clean && ifExists,
      noOwner: kind === 'archive' && noOwner,
      noPrivileges: false,
      singleTransaction: singleTx,
      jobs:
        kind === 'archive' && !singleTx ? Math.max(1, Number.parseInt(jobs, 10) || 1) : undefined,
    };
    // Restore is a write: safe-mode / prod-tag confirmation first.
    const ok = await confirmUserSql(
      `pg_restore ${req.clean ? '--clean ' : ''}--dbname=${JSON.stringify(database)} ${JSON.stringify(filePath)}`,
      { force: true, summary: `Restore "${filePath}" into database "${database}"` },
    );
    if (!ok) return;
    setArmed(false);
    void job.start(() => ipc.admin.restore(req));
  };

  const result = job.state.result;

  return (
    <Dialog open={open} onOpenChange={(v) => (job.state.running ? undefined : onOpenChange(v))}>
      <DialogContent className="max-w-[640px]" data-testid="restore-dialog">
        <DialogHeader>
          <DialogTitle>Restore database</DialogTitle>
          <DialogDescription>
            Restores a backup with pg_restore (archives) or psql (SQL scripts).
          </DialogDescription>
        </DialogHeader>

        {readOnly && (
          <p
            className="rounded-[7px] bg-[var(--wb-field)] p-2 text-[12px] text-[var(--wb-text-2)]"
            role="alert"
          >
            This connection is read-only, so restoring is not available. Edit the connection to turn
            off read-only.
          </p>
        )}

        <div className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto pr-1">
          <FormRow label="Tool">
            <ToolStatus {...tool} />
          </FormRow>
          <FormRow label="Backup">
            <div className="flex gap-2">
              <Input
                value={filePath}
                readOnly
                placeholder="No file chosen"
                aria-label="Backup path"
              />
              <Button
                variant="secondary"
                onClick={() => void pickFile()}
                disabled={job.state.running}
              >
                File…
              </Button>
              <Button
                variant="secondary"
                onClick={() => void pickDir()}
                disabled={job.state.running}
              >
                Folder…
              </Button>
            </div>
          </FormRow>
          <FormRow label="Type">
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as Kind)}
              disabled={isDir || job.state.running}
            >
              <SelectTrigger aria-label="Backup type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="archive">
                  Archive: custom, tar, directory (pg_restore)
                </SelectItem>
                <SelectItem value="plain">SQL script, optionally .gz (psql)</SelectItem>
              </SelectContent>
            </Select>
          </FormRow>
          <FormRow label="Into database" hint="The database must already exist.">
            <Select value={database} onValueChange={setDatabase} disabled={job.state.running}>
              <SelectTrigger aria-label="Target database">
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
            {!dbOk && (
              <p className="mt-1 text-[12px] text-destructive">
                This database name cannot be passed to pg_restore safely.
              </p>
            )}
          </FormRow>
          <FormRow label="Options">
            <div className="flex flex-col gap-1.5">
              <CheckLine
                id="rs-clean"
                label="Clean: drop objects before recreating them"
                checked={clean}
                onChange={setClean}
                disabled={kind !== 'archive'}
              />
              <CheckLine
                id="rs-ifexists"
                label="Use IF EXISTS when dropping"
                checked={ifExists}
                onChange={setIfExists}
                disabled={kind !== 'archive' || !clean}
              />
              <CheckLine
                id="rs-owner"
                label="No owner (skip ownership commands)"
                checked={noOwner}
                onChange={setNoOwner}
                disabled={kind !== 'archive'}
              />
              <CheckLine
                id="rs-tx"
                label="Single transaction (all or nothing)"
                checked={singleTx}
                onChange={setSingleTx}
              />
              <div className="flex items-center gap-2 text-[13px] text-[var(--wb-text-2)]">
                Parallel jobs
                <Input
                  className="w-16"
                  inputMode="numeric"
                  value={jobs}
                  disabled={kind !== 'archive' || singleTx}
                  onChange={(e) => setJobs(e.target.value)}
                  aria-label="Parallel jobs"
                />
              </div>
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
                    {result.ok ? 'Restore finished.' : (result.message ?? 'Restore failed.')}
                  </output>
                )}
              </div>
            </FormRow>
          )}
        </div>

        <DialogFooter>
          {job.state.running ? (
            <Button variant="secondary" onClick={job.cancel}>
              Cancel restore
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {armed ? (
                <Button variant="destructive" onClick={() => void run()} disabled={!canRun}>
                  Restore into "{database}"
                </Button>
              ) : (
                <Button variant="primary" onClick={() => setArmed(true)} disabled={!canRun}>
                  Restore…
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
