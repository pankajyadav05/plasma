import { sanitizeColumnName } from '@shared/import-parse';
import { rowsPerBatch } from '@shared/import-plan';
import { buildCreateTable, checkType, qualifiedName, quoteIdent } from '@shared/pg-ddl';
import type { ImportJobSpec, ImportPreview } from '@shared/protocol';

/** Compare column names ignoring case, spaces, dashes and underscores. */
function loose(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '');
}

/** Suggested target for each source column: the same-named target column, else null (skip). */
export function autoMap(
  sources: readonly string[],
  targets: readonly string[],
  isPositional: boolean,
): (string | null)[] {
  const used = new Set<string>();
  const out = sources.map((s) => {
    const hit = targets.find((t) => !used.has(t) && (t === s || loose(t) === loose(s)));
    if (hit) used.add(hit);
    return hit ?? null;
  });
  // A header-less CSV has no names to match: map by position instead.
  if (isPositional && out.every((o) => o === null)) {
    return sources.map((_, i) => targets[i] ?? null);
  }
  return out;
}

export interface NewTableColumn {
  name: string;
  type: string;
}

/** Column names + inferred types for "create a new table" from a preview. */
export function newTableColumns(preview: ImportPreview): NewTableColumn[] {
  const used = new Set<string>();
  return preview.columns.map((label, i) => ({
    name: sanitizeColumnName(label, i, used),
    type: preview.types[i] ?? 'text',
  }));
}

/** Default new-table name from a file name. */
export function tableNameFromFile(fileName: string): string {
  return sanitizeColumnName(fileName.replace(/\.[^.]+$/, ''), 0, new Set());
}

export interface BuildJobInput {
  jobId: string;
  connectionGen: number;
  filePath: string;
  schema: string;
  table: string;
  preview: ImportPreview;
  /** Target column name per source column; null = skip. */
  targets: readonly (string | null)[];
  /** Set to create the table (with these columns, aligned with the source columns) first. */
  create?: readonly NewTableColumn[];
}

export interface BuiltJob {
  job: ImportJobSpec;
  /** SQL text shown in the confirmation gate. */
  gateSql: string;
}

export function buildImportJob(input: BuildJobInput): BuiltJob {
  const { preview } = input;
  const positional = preview.format === 'csv' || preview.format === 'tsv';
  const pre: string[] = [];
  const columns: ImportJobSpec['columns'] = [];

  if (preview.format !== 'sql') {
    if (input.create) {
      const cols = input.create
        .map((c, i) => ({ c, i }))
        .filter(({ i }) => input.targets[i] !== null);
      for (const { c } of cols) checkType(c.type);
      pre.push(
        ...buildCreateTable({
          schema: input.schema,
          name: input.table,
          columns: cols.map(({ c }) => ({ name: c.name, type: c.type, nullable: true })),
        }),
      );
    }
    input.targets.forEach((target, i) => {
      if (target === null) return;
      columns.push({
        target,
        source: positional ? i : (preview.columns[i] as string),
      });
    });
    if (columns.length === 0) throw new Error('Map at least one column');
    const seen = new Set<string>();
    for (const c of columns) {
      if (seen.has(c.target)) throw new Error(`Column "${c.target}" is mapped twice`);
      seen.add(c.target);
    }
  }

  const job: ImportJobSpec = {
    jobId: input.jobId,
    connectionGen: input.connectionGen,
    filePath: input.filePath,
    format: preview.format,
    schema: input.schema,
    table: input.table,
    csv: positional && preview.csv ? preview.csv : undefined,
    columns,
    preStatements: pre,
  };
  return { job, gateSql: describeImportSql(job, preview) };
}

/** What the import will run, for the confirmation dialog. */
export function describeImportSql(job: ImportJobSpec, preview: ImportPreview): string {
  const lines = [`-- Import ${job.filePath}`];
  if (job.format === 'sql') {
    lines.push('-- Runs every statement of the file in one transaction:');
    for (const s of preview.statements ?? [])
      lines.push(`${s.replace(/\s+/g, ' ').slice(0, 200)};`);
    if (preview.truncated || (preview.statements?.length ?? 0) >= 20) lines.push('-- …');
    return lines.join('\n');
  }
  for (const s of job.preStatements) lines.push(`${s};`);
  const cols = job.columns.map((c) => quoteIdent(c.target)).join(', ');
  const batch = rowsPerBatch(job.columns.length, job.batchRows);
  lines.push(
    `-- then, in batches of up to ${batch} rows, all in one transaction:`,
    `INSERT INTO ${qualifiedName(job.schema, job.table)} (${cols}) VALUES (...);`,
  );
  return lines.join('\n');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
