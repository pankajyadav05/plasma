import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import type { SchemaInfo, Settings } from '@shared/protocol';
import { Camera, Check, Copy, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

type Snapshot = Settings['schemaSnapshots'][number];

const LIVE_KEY = '__live__';

/**
 * Schema diff + migration generator. The user takes named snapshots of
 * the connected schema at different points in time, then picks two
 * (or one snapshot vs the live schema) to diff. Output is a compact
 * change list AND a copy-paste-ready ALTER TABLE migration script.
 *
 * The diff is intentionally column-level only for v0.1 — we don't
 * detect renamed columns (would need user hints) or constraint changes
 * beyond NULLability. Both are TODOs once the basic flow is proven out.
 */
export function SchemaDiffDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const liveSchema = useSession((s) => s.schema);
  const activeConfig = useSession((s) => s.activeConfig);
  const snapshots = useSession((s) => s.settings.schemaSnapshots ?? []);
  const updateSettings = useSession((s) => s.updateSettings);

  const [snapshotName, setSnapshotName] = useState('');
  const [leftId, setLeftId] = useState<string>(LIVE_KEY);
  const [rightId, setRightId] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const sources: Array<{ id: string; label: string; schema: SchemaInfo | null }> = useMemo(() => {
    const out: Array<{ id: string; label: string; schema: SchemaInfo | null }> = [
      {
        id: LIVE_KEY,
        label: liveSchema
          ? `Live · ${activeConfig?.name ?? 'current connection'}`
          : 'Live · (not connected)',
        schema: liveSchema,
      },
    ];
    for (const s of snapshots) {
      out.push({
        id: s.id,
        label: `${s.name} · ${s.connectionName} · ${new Date(s.createdAt).toLocaleString()}`,
        schema: s.schema,
      });
    }
    return out;
  }, [liveSchema, snapshots, activeConfig]);

  const left = sources.find((s) => s.id === leftId)?.schema ?? null;
  const right = sources.find((s) => s.id === rightId)?.schema ?? null;

  const diff = useMemo(() => (left && right ? computeDiff(left, right) : null), [left, right]);

  const takeSnapshot = async () => {
    if (!liveSchema) return;
    const name = snapshotName.trim() || `snapshot-${snapshots.length + 1}`;
    const entry: Snapshot = {
      id: freshId(),
      connectionId: activeConfig?.id ?? null,
      connectionName: activeConfig?.name ?? 'unknown',
      name,
      schema: liveSchema,
      createdAt: Date.now(),
    };
    // Cap at 50 — older snapshots fall off the back to keep the settings
    // payload bounded.
    const next = [entry, ...snapshots].slice(0, 50);
    setSnapshotName('');
    await updateSettings({ schemaSnapshots: next });
  };

  const deleteSnapshot = async (id: string) => {
    await updateSettings({
      schemaSnapshots: snapshots.filter((s) => s.id !== id),
    });
    if (leftId === id) setLeftId(LIVE_KEY);
    if (rightId === id) setRightId('');
  };

  const migration = diff ? buildMigration(diff) : '';

  const handleCopy = () => {
    if (!migration) return;
    void navigator.clipboard?.writeText(migration).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Schema diff</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <span className="font-display text-xs uppercase tracking-wider text-muted-foreground">
              From (old)
            </span>
            <Select value={leftId} onValueChange={setLeftId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <span className="font-display text-xs uppercase tracking-wider text-muted-foreground">
              To (new)
            </span>
            <Select value={rightId} onValueChange={setRightId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a snapshot…" />
              </SelectTrigger>
              <SelectContent>
                {sources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2">
          <Camera className="h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={snapshotName}
            onChange={(e) => setSnapshotName(e.target.value)}
            placeholder="Snapshot name (optional)"
            className="h-7 flex-1 text-xs"
          />
          <Button
            variant="primary"
            size="xs"
            onClick={() => void takeSnapshot()}
            disabled={!liveSchema}
          >
            Take snapshot
          </Button>
        </div>

        {snapshots.length > 0 && (
          <div className="max-h-[120px] overflow-y-auto rounded-md border border-border">
            {snapshots.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 border-b border-border/60 px-2 py-1 text-xs last:border-b-0"
              >
                <span className="font-mono text-foreground">{s.name}</span>
                <span className="text-muted-foreground">{s.connectionName}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {new Date(s.createdAt).toLocaleString()}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void deleteSnapshot(s.id)}
                  aria-label="Delete snapshot"
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-md border border-border">
          <div className="flex items-center gap-2 border-b border-border px-2 py-1.5 font-display text-xs italic text-muted-foreground">
            <span>{diff ? `${summary(diff)}` : 'pick two sources to diff'}</span>
            <div className="flex-1" />
            {migration && (
              <Button variant="ghost" size="icon-xs" onClick={handleCopy} title="Copy migration">
                {copied ? <Check className="text-primary" /> : <Copy />}
              </Button>
            )}
          </div>
          <pre className="max-h-[320px] min-h-[160px] overflow-auto bg-muted/20 p-3 font-mono text-[11px] leading-relaxed text-foreground">
            {migration || '-- (no diff)'}
          </pre>
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── diff core ────────────────────────────────────────────────────────

interface ColRef {
  schema: string;
  table: string;
  name: string;
  dataType: string;
  isNullable: boolean;
}

interface SchemaDiff {
  addedTables: Array<{ schema: string; name: string }>;
  droppedTables: Array<{ schema: string; name: string }>;
  changes: Array<{
    schema: string;
    table: string;
    addedCols: ColRef[];
    droppedCols: ColRef[];
    typeChanges: Array<{ name: string; from: string; to: string }>;
    nullabilityChanges: Array<{ name: string; from: boolean; to: boolean }>;
  }>;
}

function computeDiff(a: SchemaInfo, b: SchemaInfo): SchemaDiff {
  const aTables = new Map(a.tables.map((t) => [`${t.schema}.${t.name}`, t]));
  const bTables = new Map(b.tables.map((t) => [`${t.schema}.${t.name}`, t]));

  const addedTables: Array<{ schema: string; name: string }> = [];
  const droppedTables: Array<{ schema: string; name: string }> = [];
  for (const k of bTables.keys()) {
    if (!aTables.has(k)) {
      const t = bTables.get(k);
      if (t) addedTables.push({ schema: t.schema, name: t.name });
    }
  }
  for (const k of aTables.keys()) {
    if (!bTables.has(k)) {
      const t = aTables.get(k);
      if (t) droppedTables.push({ schema: t.schema, name: t.name });
    }
  }

  const aColsByTable = groupCols(a);
  const bColsByTable = groupCols(b);
  const changes: SchemaDiff['changes'] = [];

  for (const k of new Set([...aColsByTable.keys(), ...bColsByTable.keys()])) {
    if (!aTables.has(k) || !bTables.has(k)) continue; // table-level change handled above
    const aCols = aColsByTable.get(k) ?? [];
    const bCols = bColsByTable.get(k) ?? [];
    const aByName = new Map(aCols.map((c) => [c.name, c]));
    const bByName = new Map(bCols.map((c) => [c.name, c]));
    const addedCols: ColRef[] = [];
    const droppedCols: ColRef[] = [];
    const typeChanges: Array<{ name: string; from: string; to: string }> = [];
    const nullabilityChanges: Array<{ name: string; from: boolean; to: boolean }> = [];
    for (const col of bCols) {
      if (!aByName.has(col.name)) addedCols.push(col);
    }
    for (const col of aCols) {
      const newer = bByName.get(col.name);
      if (!newer) droppedCols.push(col);
      else {
        if (newer.dataType !== col.dataType) {
          typeChanges.push({ name: col.name, from: col.dataType, to: newer.dataType });
        }
        if (newer.isNullable !== col.isNullable) {
          nullabilityChanges.push({
            name: col.name,
            from: col.isNullable,
            to: newer.isNullable,
          });
        }
      }
    }
    if (
      addedCols.length === 0 &&
      droppedCols.length === 0 &&
      typeChanges.length === 0 &&
      nullabilityChanges.length === 0
    ) {
      continue;
    }
    const [schemaName, tableName] = k.split('.');
    changes.push({
      schema: schemaName,
      table: tableName,
      addedCols,
      droppedCols,
      typeChanges,
      nullabilityChanges,
    });
  }

  return { addedTables, droppedTables, changes };
}

function groupCols(s: SchemaInfo): Map<string, ColRef[]> {
  const m = new Map<string, ColRef[]>();
  for (const c of s.columns) {
    const key = `${c.schema}.${c.table}`;
    const arr = m.get(key) ?? [];
    arr.push({
      schema: c.schema,
      table: c.table,
      name: c.name,
      dataType: c.dataType,
      isNullable: c.isNullable,
    });
    m.set(key, arr);
  }
  return m;
}

function summary(d: SchemaDiff): string {
  const parts: string[] = [];
  if (d.addedTables.length) parts.push(`+${d.addedTables.length} tables`);
  if (d.droppedTables.length) parts.push(`-${d.droppedTables.length} tables`);
  if (d.changes.length) parts.push(`${d.changes.length} altered`);
  return parts.length ? parts.join(' · ') : 'no changes';
}

function buildMigration(d: SchemaDiff): string {
  const lines: string[] = [];
  for (const t of d.addedTables) {
    lines.push(`-- TODO: CREATE TABLE "${t.schema}"."${t.name}" (...);`);
  }
  for (const t of d.droppedTables) {
    lines.push(`DROP TABLE "${t.schema}"."${t.name}";`);
  }
  for (const c of d.changes) {
    for (const a of c.addedCols) {
      const nullable = a.isNullable ? '' : ' NOT NULL';
      lines.push(
        `ALTER TABLE "${c.schema}"."${c.table}" ADD COLUMN "${a.name}" ${a.dataType}${nullable};`,
      );
    }
    for (const dCol of c.droppedCols) {
      lines.push(`ALTER TABLE "${c.schema}"."${c.table}" DROP COLUMN "${dCol.name}";`);
    }
    for (const tc of c.typeChanges) {
      lines.push(
        `ALTER TABLE "${c.schema}"."${c.table}" ALTER COLUMN "${tc.name}" TYPE ${tc.to}; -- was ${tc.from}`,
      );
    }
    for (const nc of c.nullabilityChanges) {
      lines.push(
        `ALTER TABLE "${c.schema}"."${c.table}" ALTER COLUMN "${nc.name}" ${nc.to ? 'DROP NOT NULL' : 'SET NOT NULL'};`,
      );
    }
  }
  return lines.length ? lines.join('\n') : '-- no changes';
}

function freshId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Suppress unused import warning when cn isn't used inline.
void cn;
