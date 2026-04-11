import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useActiveTab, useSession } from "@/stores/session";

/**
 * Modal form for inserting a new row into the active table tab. Pulls
 * the column list from the schema (not the result), so columns hidden
 * from the current query still appear. Blank inputs are sent as:
 *   - NULL  if the column is nullable
 *   - DEFAULT (column omitted) if the column has a default
 *   - empty string otherwise
 */
export function InsertRowDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const tab = useActiveTab();
  const schema = useSession((s) => s.schema);
  const insertRow = useSession((s) => s.insertRow);

  const columns =
    tab && tab.kind === "table" && tab.tableSchema && tab.tableName
      ? (schema?.columns ?? [])
          .filter((c) => c.schema === tab.tableSchema && c.table === tab.tableName)
          .sort((a, b) => a.ordinal - b.ordinal)
      : [];

  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset form whenever the dialog opens
  useEffect(() => {
    if (open) {
      setValues({});
      setError(null);
    }
  }, [open]);

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await insertRow(values);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!tab || tab.kind !== "table") return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Insert row</DialogTitle>
          <DialogDescription>
            {tab.tableSchema}.{tab.tableName} — blanks use column defaults or NULL.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto px-8 py-6">
          <div className="flex flex-col gap-4">
            {columns.map((col) => (
              <div key={col.name} className="flex flex-col gap-1.5">
                <label
                  htmlFor={`insert-${col.name}`}
                  className="flex items-baseline gap-2 font-mono text-xs text-ink-muted"
                >
                  <span className="font-semibold text-ink">{col.name}</span>
                  <span className="uppercase tracking-widest">{col.dataType}</span>
                  {col.isPrimaryKey && (
                    <span className="text-accent">pk</span>
                  )}
                  {!col.isNullable && !col.hasDefault && (
                    <span className="text-accent">required</span>
                  )}
                  {col.hasDefault && <span className="italic">default</span>}
                </label>
                <input
                  id={`insert-${col.name}`}
                  type="text"
                  value={values[col.name] ?? ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [col.name]: e.target.value }))
                  }
                  placeholder={
                    col.hasDefault
                      ? "(default)"
                      : col.isNullable
                        ? "(null)"
                        : ""
                  }
                  className="h-9 border border-border-soft bg-paper-canvas px-3 font-mono text-sm text-ink outline-none focus:border-accent"
                />
              </div>
            ))}
          </div>

          {error && (
            <div className="mt-4 border border-accent bg-accent/10 px-3 py-2 font-mono text-xs text-accent">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? "Inserting…" : "Insert row"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
