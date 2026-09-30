import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { CheckLine, FormRow } from '@/features/backup/admin-parts';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import {
  DEFAULT_ROLE_ATTRS,
  LIST_ROLES_SQL,
  PRIVILEGES_ROW_CAP,
  type PrivilegeRow,
  ROLE_PRIVILEGES_SQL,
  type RoleAttrs,
  type RoleDraft,
  type RoleRow,
  type SqlStatement,
  TABLE_PRIVILEGES,
  type TablePrivilege,
  alterRoleStatements,
  applicablePrivileges,
  createRoleStatements,
  diffPrivileges,
  dropRoleStatements,
  parsePrivilegeRows,
  parseRoleRows,
  privKey,
  privilegeStatements,
} from '@shared/pg-roles';
import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

const NEW = '\u0000new';
const ALL = '__all__';

const ATTR_LABELS: [
  keyof RoleAttrs &
    ('login' | 'superuser' | 'createdb' | 'createrole' | 'inherit' | 'replication' | 'bypassrls'),
  string,
][] = [
  ['login', 'Can log in'],
  ['superuser', 'Superuser'],
  ['createdb', 'Can create databases'],
  ['createrole', 'Can create roles'],
  ['inherit', 'Inherits privileges of member roles'],
  ['replication', 'Replication'],
  ['bypassrls', 'Bypass row-level security'],
];

function draftOf(row: RoleRow): RoleDraft {
  return { name: row.name, attrs: { ...row.attrs }, memberOf: [...row.memberOf], password: null };
}

export function RolesDialog({
  open,
  onOpenChange,
}: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const activeConfig = useSession((s) => s.activeConfig);
  const schemaInfo = useSession((s) => s.schema);
  const confirmUserSql = useSession((s) => s.confirmUserSql);
  const readOnly = activeConfig?.readOnly === true;

  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [dropping, setDropping] = useState(false);
  const [tab, setTab] = useState<'role' | 'privileges'>('role');
  const [memberFilter, setMemberFilter] = useState('');

  const [privRows, setPrivRows] = useState<PrivilegeRow[]>([]);
  const [privLoading, setPrivLoading] = useState(false);
  const [privError, setPrivError] = useState<string | null>(null);
  const [staged, setStaged] = useState<Map<string, Set<TablePrivilege>>>(new Map());
  const [privSchema, setPrivSchema] = useState(ALL);
  const [privFilter, setPrivFilter] = useState('');

  const [previewOpen, setPreviewOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const original = useMemo(() => roles.find((r) => r.name === selected) ?? null, [roles, selected]);
  const isNew = selected === NEW;

  const loadRoles = useCallback(async () => {
    try {
      const res = await ipc.query.sideband(LIST_ROLES_SQL, undefined, { timeoutMs: 8000 });
      setRoles(parseRoleRows(res.columns, res.rows));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload on open only
  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setDraft(null);
    setApplied(null);
    setApplyError(null);
    void loadRoles();
  }, [open]);

  const select = (name: string) => {
    const row = roles.find((r) => r.name === name);
    if (!row) return;
    setSelected(name);
    setDraft(draftOf(row));
    setDropping(false);
    setStaged(new Map());
    setPrivRows([]);
    setPreviewOpen(false);
    setApplyError(null);
    setApplied(null);
  };

  const startNew = () => {
    setSelected(NEW);
    setDraft({
      name: '',
      attrs: { ...DEFAULT_ROLE_ATTRS, login: true },
      memberOf: [],
      password: '',
    });
    setDropping(false);
    setStaged(new Map());
    setPrivRows([]);
    setTab('role');
    setPreviewOpen(false);
    setApplyError(null);
    setApplied(null);
  };

  // Privileges for the selected role (direct grants).
  useEffect(() => {
    if (!open || !original || tab !== 'privileges') return;
    let alive = true;
    setPrivLoading(true);
    setPrivError(null);
    const handle = setTimeout(() => {
      ipc.query
        .sideband(
          ROLE_PRIVILEGES_SQL,
          [original.name, privSchema === ALL ? '' : privSchema, privFilter.trim()],
          { timeoutMs: 15000 },
        )
        .then((res) => alive && setPrivRows(parsePrivilegeRows(res.rows)))
        .catch((err) => alive && setPrivError(err instanceof Error ? err.message : String(err)))
        .finally(() => alive && setPrivLoading(false));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(handle);
    };
  }, [open, original, tab, privSchema, privFilter]);

  const statements = useMemo<SqlStatement[]>(() => {
    if (!draft) return [];
    try {
      if (isNew)
        return draft.name.trim()
          ? createRoleStatements({ ...draft, password: draft.password || null })
          : [];
      if (!original) return [];
      if (dropping) return dropRoleStatements(original.name);
      const base = draftOf(original);
      const out = alterRoleStatements(base, { ...draft, password: draft.password || null });
      const changes = diffPrivileges(privRows, staged);
      return [...out, ...privilegeStatements(draft.name.trim() || original.name, changes)];
    } catch {
      return [];
    }
  }, [draft, isNew, original, dropping, privRows, staged]);

  const others = roles.filter((r) => r.name !== (original?.name ?? draft?.name));
  const shownRoles = roles.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()));
  const schemas = (schemaInfo?.schemas ?? [])
    .map((s) => s.name)
    .filter((n) => !n.startsWith('pg_') && n !== 'information_schema');

  const apply = async () => {
    if (statements.length === 0 || readOnly) return;
    setApplyError(null);
    const script = statements.map((s) => `${s.display};`).join('\n');
    const ok = await confirmUserSql(script, {
      force: true,
      summary: dropping
        ? `Drop role "${original?.name}"`
        : `Apply ${statements.length} role / privilege change${statements.length === 1 ? '' : 's'}`,
    });
    if (!ok) return;
    setApplying(true);
    let done = 0;
    try {
      for (const s of statements) {
        // internal: keeps PASSWORD literals out of the query history.
        await ipc.query.run(s.sql, undefined, { internal: true });
        done++;
      }
      setApplied(`Applied ${done} statement${done === 1 ? '' : 's'}.`);
      setStaged(new Map());
      const name = dropping ? null : (draft?.name.trim() ?? null);
      await loadRoles();
      if (name) {
        setSelected(name);
      } else {
        setSelected(null);
        setDraft(null);
      }
      setDropping(false);
      setPreviewOpen(false);
      setPrivRows([]);
    } catch (err) {
      setApplyError(
        `${err instanceof Error ? err.message : String(err)}${done > 0 ? ` (${done} of ${statements.length} statements were applied before the error)` : ''}`,
      );
      await loadRoles();
    } finally {
      setApplying(false);
    }
  };

  // Re-sync the draft with fresh catalog data after an apply.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when roles reload
  useEffect(() => {
    if (!selected || selected === NEW || dropping) return;
    const row = roles.find((r) => r.name === selected);
    if (row && applied) setDraft(draftOf(row));
  }, [roles]);

  const setAttr = (patch: Partial<RoleAttrs>) =>
    setDraft((d) => (d ? { ...d, attrs: { ...d.attrs, ...patch } } : d));
  const disabled = readOnly || applying || dropping;

  const togglePriv = (row: PrivilegeRow, p: TablePrivilege, on: boolean) => {
    setStaged((prev) => {
      const next = new Map(prev);
      const key = privKey(row.schema, row.table);
      const cur = new Set(next.get(key) ?? row.privileges);
      if (on) cur.add(p);
      else cur.delete(p);
      next.set(key, cur);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-[980px] flex-col" data-testid="roles-dialog">
        <DialogHeader>
          <DialogTitle>Roles and privileges</DialogTitle>
          <DialogDescription>
            {readOnly
              ? 'This connection is read-only, so roles can be viewed but not changed.'
              : 'Changes are staged. Preview the SQL, then apply.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-[230px_1fr] gap-3">
          <div className="flex min-h-0 flex-col gap-2">
            <div className="flex gap-2">
              <Input
                placeholder="Filter roles"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Filter roles"
              />
              <Button
                variant="secondary"
                size="icon-24"
                onClick={startNew}
                disabled={readOnly}
                aria-label="New role"
                title="New role"
              >
                <Plus />
              </Button>
            </div>
            <div
              className="min-h-0 flex-1 overflow-y-auto rounded-[7px] bg-[var(--wb-field)] p-1 shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)]"
              aria-label="Roles"
            >
              {loadError && <p className="p-2 text-[12px] text-destructive">{loadError}</p>}
              {shownRoles.map((r) => (
                <button
                  key={r.name}
                  type="button"
                  aria-pressed={selected === r.name}
                  onClick={() => select(r.name)}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded-[6px] px-2 py-1 text-left text-[13px]',
                    selected === r.name
                      ? 'bg-[var(--wb-control-active)]'
                      : 'hover:bg-[var(--wb-control-hover)]',
                  )}
                >
                  <span className="truncate text-[var(--wb-text)]">{r.name}</span>
                  <span className="flex flex-wrap gap-1">
                    {r.attrs.superuser && <Badge tone="danger">superuser</Badge>}
                    {r.attrs.login ? <Badge>login</Badge> : <Badge>group</Badge>}
                    {r.attrs.createdb && <Badge>createdb</Badge>}
                    {r.memberOf.length > 0 && <Badge>{r.memberOf.length} member of</Badge>}
                  </span>
                </button>
              ))}
              {isNew && (
                <div className="rounded-[6px] bg-[var(--wb-control-active)] px-2 py-1 text-[13px] text-[var(--wb-text-2)]">
                  New role…
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-2">
            {!draft ? (
              <p className="m-auto text-[13px] text-[var(--wb-text-3)]">
                Select a role, or create one.
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Segmented<'role' | 'privileges'>
                    variant="track"
                    ariaLabel="Role sections"
                    value={tab}
                    onChange={setTab}
                    options={[
                      { value: 'role', label: 'Role' },
                      { value: 'privileges', label: 'Table privileges', disabled: isNew },
                    ]}
                  />
                  <div className="flex-1" />
                  {!isNew && (
                    <Button
                      variant="ghost"
                      onClick={() => setDropping((d) => !d)}
                      disabled={readOnly}
                      className={dropping ? 'text-destructive' : ''}
                    >
                      <Trash2 /> {dropping ? 'Keep role' : 'Drop role'}
                    </Button>
                  )}
                </div>

                {tab === 'role' ? (
                  <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
                    <FormRow label="Name">
                      <Input
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        disabled={disabled}
                        aria-label="Role name"
                      />
                    </FormRow>
                    <FormRow
                      label="Password"
                      hint={isNew ? undefined : 'Leave blank to keep the current password.'}
                    >
                      <Input
                        type="password"
                        autoComplete="new-password"
                        value={draft.password ?? ''}
                        onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                        disabled={disabled}
                        aria-label="Password"
                      />
                    </FormRow>
                    <FormRow label="Attributes">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                        {ATTR_LABELS.map(([key, label]) => (
                          <CheckLine
                            key={key}
                            id={`role-${key}`}
                            label={label}
                            checked={draft.attrs[key]}
                            onChange={(v) => setAttr({ [key]: v })}
                            disabled={disabled}
                          />
                        ))}
                      </div>
                    </FormRow>
                    <FormRow label="Connections" hint="-1 means no limit.">
                      <Input
                        className="w-24"
                        inputMode="numeric"
                        value={String(draft.attrs.connLimit)}
                        onChange={(e) =>
                          setAttr({ connLimit: Number.parseInt(e.target.value, 10) || -1 })
                        }
                        disabled={disabled}
                        aria-label="Connection limit"
                      />
                    </FormRow>
                    <FormRow label="Valid until" hint="Empty means the password never expires.">
                      <Input
                        value={draft.attrs.validUntil ?? ''}
                        placeholder="2030-01-31 00:00:00+00"
                        onChange={(e) =>
                          setAttr({
                            validUntil: e.target.value.trim() === '' ? null : e.target.value,
                          })
                        }
                        disabled={disabled}
                        aria-label="Valid until"
                      />
                    </FormRow>
                    <FormRow label="Member of">
                      <div className="flex flex-col gap-1.5">
                        <Input
                          placeholder="Filter roles"
                          value={memberFilter}
                          onChange={(e) => setMemberFilter(e.target.value)}
                          aria-label="Filter membership roles"
                        />
                        <div className="max-h-32 overflow-y-auto rounded-[7px] bg-[var(--wb-field)] p-2">
                          {others
                            .filter((r) =>
                              r.name.toLowerCase().includes(memberFilter.toLowerCase()),
                            )
                            .map((r) => (
                              <CheckLine
                                key={r.name}
                                id={`role-member-${r.name}`}
                                label={r.name}
                                checked={draft.memberOf.includes(r.name)}
                                disabled={disabled}
                                onChange={(v) =>
                                  setDraft({
                                    ...draft,
                                    memberOf: v
                                      ? [...draft.memberOf, r.name]
                                      : draft.memberOf.filter((n) => n !== r.name),
                                  })
                                }
                              />
                            ))}
                        </div>
                      </div>
                    </FormRow>
                    {original && original.members.length > 0 && (
                      <FormRow label="Members">
                        <div className="flex flex-wrap gap-1">
                          {original.members.map((m) => (
                            <Badge key={m}>{m}</Badge>
                          ))}
                        </div>
                      </FormRow>
                    )}
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col gap-2">
                    <div className="flex gap-2">
                      <Select value={privSchema} onValueChange={setPrivSchema}>
                        <SelectTrigger className="w-[160px]" aria-label="Schema">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ALL}>All schemas</SelectItem>
                          {schemas.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        placeholder="Table name contains"
                        value={privFilter}
                        onChange={(e) => setPrivFilter(e.target.value)}
                        aria-label="Table filter"
                      />
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto rounded-[7px] bg-[var(--wb-field)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)]">
                      <table className="w-full border-collapse text-[12px]">
                        <thead className="sticky top-0 bg-[var(--wb-field)]">
                          <tr className="text-left text-[var(--wb-text-3)]">
                            <th className="px-2 py-1 font-normal">Table</th>
                            {TABLE_PRIVILEGES.map((p) => (
                              <th key={p} className="px-1 py-1 text-center font-normal">
                                {p.slice(0, 3)}
                                <span className="sr-only">{p}</span>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {privRows.map((row) => {
                            const key = privKey(row.schema, row.table);
                            const current = staged.get(key) ?? new Set(row.privileges);
                            const allowed = applicablePrivileges(row.kind);
                            const changed = staged.has(key);
                            return (
                              <tr
                                key={key}
                                className={cn(
                                  'border-t border-[var(--wb-separator)]',
                                  changed &&
                                    'bg-[color-mix(in_srgb,var(--wb-accent)_12%,transparent)]',
                                )}
                              >
                                <td className="max-w-[300px] truncate px-2 py-0.5 text-[var(--wb-text)]">
                                  {row.schema}.{row.table}
                                  {row.kind !== 'r' && row.kind !== 'p' && (
                                    <span className="ml-1 text-[var(--wb-text-3)]">
                                      (
                                      {row.kind === 'v'
                                        ? 'view'
                                        : row.kind === 'm'
                                          ? 'matview'
                                          : 'foreign'}
                                      )
                                    </span>
                                  )}
                                </td>
                                {TABLE_PRIVILEGES.map((p) => (
                                  <td key={p} className="px-1 py-0.5 text-center">
                                    {allowed.includes(p) ? (
                                      <Checkbox
                                        checked={current.has(p)}
                                        disabled={readOnly || applying}
                                        onCheckedChange={(v) => togglePriv(row, p, v === true)}
                                        aria-label={`${p} on ${row.schema}.${row.table}`}
                                      />
                                    ) : null}
                                  </td>
                                ))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {privLoading && (
                        <p className="p-2 text-[12px] text-[var(--wb-text-3)]">Loading…</p>
                      )}
                      {privError && <p className="p-2 text-[12px] text-destructive">{privError}</p>}
                      {!privLoading && !privError && privRows.length === 0 && (
                        <p className="p-3 text-[12px] text-[var(--wb-text-3)]">No tables match.</p>
                      )}
                      {privRows.length >= PRIVILEGES_ROW_CAP && (
                        <p className="p-2 text-[12px] text-[var(--wb-text-3)]">
                          Showing the first {PRIVILEGES_ROW_CAP} tables. Narrow the filter to see
                          others. Direct grants only.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {previewOpen && (
                  <pre
                    className="max-h-32 overflow-auto whitespace-pre-wrap rounded-[7px] bg-[var(--wb-field)] p-2 font-mono text-[11.5px] text-[var(--wb-text-2)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)]"
                    aria-label="SQL preview"
                  >
                    {statements.length
                      ? statements.map((s) => `${s.display};`).join('\n')
                      : '-- No changes'}
                  </pre>
                )}
                {applyError && (
                  <p className="text-[12px] text-destructive" role="alert">
                    {applyError}
                  </p>
                )}
                {applied && (
                  <output className="text-[12px] text-[var(--wb-text-2)]">{applied}</output>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-[var(--wb-text-3)]">
                    {statements.length === 0
                      ? 'No changes'
                      : `${statements.length} staged statement${statements.length === 1 ? '' : 's'}`}
                  </span>
                  <div className="flex-1" />
                  <Button
                    variant="secondary"
                    onClick={() => setPreviewOpen((v) => !v)}
                    disabled={statements.length === 0}
                  >
                    {previewOpen ? 'Hide SQL' : 'Preview SQL'}
                  </Button>
                  <Button
                    variant={dropping ? 'destructive' : 'primary'}
                    onClick={() => void apply()}
                    disabled={readOnly || applying || statements.length === 0}
                  >
                    {applying ? 'Applying…' : dropping ? 'Drop role' : 'Apply'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
