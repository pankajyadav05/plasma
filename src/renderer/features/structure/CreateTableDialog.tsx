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
import { IconButton } from '@/components/ui/workbench';
import { useSession } from '@/stores/session';
import { DdlError, buildCreateTable, quoteIdent } from '@shared/pg-ddl';
import type { ColumnSpec } from '@shared/pg-ddl';
import { Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { applyStructurePlan } from './apply-structure';
import { useStructureDialogs } from './structure-dialogs-store';
import { CellInput, FieldLabel, PgTypeDatalist, SqlPreview, TypeInput } from './structure-parts';

interface Row extends ColumnSpec {
  key: number;
}

let rowKey = 0;
const newRow = (over: Partial<ColumnSpec> = {}): Row => ({
  key: ++rowKey,
  name: '',
  type: 'text',
  nullable: true,
  ...over,
});

/** Create table: columns grid with type autocomplete, PK / NOT NULL / default, Preview SQL. */
export function CreateTableDialog() {
  const target = useStructureDialogs((s) => s.createTable);
  const close = useStructureDialogs((s) => s.close);
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && close()}>
      {target && <CreateTableBody initialSchema={target.schema} onClose={close} />}
    </Dialog>
  );
}

function CreateTableBody({
  initialSchema,
  onClose,
}: {
  initialSchema: string;
  onClose: () => void;
}) {
  const schemaInfo = useSession((s) => s.schema);
  const openTable = useSession((s) => s.openTable);
  const readOnly = useSession((s) => Boolean(s.activeConfig?.readOnly));
  const [schema, setSchema] = useState(initialSchema);
  const [name, setName] = useState('');
  const [lintBlocked, setLintBlocked] = useState(false);
  const [comment, setComment] = useState('');
  const [rows, setRows] = useState<Row[]>(() => [
    newRow({ name: 'id', type: 'bigserial', nullable: false, primaryKey: true }),
    newRow(),
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const schemas = useMemo(() => {
    const names = (schemaInfo?.schemas ?? []).map((s) => s.name);
    return names.includes(initialSchema) ? names : [initialSchema, ...names];
  }, [schemaInfo, initialSchema]);

  const patch = (key: number, p: Partial<ColumnSpec>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const built = useMemo(() => {
    const cols = rows.filter((r) => r.name.trim() !== '' || r.primaryKey);
    try {
      if (!name.trim()) return { sql: '', statements: [] as string[], problem: null };
      const statements = buildCreateTable({
        schema,
        name: name.trim(),
        comment,
        columns: cols.map(({ key: _k, ...c }) => c),
      });
      return { sql: `${statements.join(';\n')};`, statements, problem: null };
    } catch (err) {
      return {
        sql: '',
        statements: [] as string[],
        problem: err instanceof DdlError ? err.message : String(err),
      };
    }
  }, [rows, name, schema, comment]);

  const canCreate =
    !readOnly && !busy && built.statements.length > 0 && !built.problem && !lintBlocked;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const out = await applyStructurePlan(
      { transactional: built.statements, concurrent: [] },
      `create table ${schema}.${name.trim()}`,
    );
    setBusy(false);
    if (out.ok) {
      onClose();
      openTable(schema, name.trim());
    } else if (!out.cancelled) {
      setError(out.message);
    }
  };

  return (
    <DialogContent className="max-w-[820px]" data-testid="create-table-dialog">
      <PgTypeDatalist />
      <DialogHeader>
        <DialogTitle>New table</DialogTitle>
        <DialogDescription>
          Define the columns, review the SQL, then create it in one transaction.
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-[180px_1fr_1fr] gap-3">
        <div>
          <FieldLabel htmlFor="ct-schema">Schema</FieldLabel>
          <Select value={schema} onValueChange={setSchema}>
            <SelectTrigger id="ct-schema" aria-label="Schema">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {schemas.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <FieldLabel htmlFor="ct-name">Table name</FieldLabel>
          <Input
            id="ct-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="orders"
            spellCheck={false}
          />
        </div>
        <div>
          <FieldLabel htmlFor="ct-comment">Comment (optional)</FieldLabel>
          <Input id="ct-comment" value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
      </div>

      <div className="max-h-[260px] overflow-auto rounded-[6px] shadow-[inset_0_0_0_1px_var(--wb-separator)]">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="text-left text-[var(--wb-text-2)]">
              <th className="px-2 py-1 font-medium">Column</th>
              <th className="px-2 py-1 font-medium">Type</th>
              <th className="w-9 px-1 py-1 text-center font-medium" title="Primary key">
                PK
              </th>
              <th className="w-[72px] px-1 py-1 text-center font-medium">Not null</th>
              <th className="px-2 py-1 font-medium">Default</th>
              <th className="w-7" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} data-testid="create-table-row">
                <td className="px-1 py-0.5">
                  <CellInput
                    value={r.name}
                    aria-label={`Column ${i + 1} name`}
                    onChange={(e) => patch(r.key, { name: e.target.value })}
                    placeholder="column_name"
                  />
                </td>
                <td className="px-1 py-0.5">
                  <TypeInput
                    value={r.type}
                    aria-label={`Column ${i + 1} type`}
                    onChange={(e) => patch(r.key, { type: e.target.value })}
                  />
                </td>
                <td className="px-1 py-0.5 text-center">
                  <Checkbox
                    aria-label={`Column ${i + 1} primary key`}
                    checked={r.primaryKey === true}
                    onCheckedChange={(v) =>
                      patch(r.key, {
                        primaryKey: v === true,
                        ...(v === true ? { nullable: false } : {}),
                      })
                    }
                  />
                </td>
                <td className="px-1 py-0.5 text-center">
                  <Checkbox
                    aria-label={`Column ${i + 1} not null`}
                    checked={!r.nullable || r.primaryKey === true}
                    disabled={r.primaryKey === true}
                    onCheckedChange={(v) => patch(r.key, { nullable: v !== true })}
                  />
                </td>
                <td className="px-1 py-0.5">
                  <CellInput
                    value={r.default ?? ''}
                    aria-label={`Column ${i + 1} default`}
                    onChange={(e) => patch(r.key, { default: e.target.value })}
                    placeholder="NULL"
                  />
                </td>
                <td className="px-0.5 py-0.5">
                  <IconButton
                    label={`Remove column ${i + 1}`}
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                    disabled={rows.length <= 1}
                  >
                    <X />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <Button variant="secondary" size="sm" onClick={() => setRows((rs) => [...rs, newRow()])}>
          <Plus />
          Add column
        </Button>
      </div>

      <div>
        <FieldLabel>Preview SQL</FieldLabel>
        <SqlPreview
          className="max-h-[170px]"
          sql={built.sql}
          error={built.problem}
          onLintBlockedChange={setLintBlocked}
          emptyText={`Name the table to see the SQL for ${quoteIdent(schema)}.…`}
        />
      </div>
      {readOnly && (
        <p className="text-[12px] text-destructive">
          This connection is read-only — tables cannot be created.
        </p>
      )}
      {error && <p className="whitespace-pre-wrap text-[12px] text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => void submit()}
          disabled={!canCreate}
          data-testid="create-table-submit"
        >
          {busy ? 'Creating…' : 'Create table'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
