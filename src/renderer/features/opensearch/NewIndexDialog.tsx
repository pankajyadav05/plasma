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
import { IconButton, Pill, Segmented } from '@/components/ui/workbench';
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
 * Electron's `ipcRenderer.invoke` prefixes thrown errors with
 * `Error invoking remote method '<channel>': Error: ...`. The user
 * doesn't care about either layer — strip them so the actual cluster
 * message is what they see first.
 */
/** Graphite field look for dialog inputs (--wb-field, 26px, radius 6). */
const FIELD_CLASS =
  'h-[26px] rounded-[6px] border-0 bg-[var(--wb-field)] px-2 font-mono text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_12%,transparent)] placeholder:text-[var(--wb-text-3)] focus-visible:ring-0 focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)] focus:ring-0 focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)]';

const LABEL_CLASS = 'text-[12px] text-[var(--wb-text-2)]';

function stripIpcPrefix(msg: string): string {
  return msg.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '');
}

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
      <DialogContent className="flex h-[88vh] w-[92vw] max-w-none flex-col gap-0 rounded-[10px] border-[var(--wb-separator)] bg-[var(--wb-content)] p-0 text-[13px] text-[var(--wb-text)]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-[var(--wb-separator)] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Boxes className="h-4 w-4 text-[var(--wb-text-2)]" />
            <DialogTitle className="font-sans text-[15px] font-semibold not-italic leading-tight tracking-normal">
              New OpenSearch index
            </DialogTitle>
          </div>
          <DialogDescription className="font-sans text-[13px] not-italic leading-snug text-[var(--wb-text-2)]">
            Define settings + mappings via the form, paste raw JSON to round-trip, or mix both —
            anything the form can&apos;t edit is preserved verbatim.
          </DialogDescription>
        </DialogHeader>

        {/* Top row: name + tabs */}
        <div className="flex shrink-0 items-end gap-4 border-b border-[var(--wb-separator)] px-5 py-3">
          <div className="flex flex-col gap-1">
            <span className={LABEL_CLASS}>Index name</span>
            <Input
              value={spec.name}
              onChange={(e) => commitSpec({ ...spec, name: e.target.value })}
              placeholder="orders-2026-05"
              className={`${FIELD_CLASS} w-72`}
              aria-label="Index name"
              spellCheck={false}
              autoFocus
            />
            {nameError && <span className="text-[12px] text-destructive">{nameError}</span>}
          </div>
          <div className="flex flex-col gap-1">
            <span className={LABEL_CLASS}>Shards</span>
            <Input
              type="number"
              min={1}
              value={spec.shards}
              onChange={(e) =>
                commitSpec({ ...spec, shards: Math.max(1, Number(e.target.value) || 1) })
              }
              className={`${FIELD_CLASS} w-20`}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className={LABEL_CLASS}>Replicas</span>
            <Input
              type="number"
              min={0}
              value={spec.replicas}
              onChange={(e) =>
                commitSpec({ ...spec, replicas: Math.max(0, Number(e.target.value) || 0) })
              }
              className={`${FIELD_CLASS} w-20`}
            />
          </div>

          <div className="flex-1" />

          <Segmented<Mode>
            variant="track"
            ariaLabel="Editor mode"
            value={mode}
            onChange={switchMode}
            options={[
              { value: 'form', label: 'Form', icon: <Boxes /> },
              { value: 'json', label: 'JSON', icon: <Code /> },
            ]}
          />
        </div>

        {/* Notes banner */}
        {parseNotes.length > 0 && (
          <div className="shrink-0 border-b border-[var(--wb-separator)] bg-[var(--wb-sidebar)] px-5 py-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--wb-text-2)]" />
              <div className="flex flex-col gap-0.5 text-[12px] text-[var(--wb-text-2)]">
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
                <div className="shrink-0 border-b border-[var(--wb-separator)] bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] px-5 py-2 font-mono text-[12px] text-[var(--wb-text)]">
                  {jsonError}
                </div>
              )}
              <div className="min-h-0 flex-1">
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-[13px] text-[var(--wb-text-2)]">
                      Loading editor…
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

        {/* Error banner (above footer for readability) */}
        {submitError && (
          <div className="shrink-0 border-t border-[var(--wb-separator)] bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] px-5 py-2.5">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-semibold text-destructive">Create failed</div>
                <div className="mt-0.5 break-words font-mono text-[12px] leading-snug text-[var(--wb-text)]">
                  {stripIpcPrefix(submitError)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex h-12 shrink-0 items-center justify-end gap-2 border-t border-[var(--wb-separator)] px-5">
          <Pill className="h-7 px-3" onClick={() => close()} disabled={submitting}>
            Cancel
          </Pill>
          <Pill
            className="h-7 bg-[var(--wb-control-active)] px-3 font-medium hover:bg-[var(--wb-control-hover)]"
            onClick={() => void onSubmit()}
            disabled={
              submitting ||
              (mode === 'form' && formInvalid) ||
              (mode === 'json' && jsonError !== null)
            }
          >
            {submitting ? 'Creating…' : 'Create index'}
          </Pill>
        </div>
      </DialogContent>
    </Dialog>
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
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--wb-separator)] px-5">
        <span className="text-[13px] font-semibold text-[var(--wb-text)]">Mapping fields</span>
        <Pill onClick={addField}>
          <Plus />
          Add field
        </Pill>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {spec.fields.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-[var(--wb-text-2)]">
            No fields yet — OpenSearch will pick types from your first document, or click &ldquo;Add
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
          ? 'flex items-center gap-2 rounded-[6px] bg-[var(--wb-sidebar)] px-2 py-1'
          : 'group flex items-center gap-2 rounded-[6px] px-2 py-1 hover:bg-[color-mix(in_srgb,var(--wb-text)_4%,transparent)]'
      }
    >
      {field.advanced && <Lock className="h-3.5 w-3.5 shrink-0 text-[var(--wb-text-2)]" />}
      <Input
        value={field.name}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder="field_name"
        disabled={field.advanced}
        className={`${FIELD_CLASS} flex-1`}
        aria-label="Field name"
        spellCheck={false}
      />
      <div className="w-44 shrink-0">
        <Select
          value={field.type}
          onValueChange={(v) => onChange({ type: v as SupportedFieldType })}
          disabled={field.advanced}
        >
          <SelectTrigger className={FIELD_CLASS} aria-label="Field type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORTED_FIELD_TYPES.map((t) => (
              <SelectItem key={t} value={t} className="font-mono text-[13px]">
                {t}
              </SelectItem>
            ))}
            {field.type === 'unknown' && (
              <SelectItem value="unknown" className="font-mono text-[13px] text-[var(--wb-text-2)]">
                unknown
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>

      <label
        className={`flex shrink-0 items-center gap-1.5 font-mono text-[12px] text-[var(--wb-text-2)]${supportsKeywordSub ? '' : ' pointer-events-none opacity-40'}`}
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
          className="shrink-0 rounded-[4px] bg-[var(--wb-control)] px-1.5 py-px text-[11px] text-[var(--wb-text-2)]"
          title="This field uses options the form can't edit. Switch to JSON to modify."
        >
          advanced
        </span>
      )}

      <IconButton
        variant="plain"
        label="Remove field"
        onClick={onRemove}
        className="hover:text-destructive"
      >
        <Trash2 />
      </IconButton>

      {error && <span className="ml-2 shrink-0 text-[12px] text-destructive">{error}</span>}
    </div>
  );
}
