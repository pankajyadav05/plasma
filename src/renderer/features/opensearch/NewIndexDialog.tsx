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
import { PLASMA_THEME_ID, applyMonacoTheme } from '@/features/editor/paperTheme';
import { ipc } from '@/lib/ipc';
import {
  DEFAULT_SPEC,
  type FieldSpec,
  type IndexSpec,
  type ParseError,
  SUPPORTED_FIELD_TYPES,
  type SupportedFieldType,
  parseJson,
  toJson,
  validateFieldName,
  validateIndexName,
} from '@/lib/os-index-spec';
import { useSession } from '@/stores/session';
import type { OnMount } from '@monaco-editor/react';
import { AlertTriangle, Boxes, Code, Lock, Plus, Trash2 } from 'lucide-react';
import type * as MonacoType from 'monaco-editor';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';

const Editor = lazy(() => import('@monaco-editor/react').then((m) => ({ default: m.default })));

type Mode = 'form' | 'json';

/**
 * Create-index dialog with two synchronised views.
 *
 * Form view edits a structured `IndexSpec`. JSON view edits the raw
 * create-index body. Switching to JSON regenerates from the spec
 * (canonical form). Switching back from JSON parses, hard-failing if
 * the JSON is malformed (no silent data loss). Anything the form can't
 * represent stays in `field.raw` / `unknownTop` / `unknownSettings` so
 * round-trips are lossless.
 */
export function NewIndexDialog() {
  const open = useSession((s) => s.osNewIndexOpen);
  const close = useSession((s) => s.closeOsNewIndex);
  const refreshOverview = useSession((s) => s.refreshOsOverview);
  const themeName = useSession((s) => s.settings.theme);
  const fontSize = useSession((s) => s.settings.editorFontSize);

  const [mode, setMode] = useState<Mode>('form');
  const [spec, setSpec] = useState<IndexSpec>(DEFAULT_SPEC);
  const [jsonText, setJsonText] = useState<string>(() => toJson(DEFAULT_SPEC));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [parseNotes, setParseNotes] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // True when the spec is the live source of truth. False right after
  // typing in the JSON editor — we leave the JSON text alone until the
  // user re-renders it (switch back to form, or it parses successfully).
  const jsonDirty = useRef(false);
  // Stable per-row ids so React doesn't reuse keys when rows are
  // removed (which would shift array indices). Mirrors `spec.fields`
  // length and is regenerated on parse / dialog open.
  const [fieldIds, setFieldIds] = useState<string[]>([]);
  const idCounter = useRef(0);
  const newId = () => `f${idCounter.current++}`;

  // Reset dialog state when (re)opened.
  useEffect(() => {
    if (open) {
      const fresh = { ...DEFAULT_SPEC, fields: [] };
      setSpec(fresh);
      setJsonText(toJson(fresh));
      setMode('form');
      setJsonError(null);
      setParseNotes([]);
      setSubmitError(null);
      setFieldIds([]);
      idCounter.current = 0;
      jsonDirty.current = false;
    }
  }, [open]);

  const nameError = useMemo(() => validateIndexName(spec.name), [spec.name]);

  const fieldErrors = useMemo(() => {
    const errs: Record<number, string> = {};
    const seen = new Map<string, number>();
    spec.fields.forEach((f, i) => {
      const e = validateFieldName(f.name);
      if (e) {
        errs[i] = e;
        return;
      }
      if (seen.has(f.name)) {
        errs[i] = `duplicate name (also at row ${(seen.get(f.name) as number) + 1})`;
        return;
      }
      seen.set(f.name, i);
    });
    return errs;
  }, [spec.fields]);

  const formInvalid = nameError !== null || Object.keys(fieldErrors).length > 0;

  function commitSpec(next: IndexSpec) {
    setSpec(next);
    if (mode === 'form' || !jsonDirty.current) {
      setJsonText(toJson(next));
      setJsonError(null);
    }
  }

  function setField(i: number, patch: Partial<FieldSpec>) {
    const next = [...spec.fields];
    next[i] = { ...next[i], ...patch };
    commitSpec({ ...spec, fields: next });
  }

  function addField() {
    const next: FieldSpec = {
      name: '',
      type: 'keyword',
      keywordSubfield: false,
      advanced: false,
    };
    setFieldIds((ids) => [...ids, newId()]);
    commitSpec({ ...spec, fields: [...spec.fields, next] });
  }

  function removeField(i: number) {
    setFieldIds((ids) => ids.filter((_, idx) => idx !== i));
    commitSpec({ ...spec, fields: spec.fields.filter((_, idx) => idx !== i) });
  }

  function switchMode(next: Mode) {
    if (next === mode) return;
    if (next === 'json') {
      setJsonText(toJson(spec));
      setJsonError(null);
      jsonDirty.current = false;
      setMode('json');
      return;
    }
    // Switching to form — try to parse current JSON. Hard-fail to keep
    // the user in JSON mode if it's broken (no silent data loss).
    try {
      const parsed = parseJson(jsonText, spec.name);
      const merged = { ...parsed.spec, name: spec.name || parsed.spec.name };
      setSpec(merged);
      setFieldIds(merged.fields.map(() => newId()));
      setParseNotes(parsed.notes);
      setJsonError(null);
      jsonDirty.current = false;
      setMode('form');
    } catch (err) {
      const msg = (err as ParseError).message ?? 'invalid JSON';
      setJsonError(msg);
    }
  }

  function onJsonChange(value: string | undefined) {
    const text = value ?? '';
    setJsonText(text);
    jsonDirty.current = true;
    // Live-validate but don't touch the spec until the user switches
    // back — that's the explicit "commit JSON" step.
    try {
      JSON.parse(text);
      setJsonError(null);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err));
    }
  }

  const handleMount: OnMount = (_editor, monaco) => {
    applyMonacoTheme(monaco as typeof MonacoType, themeName);
  };

  async function onSubmit() {
    setSubmitError(null);
    // Make sure we submit the live JSON if the user is in JSON mode.
    let body: Record<string, unknown>;
    let name = spec.name;
    if (mode === 'json') {
      try {
        const parsed = parseJson(jsonText, spec.name);
        body = (await import('@/lib/os-index-spec')).toBody(parsed.spec);
        name = parsed.spec.name || spec.name;
      } catch (err) {
        setSubmitError((err as ParseError).message ?? 'invalid JSON');
        return;
      }
    } else {
      body = (await import('@/lib/os-index-spec')).toBody(spec);
    }
    const nameErr = validateIndexName(name);
    if (nameErr) {
      setSubmitError(`name: ${nameErr}`);
      return;
    }
    setSubmitting(true);
    try {
      await ipc.os.createIndex(name, body);
      await refreshOverview();
      close();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && close()}>
      <DialogContent className="flex h-[88vh] w-[92vw] max-w-none flex-col p-0">
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Boxes className="h-4 w-4 text-primary" />
            <DialogTitle>New OpenSearch index</DialogTitle>
          </div>
          <DialogDescription>
            Define settings + mappings via the form, paste raw JSON to round-trip, or mix both —
            anything the form can&apos;t edit is preserved verbatim.
          </DialogDescription>
        </DialogHeader>

        {/* Top row: name + tabs */}
        <div className="flex shrink-0 items-end gap-4 border-b border-border px-5 py-3">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Index name
            </span>
            <Input
              value={spec.name}
              onChange={(e) => commitSpec({ ...spec, name: e.target.value })}
              placeholder="orders-2026-05"
              className="h-8 w-72 font-mono text-xs"
              autoFocus
            />
            {nameError && (
              <span className="font-display text-[11px] italic text-destructive">{nameError}</span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Shards
            </span>
            <Input
              type="number"
              min={1}
              value={spec.shards}
              onChange={(e) =>
                commitSpec({ ...spec, shards: Math.max(1, Number(e.target.value) || 1) })
              }
              className="h-8 w-20 font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Replicas
            </span>
            <Input
              type="number"
              min={0}
              value={spec.replicas}
              onChange={(e) =>
                commitSpec({ ...spec, replicas: Math.max(0, Number(e.target.value) || 0) })
              }
              className="h-8 w-20 font-mono text-xs"
            />
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-1 rounded-md border border-border bg-muted/40 p-0.5">
            <ModeButton active={mode === 'form'} onClick={() => switchMode('form')}>
              <Boxes className="h-3.5 w-3.5" />
              Form
            </ModeButton>
            <ModeButton active={mode === 'json'} onClick={() => switchMode('json')}>
              <Code className="h-3.5 w-3.5" />
              JSON
            </ModeButton>
          </div>
        </div>

        {/* Notes banner */}
        {parseNotes.length > 0 && (
          <div className="shrink-0 border-b border-border bg-muted/30 px-5 py-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="flex flex-col gap-0.5 font-display text-[11px] italic text-muted-foreground">
                {parseNotes.map((n) => (
                  <span key={n}>{n}</span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {mode === 'form' ? (
            <FormView
              spec={spec}
              fieldIds={fieldIds}
              fieldErrors={fieldErrors}
              setField={setField}
              addField={addField}
              removeField={removeField}
            />
          ) : (
            <div className="flex h-full flex-col">
              {jsonError && (
                <div className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-5 py-2 font-mono text-[11px] text-destructive">
                  {jsonError}
                </div>
              )}
              <div className="min-h-0 flex-1">
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center font-display text-sm italic text-muted-foreground">
                      loading editor…
                    </div>
                  }
                >
                  <Editor
                    language="json"
                    value={jsonText}
                    onChange={onJsonChange}
                    onMount={handleMount}
                    theme={PLASMA_THEME_ID}
                    options={{
                      fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, monospace',
                      fontSize,
                      lineNumbers: 'on',
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                      tabSize: 2,
                      formatOnPaste: true,
                    }}
                  />
                </Suspense>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-3">
          <div className="font-display text-[11px] italic text-muted-foreground">
            {submitError && <span className="text-destructive">{submitError}</span>}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => close()} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={() => void onSubmit()}
              disabled={
                submitting ||
                (mode === 'form' && formInvalid) ||
                (mode === 'json' && jsonError !== null)
              }
            >
              {submitting ? 'Creating…' : 'Create index'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'flex cursor-pointer items-center gap-1.5 rounded-sm bg-background px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-foreground shadow-sm'
          : 'flex cursor-pointer items-center gap-1.5 rounded-sm px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground'
      }
    >
      {children}
    </button>
  );
}

function FormView({
  spec,
  fieldIds,
  fieldErrors,
  setField,
  addField,
  removeField,
}: {
  spec: IndexSpec;
  fieldIds: string[];
  fieldErrors: Record<number, string>;
  setField(i: number, patch: Partial<FieldSpec>): void;
  addField(): void;
  removeField(i: number): void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          Mapping fields
        </span>
        <Button variant="secondary" size="sm" onClick={addField}>
          <Plus className="h-3.5 w-3.5" />
          Add field
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {spec.fields.length === 0 ? (
          <div className="flex h-full items-center justify-center font-display text-sm italic text-muted-foreground">
            no fields yet — OpenSearch will pick types from your first document, or click &ldquo;Add
            field&rdquo; to declare the mapping up front.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {spec.fields.map((f, i) => (
              <FieldRow
                key={fieldIds[i] ?? `f-fallback-${i}`}
                field={f}
                error={fieldErrors[i]}
                onChange={(patch) => setField(i, patch)}
                onRemove={() => removeField(i)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FieldRow({
  field,
  error,
  onChange,
  onRemove,
}: {
  field: FieldSpec;
  error?: string;
  onChange(patch: Partial<FieldSpec>): void;
  onRemove(): void;
}) {
  const supportsKeywordSub = field.type === 'text';

  return (
    <div
      className={
        field.advanced
          ? 'flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5'
          : 'group flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5'
      }
    >
      {field.advanced && <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      <Input
        value={field.name}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder="field_name"
        disabled={field.advanced}
        className="h-7 flex-1 font-mono text-xs"
      />
      <div className="w-44 shrink-0">
        <Select
          value={field.type}
          onValueChange={(v) => onChange({ type: v as SupportedFieldType })}
          disabled={field.advanced}
        >
          <SelectTrigger className="h-7 font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORTED_FIELD_TYPES.map((t) => (
              <SelectItem key={t} value={t} className="font-mono text-xs">
                {t}
              </SelectItem>
            ))}
            {field.type === 'unknown' && (
              <SelectItem value="unknown" className="font-mono text-xs italic">
                unknown
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>

      <label
        className={`flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-wider${supportsKeywordSub ? ' text-muted-foreground' : ' opacity-40 pointer-events-none'}`}
        title={
          supportsKeywordSub
            ? 'Add a `.keyword` sub-field for exact-match aggregations'
            : 'Only available for `text` fields'
        }
      >
        <input
          type="checkbox"
          checked={field.keywordSubfield && supportsKeywordSub}
          disabled={!supportsKeywordSub || field.advanced}
          onChange={(e) => onChange({ keywordSubfield: e.target.checked })}
          className="cursor-pointer"
        />
        .keyword
      </label>

      {field.advanced && (
        <span
          className="shrink-0 rounded-sm border border-border px-1 py-0 font-mono text-[9px] uppercase text-muted-foreground"
          title="This field uses options the form can't edit. Switch to JSON to modify."
        >
          advanced
        </span>
      )}

      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onRemove}
        title="Remove field"
        className="shrink-0"
      >
        <Trash2 />
      </Button>

      {error && (
        <span className="ml-2 shrink-0 font-display text-[11px] italic text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
