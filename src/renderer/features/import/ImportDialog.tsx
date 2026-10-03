import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Segmented } from '@/components/ui/workbench';
import { useStructureDialogs } from '@/features/structure/structure-dialogs-store';
import {
  CellInput,
  CheckRow,
  FieldLabel,
  PgTypeDatalist,
  SqlPreview,
  TypeInput,
} from '@/features/structure/structure-parts';
import { type TableColumn, fetchTableColumns } from '@/features/structure/table-columns';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { evaluateGate } from '@/stores/session-prod-gate';
import type {
  ImportCsvOptions,
  ImportFormat,
  ImportPickedFile,
  ImportPreview,
  ImportProgress,
  ImportResult,
} from '@shared/protocol';
import { FileUp, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type NewTableColumn,
  autoMap,
  buildImportJob,
  formatBytes,
  newTableColumns,
  tableNameFromFile,
} from './import-model';

const SKIP = '__skip__';
const DELIMITERS: Array<{ value: string; label: string }> = [
  { value: ',', label: 'Comma ( , )' },
  { value: ';', label: 'Semicolon ( ; )' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe ( | )' },
];
const QUOTES: Array<{ value: string; label: string }> = [
  { value: '"', label: 'Double quote ( " )' },
  { value: "'", label: "Single quote ( ' )" },
  { value: 'none', label: 'None' },
];

/** Import a CSV/TSV/JSON/NDJSON/SQL file into a table (or a new one). */
export function ImportDialog() {
  const target = useStructureDialogs((s) => s.importInto);
  const close = useStructureDialogs((s) => s.close);
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && close()}>
      {target && <ImportBody schema={target.schema} table={target.table} onClose={close} />}
    </Dialog>
  );
}

type Mode = 'existing' | 'new';

function ImportBody({
  schema,
  table: initialTable,
  onClose,
}: {
  schema: string;
  table: string | null;
  onClose: () => void;
}) {
  const info = useSession((s) => s.schema);
  const readOnly = useSession((s) => Boolean(s.activeConfig?.readOnly));
  const openTable = useSession((s) => s.openTable);

  const [file, setFile] = useState<ImportPickedFile | null>(null);
  const [format, setFormat] = useState<ImportFormat>('csv');
  const [csvOver, setCsvOver] = useState<Partial<ImportCsvOptions>>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [lintBlocked, setLintBlocked] = useState(false);
  const [mode, setMode] = useState<Mode>(initialTable ? 'existing' : 'new');
  const [tableKey, setTableKey] = useState(initialTable ? `${schema}.${initialTable}` : '');
  const [newName, setNewName] = useState('');
  const [targetCols, setTargetCols] = useState<TableColumn[]>([]);
  const [targets, setTargets] = useState<(string | null)[]>([]);
  const [newCols, setNewCols] = useState<NewTableColumn[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobId = useRef('');

  const tables = useMemo(
    () => (info?.tables ?? []).filter((t) => t.kind === 'table' || t.kind === 'partitioned'),
    [info],
  );
  const selected = tables.find((t) => `${t.schema}.${t.name}` === tableKey);

  const choose = async () => {
    setError(null);
    const picked = await ipc.dataImport.pickFile();
    if (!picked) return;
    setFile(picked);
    setCsvOver({});
    setResult(null);
    setPreview(null);
    if (picked.format) setFormat(picked.format);
    setNewName(tableNameFromFile(picked.name));
  };

  // (Re)build the preview whenever the file, format or CSV options change.
  const csvKey = JSON.stringify(csvOver);
  // biome-ignore lint/correctness/useExhaustiveDependencies: csvKey stands for csvOver
  useEffect(() => {
    if (!file) return;
    let live = true;
    setPreviewError(null);
    ipc.dataImport
      .preview({
        path: file.path,
        format,
        csv: format === 'csv' || format === 'tsv' ? csvOver : undefined,
      })
      .then((p) => live && setPreview(p))
      .catch((err) => {
        if (live) {
          setPreview(null);
          setPreviewError(cleanIpcError(err instanceof Error ? err.message : String(err)));
        }
      });
    return () => {
      live = false;
    };
  }, [file, format, csvKey]);

  // Target table columns for "existing table".
  useEffect(() => {
    if (mode !== 'existing' || !selected) {
      setTargetCols([]);
      return;
    }
    let live = true;
    fetchTableColumns(selected.schema, selected.name)
      .then((c) => live && setTargetCols(c))
      .catch(() => live && setTargetCols([]));
    return () => {
      live = false;
    };
  }, [mode, selected]);

  // Suggest a mapping whenever the source or target columns change.
  useEffect(() => {
    if (!preview || preview.format === 'sql') {
      setTargets([]);
      return;
    }
    if (mode === 'new') {
      const cols = newTableColumns(preview);
      setNewCols(cols);
      setTargets(cols.map((c) => c.name));
    } else {
      const writable = targetCols.filter((c) => !c.generated).map((c) => c.name);
      setTargets(
        autoMap(preview.columns, writable, preview.format === 'csv' || preview.format === 'tsv'),
      );
    }
  }, [preview, mode, targetCols]);

  // Progress events from the worker.
  useEffect(
    () =>
      window.plasmaEvents.on('plasma:import:progress', (...args: unknown[]) => {
        const p = args[0] as ImportProgress;
        if (p.jobId === jobId.current) setProgress(p);
      }),
    [],
  );

  const isSql = preview?.format === 'sql';
  const effectiveTable = mode === 'existing' ? selected?.name : newName.trim();

  const built = useMemo(() => {
    if (!preview || !file) return { problem: null as string | null, value: null };
    if (mode === 'existing' && !selected && !isSql) return { problem: null, value: null };
    if (mode === 'new' && !newName.trim() && !isSql) return { problem: null, value: null };
    try {
      const names = newCols.map((c, i) => (targets[i] == null ? null : c.name));
      const value = buildImportJob({
        jobId: 'preview',
        connectionGen: 0,
        filePath: file.path,
        schema: mode === 'existing' && selected ? selected.schema : schema,
        table: effectiveTable ?? '',
        preview,
        targets: mode === 'new' ? names : targets,
        create: mode === 'new' && !isSql ? newCols : undefined,
      });
      return { problem: null, value };
    } catch (err) {
      return { problem: err instanceof Error ? err.message : String(err), value: null };
    }
  }, [preview, file, mode, selected, schema, newName, newCols, targets, isSql, effectiveTable]);

  const run = async () => {
    if (!built.value || !file || !preview) return;
    const s = useSession.getState();
    const jid = crypto.randomUUID();
    const rebuilt = buildImportJob({
      jobId: jid,
      connectionGen: s.connectionGen,
      filePath: file.path,
      schema: mode === 'existing' && selected ? selected.schema : schema,
      table: effectiveTable ?? '',
      preview,
      targets:
        mode === 'new' ? newCols.map((c, i) => (targets[i] == null ? null : c.name)) : targets,
      create: mode === 'new' && !isSql ? newCols : undefined,
    });
    const decision = evaluateGate(useSession.getState, rebuilt.gateSql, true);
    if (decision.kind === 'refuse') {
      setError(decision.message);
      return;
    }
    if (!(await s.confirmUserSql(rebuilt.gateSql, { force: true, summary: `import ${file.name}` })))
      return;
    jobId.current = jid;
    setRunning(true);
    setProgress(null);
    setResult(null);
    setError(null);
    try {
      const res = await ipc.dataImport.run(rebuilt.job);
      setResult(res);
      if (res.ok) {
        await useSession.getState().refreshSchema();
      }
    } catch (err) {
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    } finally {
      setRunning(false);
    }
  };

  const setCsv = (patch: Partial<ImportCsvOptions>) => setCsvOver((o) => ({ ...o, ...patch }));
  const pct =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesRead / progress.totalBytes) * 100))
      : 0;
  const canImport =
    !readOnly && !running && built.value !== null && !built.problem && !result?.ok && !lintBlocked;

  return (
    <DialogContent className="max-w-[860px]" data-testid="import-dialog">
      <PgTypeDatalist />
      <DialogHeader>
        <DialogTitle>
          Import{initialTable ? ` into ${schema}.${initialTable}` : ' data'}
        </DialogTitle>
        <DialogDescription>
          CSV, TSV, JSON (array of objects), NDJSON or a .sql script. Runs in one transaction; any
          error rolls everything back.
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void choose()}
          disabled={running}
          data-testid="import-choose"
        >
          <FileUp />
          {file ? 'Choose another file…' : 'Choose file…'}
        </Button>
        {file && (
          <span className="min-w-0 truncate text-[13px]" title={file.path}>
            {file.name} <span className="text-[var(--wb-text-2)]">· {formatBytes(file.size)}</span>
          </span>
        )}
        <div className="flex-1" />
        {file && (
          <div className="w-[130px]">
            <Select
              value={format}
              onValueChange={(v) => setFormat(v as ImportFormat)}
              disabled={running}
            >
              <SelectTrigger aria-label="File format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="csv">CSV</SelectItem>
                <SelectItem value="tsv">TSV</SelectItem>
                <SelectItem value="json">JSON</SelectItem>
                <SelectItem value="ndjson">NDJSON</SelectItem>
                <SelectItem value="sql">SQL script</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {previewError && (
        <p className="whitespace-pre-wrap text-[12px] text-destructive">{previewError}</p>
      )}

      {preview && (preview.format === 'csv' || preview.format === 'tsv') && preview.csv && (
        <div
          className="grid grid-cols-[1fr_1fr_auto_1fr] items-end gap-3"
          data-testid="import-csv-options"
        >
          <div>
            <FieldLabel>Delimiter</FieldLabel>
            <Select
              value={preview.csv.delimiter}
              onValueChange={(v) => setCsv({ delimiter: v })}
              disabled={running}
            >
              <SelectTrigger aria-label="Delimiter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DELIMITERS.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <FieldLabel>Quote</FieldLabel>
            <Select
              value={preview.csv.quote === '' ? 'none' : preview.csv.quote}
              onValueChange={(v) => setCsv({ quote: v === 'none' ? '' : v })}
              disabled={running}
            >
              <SelectTrigger aria-label="Quote character">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUOTES.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <CheckRow
            className="pb-1 text-[13px]"
            checked={preview.csv.header}
            onChange={(v) => setCsv({ header: v })}
            disabled={running}
          >
            First row is a header
          </CheckRow>
          <div>
            <FieldLabel htmlFor="imp-null">NULL string</FieldLabel>
            <Input
              id="imp-null"
              value={preview.csv.nullString ?? ''}
              placeholder="empty = empty cells"
              onChange={(e) => setCsv({ nullString: e.target.value })}
              disabled={running}
              spellCheck={false}
            />
          </div>
        </div>
      )}

      {preview && !isSql && (
        <>
          <div className="flex items-center gap-3">
            <Segmented
              ariaLabel="Import target"
              value={mode}
              onChange={(m) => setMode(m as Mode)}
              options={[
                { value: 'existing', label: 'Existing table' },
                { value: 'new', label: 'New table' },
              ]}
            />
            {mode === 'existing' ? (
              <div className="w-[320px]">
                <Select value={tableKey} onValueChange={setTableKey} disabled={running}>
                  <SelectTrigger aria-label="Target table">
                    <SelectValue placeholder="Choose a table" />
                  </SelectTrigger>
                  <SelectContent>
                    {tables.map((t) => (
                      <SelectItem key={`${t.schema}.${t.name}`} value={`${t.schema}.${t.name}`}>
                        {t.schema}.{t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-[var(--wb-text-2)]">{schema}.</span>
                <Input
                  aria-label="New table name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-[220px]"
                  spellCheck={false}
                  disabled={running}
                />
              </div>
            )}
          </div>

          <div
            className="max-h-[250px] overflow-auto rounded-[6px] shadow-[inset_0_0_0_1px_var(--wb-separator)]"
            data-testid="import-mapping"
          >
            <table className="w-full border-collapse text-[12px]">
              <thead className="sticky top-0 bg-[var(--wb-content)]">
                <tr className="text-left text-[var(--wb-text-2)]">
                  <th className="px-2 py-1 font-medium">File column</th>
                  <th className="px-2 py-1 font-medium">Sample</th>
                  <th className="px-2 py-1 font-medium">
                    {mode === 'new' ? 'New column' : 'Table column'}
                  </th>
                  {mode === 'new' && <th className="px-2 py-1 font-medium">Type</th>}
                </tr>
              </thead>
              <tbody>
                {preview.columns.map((label, i) => (
                  <tr
                    key={`${label}-${
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns can repeat labels
                      i
                    }`}
                  >
                    <td className="px-2 py-0.5 font-mono">{label}</td>
                    <td className="max-w-[240px] truncate px-2 py-0.5 font-mono text-[var(--wb-text-2)]">
                      {preview.rows
                        .slice(0, 2)
                        .map((r) => (r[i] === null ? 'NULL' : r[i]))
                        .join(' · ')}
                    </td>
                    <td className="px-1 py-0.5">
                      {mode === 'existing' ? (
                        <Select
                          value={targets[i] ?? SKIP}
                          onValueChange={(v) =>
                            setTargets((t) =>
                              t.map((x, j) => (j === i ? (v === SKIP ? null : v) : x)),
                            )
                          }
                          disabled={running}
                        >
                          <SelectTrigger aria-label={`Target for ${label}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={SKIP}>— skip —</SelectItem>
                            {targetCols
                              .filter((c) => !c.generated)
                              .map((c) => (
                                <SelectItem key={c.name} value={c.name}>
                                  {c.name} <span className="text-[var(--wb-text-3)]">{c.type}</span>
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Checkbox
                            aria-label={`Import ${label}`}
                            checked={targets[i] != null}
                            onCheckedChange={(v) =>
                              setTargets((t) =>
                                t.map((x, j) =>
                                  j === i ? (v === true ? (newCols[i]?.name ?? label) : null) : x,
                                ),
                              )
                            }
                          />
                          <CellInput
                            value={newCols[i]?.name ?? ''}
                            aria-label={`Name of new column ${label}`}
                            onChange={(e) =>
                              setNewCols((c) =>
                                c.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                              )
                            }
                          />
                        </div>
                      )}
                    </td>
                    {mode === 'new' && (
                      <td className="px-1 py-0.5">
                        <TypeInput
                          value={newCols[i]?.type ?? 'text'}
                          aria-label={`Type of new column ${label}`}
                          onChange={(e) =>
                            setNewCols((c) =>
                              c.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)),
                            )
                          }
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div
            className="max-h-[150px] overflow-auto rounded-[6px] shadow-[inset_0_0_0_1px_var(--wb-separator)]"
            data-testid="import-preview-rows"
          >
            <table className="w-full border-collapse font-mono text-[12px]">
              <thead className="sticky top-0 bg-[var(--wb-content)]">
                <tr className="text-left text-[var(--wb-text-2)]">
                  {preview.columns.map((c, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: labels can repeat
                    <th key={i} className="whitespace-nowrap px-2 py-1 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 8).map((r, ri) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: preview rows are static
                  <tr key={ri}>
                    {preview.columns.map((_, ci) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: preview cells are static
                      <td key={ci} className="max-w-[200px] truncate whitespace-nowrap px-2 py-0.5">
                        {r[ci] === null ? (
                          <span className="text-[var(--grid-null)]">NULL</span>
                        ) : (
                          r[ci]
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length === 0 && (
            <p className="text-[12px] text-[var(--wb-text-2)]">
              No data rows found in the first part of the file.
            </p>
          )}
        </>
      )}

      {preview && isSql && (
        <div>
          <FieldLabel>First statements of the script</FieldLabel>
          <SqlPreview
            className="max-h-[220px]"
            sql={(preview.statements ?? []).map((s) => `${s};`).join('\n\n')}
            emptyText="No statements found."
            onLintBlockedChange={setLintBlocked}
          />
        </div>
      )}

      {built.problem && <p className="text-[12px] text-destructive">{built.problem}</p>}
      {readOnly && (
        <p className="text-[12px] text-destructive">
          This connection is read-only — data cannot be imported.
        </p>
      )}
      {error && <p className="whitespace-pre-wrap text-[12px] text-destructive">{error}</p>}

      {running && (
        <div className="flex flex-col gap-1" data-testid="import-progress">
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--wb-control)]">
            <div
              className="h-full bg-[var(--wb-text)] transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center gap-2 text-[12px] text-[var(--wb-text-2)]">
            <Loader2 className="h-3 w-3 animate-spin" />
            {progress
              ? `${progress.rowsRead.toLocaleString()} rows read · ${progress.rowsImported.toLocaleString()} inserted · ${pct}%`
              : 'starting…'}
          </div>
        </div>
      )}

      {result && (
        <div
          className={
            result.ok ? 'text-[13px] text-[var(--wb-text)]' : 'text-[13px] text-destructive'
          }
          data-testid="import-result"
        >
          {result.ok ? (
            <>
              Imported{' '}
              {isSql
                ? `${result.statements ?? 0} statements`
                : `${result.rowsImported.toLocaleString()} rows`}
              .
            </>
          ) : result.cancelled ? (
            <>Cancelled after {result.rowsRead.toLocaleString()} rows read. Nothing was imported.</>
          ) : (
            <>
              <div>
                Import failed
                {result.error?.row ? ` at ${isSql ? 'statement' : 'row'} ${result.error.row}` : ''}.
                Nothing was imported.
              </div>
              <pre className="mt-1 whitespace-pre-wrap font-mono text-[12px]">
                {result.error?.message}
              </pre>
              {result.error?.sample && (
                <pre className="mt-1 whitespace-pre-wrap font-mono text-[12px] text-[var(--wb-text-2)]">
                  {result.error.sample}
                </pre>
              )}
            </>
          )}
        </div>
      )}

      <DialogFooter>
        {running ? (
          <Button
            variant="secondary"
            onClick={() => void ipc.dataImport.cancel(jobId.current)}
            data-testid="import-cancel"
          >
            Cancel import
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {result?.ok ? 'Close' : 'Cancel'}
            </Button>
            {result?.ok && effectiveTable && !isSql && (
              <Button
                variant="secondary"
                onClick={() => {
                  onClose();
                  openTable(
                    mode === 'existing' && selected ? selected.schema : schema,
                    effectiveTable,
                  );
                }}
              >
                Open table
              </Button>
            )}
            <Button onClick={() => void run()} disabled={!canImport} data-testid="import-run">
              Import
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
