import { Button } from '@/components/ui/button';
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
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { SchemaInfo, SchemaSnapshotMeta } from '@shared/protocol';
import { Camera, Check, Copy, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { buildMigration, computeDiff, summary } from './schema-diff';

const LIVE_KEY = '__live__';

/**
 * Schema diff + migration generator. The user takes named snapshots of
 * the connected schema at different points in time, then picks two
 * (or one snapshot vs the live schema) to diff. Output is a compact
 * change list AND a copy-paste-ready ALTER TABLE migration script.
 *
 * The diff covers relations (tables, views, materialized views, foreign
 * tables) and column-level changes; renamed columns need user hints and are
 * seen as drop + add. See `schema-diff.ts` for the SQL generation.
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
  // Snapshots live in their own store (R-18): the list is metadata, and a
  // snapshot's schema is fetched only once it is picked in a selector.
  const [snapshots, setSnapshots] = useState<SchemaSnapshotMeta[]>([]);
  const [loaded, setLoaded] = useState<Record<string, SchemaInfo | null>>({});
  const ensureAllSchemaColumns = useSession((s) => s.ensureAllSchemaColumns);

  // Columns load per schema on demand (F16); a diff needs all of them.
  useEffect(() => {
    if (open) void ensureAllSchemaColumns();
  }, [open, ensureAllSchemaColumns]);

  useEffect(() => {
    if (open) void ipc.schemaSnapshots.list().then(setSnapshots);
  }, [open]);

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
        schema: loaded[s.id] ?? null,
      });
    }
    return out;
  }, [liveSchema, snapshots, activeConfig, loaded]);

  // Fetch the schema of a snapshot the first time it is selected.
  useEffect(() => {
    for (const id of [leftId, rightId]) {
      if (!id || id === LIVE_KEY || id in loaded) continue;
      setLoaded((prev) => ({ ...prev, [id]: null }));
      void ipc.schemaSnapshots
        .get(id)
        .then((schema) => setLoaded((prev) => ({ ...prev, [id]: schema })));
    }
  }, [leftId, rightId, loaded]);

  const left = sources.find((s) => s.id === leftId)?.schema ?? null;
  const right = sources.find((s) => s.id === rightId)?.schema ?? null;

  const diff = useMemo(() => (left && right ? computeDiff(left, right) : null), [left, right]);

  const takeSnapshot = async () => {
    if (!liveSchema) return;
    // A snapshot must be complete: columns load per schema on demand.
    await ensureAllSchemaColumns();
    const complete = useSession.getState().schema ?? liveSchema;
    const name = snapshotName.trim() || `snapshot-${snapshots.length + 1}`;
    const meta = await ipc.schemaSnapshots.save({
      connectionId: activeConfig?.id ?? null,
      connectionName: activeConfig?.name ?? 'unknown',
      name,
      schema: complete,
    });
    setSnapshotName('');
    setLoaded((prev) => ({ ...prev, [meta.id]: complete }));
    setSnapshots(await ipc.schemaSnapshots.list());
  };

  const deleteSnapshot = async (id: string) => {
    await ipc.schemaSnapshots.delete(id);
    setSnapshots((prev) => prev.filter((s) => s.id !== id));
    if (leftId === id) setLeftId(LIVE_KEY);
    if (rightId === id) setRightId('');
  };

  const migration = diff ? buildMigration(diff, right) : '';

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
          <DialogDescription>
            Compare two schema snapshots (or a snapshot and the live schema) and generate a
            migration.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-[var(--wb-text-2)]">From (old)</span>
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
          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-[var(--wb-text-2)]">To (new)</span>
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

        <div className="flex items-center gap-2 rounded-[7px] bg-[var(--wb-sidebar)] p-2 shadow-[inset_0_0_0_1px_var(--wb-separator)]">
          <Camera className="h-3.5 w-3.5 shrink-0 text-[var(--wb-text-2)]" />
          <Input
            value={snapshotName}
            onChange={(e) => setSnapshotName(e.target.value)}
            placeholder="Snapshot name (optional)"
            className="flex-1"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => void takeSnapshot()}
            disabled={!liveSchema}
          >
            Take snapshot
          </Button>
        </div>

        {snapshots.length > 0 && (
          <div className="max-h-[120px] overflow-y-auto rounded-[7px] border border-[var(--wb-separator)]">
            {snapshots.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 border-b border-[var(--wb-separator)] px-2 py-1 text-[12px] last:border-b-0"
              >
                <span className="truncate font-mono text-[var(--wb-text)]" title={s.name}>
                  {s.name}
                </span>
                <span className="truncate text-[var(--wb-text-2)]">{s.connectionName}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--wb-text-3)]">
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

        <div className="overflow-hidden rounded-[7px] border border-[var(--wb-separator)]">
          <div className="flex h-8 items-center gap-2 border-b border-[var(--wb-separator)] bg-[var(--wb-sidebar)] px-2 text-[12px] text-[var(--wb-text-2)]">
            <span>{diff ? `${summary(diff)}` : 'Pick two sources to diff'}</span>
            <div className="flex-1" />
            {migration && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleCopy}
                title="Copy migration"
                aria-label="Copy migration"
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            )}
          </div>
          <pre className="max-h-[320px] min-h-[160px] overflow-auto bg-[var(--wb-content)] p-3 font-mono text-[12px] leading-relaxed text-[var(--wb-text)]">
            {migration || '-- (no diff)'}
          </pre>
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
