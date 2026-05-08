import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useEffect, useState } from 'react';

/**
 * Saved-query variable prompt. Snippets can reference `:varname` style
 * placeholders in their SQL — when the user opens such a snippet, this
 * dialog collects values for each variable before the SQL is loaded
 * into a new tab.
 *
 * Substitution is plain string replace (we drop quotes around the value
 * so the user can paste full identifiers / lists). For safer parameter
 * binding, users should still rely on Postgres `$1` style placeholders
 * — those flow through `pg`'s native bind path.
 */
export function SnippetVarsDialog({
  open,
  varNames,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  varNames: string[];
  onCancel: () => void;
  onConfirm: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setValues(Object.fromEntries(varNames.map((v) => [v, ''])));
    }
  }, [open, varNames]);

  const submit = () => {
    onConfirm(values);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Fill snippet variables</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-3"
        >
          {varNames.map((v) => (
            <div key={v} className="flex flex-col gap-1.5">
              <Label htmlFor={`var-${v}`} className="font-mono text-xs">
                :{v}
              </Label>
              <Input
                id={`var-${v}`}
                value={values[v] ?? ''}
                onChange={(e) => setValues((s) => ({ ...s, [v]: e.target.value }))}
                autoFocus={varNames[0] === v}
              />
            </div>
          ))}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm">
              Open
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Match `:varname` placeholders. We deliberately don't match `::cast`
 * (Postgres double-colon casts) or `:'...'` quoted variable references.
 * Each name is captured once even if it appears multiple times.
 */
export function extractSnippetVars(sql: string): string[] {
  const re = /(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null = re.exec(sql);
  while (m !== null) {
    out.add(m[1]);
    m = re.exec(sql);
  }
  return [...out];
}

export function applySnippetVars(sql: string, values: Record<string, string>): string {
  return sql.replace(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)\b/g, (_, name: string) => {
    return values[name] ?? `:${name}`;
  });
}
