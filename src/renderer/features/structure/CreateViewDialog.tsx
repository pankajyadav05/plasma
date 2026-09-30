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
import { useSession } from '@/stores/session';
import { DdlError, buildCreateView } from '@shared/pg-ddl';
import { useMemo, useState } from 'react';
import { applyStructurePlan } from './apply-structure';
import { useStructureDialogs } from './structure-dialogs-store';
import { CheckRow, FieldLabel, SqlPreview } from './structure-parts';

/** Create view / materialized view from a SELECT. */
export function CreateViewDialog() {
  const target = useStructureDialogs((s) => s.createView);
  const close = useStructureDialogs((s) => s.close);
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && close()}>
      {target && <CreateViewBody initialSchema={target.schema} onClose={close} />}
    </Dialog>
  );
}

function CreateViewBody({
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
  const [query, setQuery] = useState('SELECT ');
  const [materialized, setMaterialized] = useState(false);
  const [orReplace, setOrReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const schemas = useMemo(() => {
    const names = (schemaInfo?.schemas ?? []).map((s) => s.name);
    return names.includes(initialSchema) ? names : [initialSchema, ...names];
  }, [schemaInfo, initialSchema]);

  const built = useMemo(() => {
    if (!name.trim()) return { sql: '', problem: null as string | null };
    try {
      const sql = buildCreateView({
        schema,
        name: name.trim(),
        query,
        materialized,
        orReplace: orReplace && !materialized,
      });
      return { sql: `${sql};`, problem: null };
    } catch (err) {
      return { sql: '', problem: err instanceof DdlError ? err.message : String(err) };
    }
  }, [schema, name, query, materialized, orReplace]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const out = await applyStructurePlan(
      { transactional: [built.sql.replace(/;$/, '')], concurrent: [] },
      `create view ${schema}.${name.trim()}`,
    );
    setBusy(false);
    if (out.ok) {
      onClose();
      openTable(schema, name.trim());
    } else if (!out.cancelled) setError(out.message);
  };

  return (
    <DialogContent className="max-w-[640px]" data-testid="create-view-dialog">
      <DialogHeader>
        <DialogTitle>New view</DialogTitle>
        <DialogDescription>Create a view or materialized view from a query.</DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-[180px_1fr] gap-3">
        <div>
          <FieldLabel htmlFor="cv-schema">Schema</FieldLabel>
          <Select value={schema} onValueChange={setSchema}>
            <SelectTrigger id="cv-schema" aria-label="Schema">
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
          <FieldLabel htmlFor="cv-name">View name</FieldLabel>
          <Input
            id="cv-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
          />
        </div>
      </div>
      <div>
        <FieldLabel htmlFor="cv-query">Query</FieldLabel>
        <textarea
          id="cv-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          rows={6}
          className="w-full resize-y rounded-[7px] border-0 bg-[var(--wb-field)] px-2 py-1.5 font-mono text-[12px] text-[var(--wb-text)] outline-none shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] focus:shadow-[inset_0_0_0_1px_var(--ring)]"
        />
      </div>
      <div className="flex items-center gap-5 text-[13px]">
        <CheckRow checked={materialized} onChange={setMaterialized}>
          Materialized
        </CheckRow>
        <CheckRow
          checked={orReplace && !materialized}
          disabled={materialized}
          onChange={setOrReplace}
        >
          OR REPLACE
        </CheckRow>
      </div>
      <div>
        <FieldLabel>Preview SQL</FieldLabel>
        <SqlPreview
          className="max-h-[150px]"
          sql={built.sql}
          error={built.problem}
          emptyText="Name the view to see the SQL."
        />
      </div>
      {readOnly && (
        <p className="text-[12px] text-destructive">
          This connection is read-only — views cannot be created.
        </p>
      )}
      {error && <p className="whitespace-pre-wrap text-[12px] text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => void submit()}
          disabled={readOnly || busy || !built.sql}
          data-testid="create-view-submit"
        >
          {busy ? 'Creating…' : 'Create view'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
