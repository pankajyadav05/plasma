import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import { MOD, isMac } from '@/lib/platform';
import { ChevronRight, Dices, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { arrayElementType } from './cell-edit';
import {
  BYTEA_EDIT_MAX_BYTES,
  type SmartEditorKind,
  type TriState,
  base64ToBytes,
  boolText,
  byteaEditable,
  byteaToBytes,
  bytesToBase64,
  bytesToByteaText,
  checkTemporal,
  cycleBool,
  formatByteSize,
  formatHexView,
  formatOffset,
  formatPgArray,
  fromDatetimeLocal,
  generateUuid,
  isUuid,
  joinTemporal,
  jsonDeleteAt,
  jsonLeafText,
  jsonSetAt,
  localZoneLabel,
  minifyJson,
  nowText,
  offsetOf,
  parseBool,
  parseHexInput,
  parseJson,
  parseJsonLeaf,
  parsePgArray,
  prettyJson,
  splitTemporal,
  toDatetimeLocal,
  validateScalar,
} from './cell-values';

export type EditorMove = 'next' | 'prev' | 'down';

export interface SmartEditorProps {
  kind: Exclude<SmartEditorKind, 'text'>;
  columnName: string;
  typeName: string;
  enumValues: string[] | null;
  /** Current Postgres text of the cell (null = NULL). */
  initial: string | null;
  onCommit: (value: string | null, move?: EditorMove) => void;
  onCancel: () => void;
}

const KIND_LABEL: Record<Exclude<SmartEditorKind, 'text'>, string> = {
  json: 'JSON',
  array: 'Array',
  date: 'Date',
  time: 'Time',
  timestamp: 'Timestamp',
  timestamptz: 'Timestamp with time zone',
  enum: 'Enum',
  bool: 'Boolean',
  uuid: 'UUID',
  bytea: 'Binary (bytea)',
};

/** Editors where Enter commits and Tab moves on; the rest are multi-line / list editors. */
const SINGLE_LINE: ReadonlySet<SmartEditorKind> = new Set([
  'date',
  'time',
  'timestamp',
  'timestamptz',
  'enum',
  'bool',
  'uuid',
]);

const FIELD =
  'w-full rounded-[6px] border-0 bg-[var(--wb-field)] px-2 py-1 font-mono text-[12px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]';

interface Check {
  error: string | null;
  warning: string | null;
}

/** Validation of the draft text for each editor (pure, shared by the shell). */
export function checkDraft(
  kind: SmartEditorProps['kind'],
  typeName: string,
  enumValues: string[] | null,
  draft: string | null,
): Check {
  const ok: Check = { error: null, warning: null };
  if (draft === null) return ok;
  switch (kind) {
    case 'json': {
      const p = parseJson(draft);
      return p.ok ? ok : { error: `Invalid JSON: ${p.error}`, warning: null };
    }
    case 'array': {
      const parsed = parsePgArray(draft);
      if (!parsed.ok) return { error: null, warning: `Edited as text (${parsed.reason}).` };
      const elementType = arrayElementType(typeName);
      for (let i = 0; i < parsed.elements.length; i++) {
        const el = parsed.elements[i];
        if (el === null || el === undefined) continue;
        const msg = validateScalar(elementType, el, enumValues);
        if (msg) return { error: `Element ${i + 1}: ${msg}`, warning: null };
      }
      return ok;
    }
    case 'date':
    case 'time':
    case 'timestamp':
    case 'timestamptz': {
      if (draft.trim() === '')
        return { error: null, warning: 'Empty — use NULL to clear the value.' };
      return { error: null, warning: checkTemporal(kind === 'time' ? typeName : kind, draft) };
    }
    case 'uuid':
      return isUuid(draft.trim()) || draft === ''
        ? ok
        : { error: null, warning: 'Not a UUID — the server will reject it.' };
    case 'enum':
      return enumValues?.includes(draft)
        ? ok
        : { error: `"${draft}" is not one of the enum labels`, warning: null };
    case 'bool':
      return parseBool(draft) === undefined
        ? { error: 'Expected true or false', warning: null }
        : ok;
    default:
      return ok;
  }
}

/**
 * Popover editor for the structured column types (JSON, arrays, dates,
 * enums, booleans, uuid, bytea). It is anchored to the cell it sits in, edits
 * Postgres text and hands the result to `onCommit`.
 *
 * Keys: Enter commits (single-line editors; ⌘/Ctrl+Enter everywhere), Esc
 * cancels, Tab / Shift+Tab commit and move to the next / previous cell
 * (single-line editors — in JSON / array / bytea Tab moves between controls).
 */
export function SmartCellEditor(props: SmartEditorProps) {
  const { kind, columnName, typeName, enumValues, initial, onCommit, onCancel } = props;
  const [draft, setDraft] = useState<string | null>(initial);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const done = useRef(false);
  const escapeGuard = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const readOnly = kind === 'bytea' && !byteaEditable(initial);

  const check = useMemo(
    () => checkDraft(kind, typeName, enumValues, draft),
    [kind, typeName, enumValues, draft],
  );
  const error = bodyError ?? check.error;
  const dirty = draft !== initial;

  const commit = (value: string | null, move?: EditorMove) => {
    if (done.current) return;
    done.current = true;
    onCommit(value, move);
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };
  const apply = (move?: EditorMove) => {
    if (readOnly || error) return;
    if (!dirty) return cancel();
    commit(draft, move);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter' && mod) {
      e.preventDefault();
      apply();
      return;
    }
    if (!SINGLE_LINE.has(kind)) return;
    if (e.key === 'Enter' && !e.shiftKey && target.tagName !== 'BUTTON') {
      e.preventDefault();
      apply('down');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      apply(e.shiftKey ? 'prev' : 'next');
    }
  };

  return (
    <Popover open>
      <PopoverAnchor asChild>
        <span aria-hidden className="pointer-events-none absolute inset-0" />
      </PopoverAnchor>
      <PopoverContent
        ref={contentRef}
        side="bottom"
        align="start"
        sideOffset={2}
        className="w-[420px] max-w-[92vw] p-0"
        // biome-ignore lint/a11y/useSemanticElements: Radix popover content, not a native <dialog>
        role="dialog"
        aria-label={`Edit ${columnName}`}
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const first = contentRef.current?.querySelector<HTMLElement>('[data-autofocus]');
          (first ?? contentRef.current)?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(e) => {
          if (escapeGuard.current) {
            e.preventDefault();
            return;
          }
          cancel();
        }}
        onInteractOutside={(e) => {
          // Clicking away behaves like leaving the inline editor: keep a
          // valid change, drop the rest.
          e.preventDefault();
          if (dirty && !error && !readOnly) commit(draft);
          else cancel();
        }}
      >
        <div className="flex items-baseline justify-between gap-3 border-b border-[var(--wb-separator)] px-3 py-2">
          <div className="min-w-0">
            <div className="truncate font-mono text-[12px] font-semibold text-[var(--wb-text)]">
              {columnName}
            </div>
            <div className="text-[11px] text-[var(--wb-text-2)]">
              {KIND_LABEL[kind]}
              {kind !== 'json' && ` · ${typeName}`}
            </div>
          </div>
          {draft === null && (
            <span className="rounded-[4px] bg-[var(--wb-control)] px-1.5 py-0.5 font-sans text-[11px] text-[var(--grid-null)]">
              NULL
            </span>
          )}
        </div>

        <div className="max-h-[360px] overflow-auto px-3 py-2.5">
          {kind === 'json' && (
            <JsonBody draft={draft} setDraft={setDraft} escapeGuard={escapeGuard} />
          )}
          {kind === 'array' && (
            <ArrayBody
              draft={draft}
              setDraft={setDraft}
              elementType={arrayElementType(typeName)}
              enumValues={enumValues}
            />
          )}
          {(kind === 'date' ||
            kind === 'time' ||
            kind === 'timestamp' ||
            kind === 'timestamptz') && (
            <TemporalBody
              kind={kind}
              typeName={kind === 'time' ? typeName : kind}
              draft={draft}
              setDraft={setDraft}
            />
          )}
          {kind === 'enum' && (
            <EnumBody
              labels={enumValues ?? []}
              draft={draft}
              setDraft={setDraft}
              onPick={() => apply('down')}
            />
          )}
          {kind === 'bool' && <BoolBody draft={draft} setDraft={setDraft} />}
          {kind === 'uuid' && <UuidBody draft={draft} setDraft={setDraft} />}
          {kind === 'bytea' && (
            <ByteaBody
              initial={initial}
              draft={draft}
              setDraft={setDraft}
              readOnly={readOnly}
              setError={setBodyError}
            />
          )}
        </div>

        {(error || check.warning) && (
          <div
            className={cn(
              'border-t border-[var(--wb-separator)] px-3 py-1.5 text-[12px]',
              error ? 'text-destructive' : 'text-[var(--wb-text-2)]',
            )}
            role={error ? 'alert' : 'status'}
          >
            {error ?? check.warning}
          </div>
        )}

        <div className="flex items-center gap-1.5 border-t border-[var(--wb-separator)] px-3 py-2">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => commit(null)}
            disabled={readOnly}
            title="Set to SQL NULL (⇧⌘⌫)"
          >
            Set NULL
          </Button>
          <span className="flex-1 truncate text-center text-[11px] text-[var(--wb-text-3)]">
            {SINGLE_LINE.has(kind)
              ? 'Enter apply · Tab next · Esc cancel'
              : `${MOD}${isMac ? '' : '+'}↵ apply · Esc cancel`}
          </span>
          <Button size="xs" variant="secondary" onClick={cancel}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly && (
            <Button size="xs" variant="primary" onClick={() => apply()} disabled={Boolean(error)}>
              Apply
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Bodies ──────────────────────────────────────────────────────────

interface DraftProps {
  draft: string | null;
  setDraft: (v: string | null) => void;
}

function Tabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="mb-2 inline-flex rounded-[6px] bg-[var(--wb-control)] p-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[5px] px-2 py-0.5 text-[12px] transition-colors',
            value === o.value
              ? 'bg-[var(--wb-control-active)] text-[var(--wb-text)]'
              : 'text-[var(--wb-text-2)] hover:text-[var(--wb-text)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// JSON ----------------------------------------------------------------

function JsonBody({
  draft,
  setDraft,
  escapeGuard,
}: DraftProps & { escapeGuard: React.MutableRefObject<boolean> }) {
  const [view, setView] = useState<'tree' | 'code'>('code');
  const parsed = useMemo(() => (draft === null ? null : parseJson(draft)), [draft]);
  const pretty = () => {
    const t = draft === null ? null : prettyJson(draft);
    if (t !== null) setDraft(t);
  };
  const minify = () => {
    const t = draft === null ? null : minifyJson(draft);
    if (t !== null) setDraft(t);
  };
  return (
    <div>
      <div className="flex items-center justify-between">
        <Tabs
          value={view}
          onChange={setView}
          options={[
            { value: 'code', label: 'Code' },
            { value: 'tree', label: 'Tree' },
          ]}
        />
        <div className="mb-2 flex gap-1">
          <Button size="xs" variant="ghost" onClick={pretty} disabled={!parsed?.ok}>
            Pretty-print
          </Button>
          <Button size="xs" variant="ghost" onClick={minify} disabled={!parsed?.ok}>
            Minify
          </Button>
        </div>
      </div>
      {view === 'code' ? (
        <textarea
          data-autofocus
          aria-label="JSON"
          value={draft ?? ''}
          spellCheck={false}
          rows={10}
          onChange={(e) => setDraft(e.target.value)}
          className={cn(
            FIELD,
            'resize-y leading-relaxed',
            parsed && !parsed.ok && 'ring-1 ring-destructive',
          )}
        />
      ) : !parsed ? (
        <div className="text-[12px] text-[var(--wb-text-2)]">
          NULL — switch to Code to type a document.
        </div>
      ) : !parsed.ok ? (
        <div className="text-[12px] text-[var(--wb-text-2)]">
          The document is not valid JSON yet — fix it in the Code view to use the tree.
        </div>
      ) : (
        <div data-autofocus tabIndex={-1} className="outline-none">
          <JsonNode
            value={parsed.value}
            path={[]}
            depth={0}
            escapeGuard={escapeGuard}
            onChange={(next) => setDraft(JSON.stringify(next, null, 2) ?? 'null')}
            root={parsed.value}
          />
        </div>
      )}
    </div>
  );
}

function JsonNode({
  value,
  path,
  depth,
  root,
  onChange,
  escapeGuard,
}: {
  value: unknown;
  path: Array<string | number>;
  depth: number;
  root: unknown;
  onChange: (next: unknown) => void;
  escapeGuard: React.MutableRefObject<boolean>;
}) {
  const [open, setOpen] = useState(depth < 2);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);

  if (value !== null && typeof value === 'object') {
    const isArray = Array.isArray(value);
    const entries: Array<[string | number, unknown]> = isArray
      ? (value as unknown[]).map((v, i) => [i, v])
      : Object.entries(value as Record<string, unknown>);
    return (
      <div className="font-mono text-[12px] leading-relaxed">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-[var(--wb-text-2)]"
          aria-expanded={open}
        >
          <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
          {isArray ? `[${entries.length}]` : `{${entries.length}}`}
        </button>
        {open && (
          <ul className="ml-3 border-l border-[var(--wb-separator)] pl-2">
            {entries.map(([k, v]) => (
              <li key={String(k)} className="group/leaf flex items-baseline gap-1.5 py-px">
                <span className="text-[var(--wb-text-2)]">{k}</span>
                <span className="text-[var(--wb-text-3)]">:</span>
                <div className="min-w-0 flex-1">
                  <JsonNode
                    value={v}
                    path={[...path, k]}
                    depth={depth + 1}
                    root={root}
                    onChange={onChange}
                    escapeGuard={escapeGuard}
                  />
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${k}`}
                  onClick={() => onChange(jsonDeleteAt(root, [...path, k]))}
                  className="opacity-0 transition-opacity group-hover/leaf:opacity-100 focus-visible:opacity-100"
                >
                  <Trash2 className="h-3 w-3 text-[var(--wb-text-3)] hover:text-destructive" />
                </button>
              </li>
            ))}
            <li className="py-px">
              {newKey === null ? (
                <button
                  type="button"
                  onClick={() => {
                    if (isArray) onChange(jsonSetAt(root, [...path, entries.length], null));
                    else setNewKey('');
                  }}
                  className="text-[11px] text-[var(--wb-text-3)] hover:text-[var(--wb-text)]"
                >
                  + {isArray ? 'item' : 'key'}
                </button>
              ) : (
                <input
                  // biome-ignore lint/a11y/noAutofocus: opened by an explicit click
                  autoFocus
                  aria-label="New key"
                  value={newKey}
                  placeholder="key"
                  onChange={(e) => setNewKey(e.target.value)}
                  onFocus={() => {
                    escapeGuard.current = true;
                  }}
                  onBlur={() => {
                    escapeGuard.current = false;
                    setNewKey(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' && newKey !== '') {
                      e.preventDefault();
                      onChange(jsonSetAt(root, [...path, newKey], null));
                      setNewKey(null);
                    } else if (e.key === 'Escape') {
                      setNewKey(null);
                    }
                  }}
                  className="h-5 w-32 rounded-[4px] bg-[var(--wb-field)] px-1 text-[11px] outline-none"
                />
              )}
            </li>
          </ul>
        )}
      </div>
    );
  }

  // Leaf
  if (editing) {
    const finish = (commit: boolean) => {
      escapeGuard.current = false;
      setEditing(false);
      if (commit) onChange(jsonSetAt(root, path, parseJsonLeaf(text)));
    };
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: opened by an explicit click
        autoFocus
        aria-label="Value"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          escapeGuard.current = true;
          e.currentTarget.select();
        }}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
        className="h-5 w-full rounded-[4px] bg-[var(--wb-field)] px-1 font-mono text-[12px] outline-none ring-1 ring-[var(--wb-accent)]"
      />
    );
  }
  return (
    <button
      type="button"
      title={'Click to edit (numbers, true, false, null and "text" keep their type)'}
      onClick={() => {
        setText(jsonLeafText(value));
        setEditing(true);
      }}
      className={cn(
        'max-w-full truncate text-left',
        value === null
          ? 'text-[var(--grid-null)]'
          : typeof value === 'string'
            ? 'text-[var(--wb-text)]'
            : 'text-[var(--wb-accent)]',
      )}
    >
      {jsonLeafText(value)}
    </button>
  );
}

// Array ---------------------------------------------------------------

function ArrayBody({
  draft,
  setDraft,
  elementType,
  enumValues,
}: DraftProps & { elementType: string | null; enumValues: string[] | null }) {
  const parsed = useMemo(() => (draft === null ? null : parsePgArray(draft)), [draft]);
  const [raw, setRaw] = useState(false);
  const asText = raw || (parsed !== null && !parsed.ok);
  const elements = parsed?.ok ? parsed.elements : [];
  const set = (next: Array<string | null>) => setDraft(formatPgArray(next));
  const isBool = elementType === 'bool' || elementType === 'boolean';
  const enumElementValues = enumValues && enumValues.length > 0 ? enumValues : null;

  if (draft === null) {
    return (
      <div className="flex items-center justify-between text-[12px] text-[var(--wb-text-2)]">
        The array is NULL.
        <Button size="xs" variant="secondary" onClick={() => setDraft('{}')}>
          Start an empty array
        </Button>
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center justify-between">
        <Tabs
          value={asText ? 'raw' : 'list'}
          onChange={(v) => setRaw(v === 'raw')}
          options={[
            { value: 'list', label: 'List' },
            { value: 'raw', label: 'Literal' },
          ]}
        />
        <span className="mb-2 text-[11px] text-[var(--wb-text-3)]">
          {elementType ?? 'unknown'}[] · {parsed?.ok ? `${elements.length} items` : 'text'}
        </span>
      </div>
      {asText ? (
        <textarea
          data-autofocus
          aria-label="Array literal"
          value={draft}
          rows={4}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          className={cn(FIELD, 'resize-y')}
        />
      ) : (
        <ol className="flex flex-col gap-1">
          {elements.map((el, i) => {
            const msg = el === null ? null : validateScalar(elementType, el, enumElementValues);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional list items
              <li key={i} className="flex items-center gap-1.5">
                <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-[var(--wb-text-3)]">
                  {i + 1}
                </span>
                {el === null ? (
                  <button
                    type="button"
                    onClick={() => set(elements.map((x, j) => (j === i ? '' : x)))}
                    className={cn(FIELD, 'text-left text-[var(--grid-null)]')}
                    title="NULL element — click to give it a value"
                  >
                    NULL
                  </button>
                ) : isBool || enumElementValues ? (
                  <select
                    data-autofocus={i === 0 ? true : undefined}
                    aria-label={`Element ${i + 1}`}
                    value={el}
                    onChange={(e) => set(elements.map((x, j) => (j === i ? e.target.value : x)))}
                    className={FIELD}
                  >
                    {(isBool ? ['true', 'false'] : (enumElementValues ?? [])).map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                    {!(isBool ? ['true', 'false'] : (enumElementValues ?? [])).includes(el) && (
                      <option value={el}>{el}</option>
                    )}
                  </select>
                ) : (
                  <input
                    data-autofocus={i === 0 ? true : undefined}
                    aria-label={`Element ${i + 1}`}
                    aria-invalid={msg ? true : undefined}
                    value={el}
                    spellCheck={false}
                    onChange={(e) => set(elements.map((x, j) => (j === i ? e.target.value : x)))}
                    className={cn(FIELD, msg && 'ring-1 ring-destructive')}
                    title={msg ?? undefined}
                  />
                )}
                <button
                  type="button"
                  title={el === null ? 'Already NULL' : 'Make this element NULL'}
                  disabled={el === null}
                  onClick={() => set(elements.map((x, j) => (j === i ? null : x)))}
                  className="shrink-0 rounded-[4px] px-1 text-[11px] text-[var(--wb-text-3)] hover:text-[var(--wb-text)] disabled:opacity-30"
                >
                  NULL
                </button>
                <button
                  type="button"
                  aria-label={`Remove element ${i + 1}`}
                  onClick={() => set(elements.filter((_, j) => j !== i))}
                  className="shrink-0 text-[var(--wb-text-3)] hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            );
          })}
          <li>
            <Button
              size="xs"
              variant="ghost"
              data-autofocus={elements.length === 0 ? true : undefined}
              onClick={() =>
                set([
                  ...elements,
                  isBool ? 'false' : enumElementValues ? (enumElementValues[0] ?? '') : '',
                ])
              }
            >
              + Add element
            </Button>
          </li>
        </ol>
      )}
    </div>
  );
}

// Dates / times ---------------------------------------------------------

function TemporalBody({
  kind,
  typeName,
  draft,
  setDraft,
}: DraftProps & { kind: 'date' | 'time' | 'timestamp' | 'timestamptz'; typeName: string }) {
  const text = draft ?? '';
  const parts = splitTemporal(text, typeName);
  const hasTz = typeName.toLowerCase() === 'timestamptz' || typeName.toLowerCase() === 'timetz';
  const tz = parts?.tz ?? '';
  const stored = offsetOf(text, typeName);
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-[11px] text-[var(--wb-text-2)]">
        Value
        <input
          data-autofocus
          aria-label="Raw value"
          value={text}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          className={FIELD}
          placeholder={
            kind === 'date' ? 'YYYY-MM-DD' : kind === 'time' ? 'HH:MM:SS' : 'YYYY-MM-DD HH:MM:SS'
          }
        />
      </label>
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1 text-[11px] text-[var(--wb-text-2)]">
          Picker
          {kind === 'date' ? (
            <input
              type="date"
              aria-label="Date"
              value={parts?.date ?? ''}
              onChange={(e) => setDraft(e.target.value)}
              className={FIELD}
            />
          ) : kind === 'time' ? (
            <input
              type="time"
              step="1"
              aria-label="Time"
              value={parts?.time.slice(0, 8) ?? ''}
              onChange={(e) =>
                setDraft(joinTemporal({ date: '', time: e.target.value, tz }, typeName))
              }
              className={FIELD}
            />
          ) : (
            <input
              type="datetime-local"
              step="1"
              aria-label="Date and time"
              value={toDatetimeLocal(text, typeName)}
              onChange={(e) => {
                if (!e.target.value) return;
                const zone = hasTz ? tz || formatOffset(-new Date().getTimezoneOffset()) : '';
                setDraft(fromDatetimeLocal(e.target.value, zone, typeName));
              }}
              className={FIELD}
            />
          )}
        </div>
        <Button size="xs" variant="secondary" onClick={() => setDraft(nowText(typeName))}>
          Now
        </Button>
      </div>
      {hasTz && (
        <label className="flex items-center gap-2 text-[11px] text-[var(--wb-text-2)]">
          Offset
          <input
            aria-label="UTC offset"
            value={tz}
            placeholder="+05:30"
            spellCheck={false}
            onChange={(e) => {
              if (parts) setDraft(joinTemporal({ ...parts, tz: e.target.value }, typeName));
            }}
            className={cn(FIELD, 'w-24')}
          />
        </label>
      )}
      <div className="text-[11px] text-[var(--wb-text-3)]">
        {hasTz
          ? stored
            ? `Stored with offset ${stored}. `
            : 'No offset given — the session time zone applies. '
          : kind === 'date'
            ? ''
            : 'No time zone is stored. '}
        Your zone: {localZoneLabel()}
      </div>
    </div>
  );
}

// Enum ----------------------------------------------------------------

function EnumBody({
  labels,
  draft,
  setDraft,
  onPick,
}: DraftProps & { labels: string[]; onPick: () => void }) {
  return (
    <select
      data-autofocus
      aria-label="Enum value"
      size={Math.min(8, Math.max(2, labels.length))}
      value={draft ?? ''}
      onChange={(e) => setDraft(e.target.value)}
      onDoubleClick={onPick}
      className={cn(FIELD, 'py-0.5')}
    >
      {labels.map((l) => (
        <option key={l} value={l}>
          {l}
        </option>
      ))}
    </select>
  );
}

// Boolean -------------------------------------------------------------

function BoolBody({ draft, setDraft }: DraftProps) {
  const parsed = draft === null ? null : parseBool(draft);
  const state: TriState = parsed === undefined ? null : parsed;
  const options: Array<{ value: TriState; label: string }> = [
    { value: null, label: 'NULL' },
    { value: true, label: 'true' },
    { value: false, label: 'false' },
  ];
  const set = (s: TriState) => setDraft(boolText(s));
  return (
    <div
      data-autofocus
      role="radiogroup"
      aria-label="Boolean value"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-driven tri-state toggle (←/→, T, F, N)
      tabIndex={0}
      className="inline-flex rounded-[7px] bg-[var(--wb-control)] p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === ' ') {
          e.preventDefault();
          set(cycleBool(state));
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          set(cycleBool(state, true));
        } else if (e.key.toLowerCase() === 't') set(true);
        else if (e.key.toLowerCase() === 'f') set(false);
        else if (e.key.toLowerCase() === 'n') set(null);
      }}
    >
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          // biome-ignore lint/a11y/useSemanticElements: radio semantics on a button group
          role="radio"
          aria-checked={state === o.value}
          tabIndex={-1}
          onClick={() => set(o.value)}
          className={cn(
            'min-w-14 rounded-[5px] px-3 py-1 font-mono text-[12px] transition-colors',
            state === o.value
              ? 'bg-[var(--wb-text)] text-[var(--wb-content)]'
              : 'text-[var(--wb-text-2)] hover:text-[var(--wb-text)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// UUID ----------------------------------------------------------------

function UuidBody({ draft, setDraft }: DraftProps) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        data-autofocus
        aria-label="UUID"
        value={draft ?? ''}
        spellCheck={false}
        placeholder="00000000-0000-0000-0000-000000000000"
        onChange={(e) => setDraft(e.target.value)}
        className={FIELD}
      />
      <Button
        size="xs"
        variant="secondary"
        onClick={() => setDraft(generateUuid())}
        title="Generate a random (v4) UUID"
      >
        <Dices />
        Generate
      </Button>
    </div>
  );
}

// bytea ---------------------------------------------------------------

function ByteaBody({
  initial,
  draft,
  setDraft,
  readOnly,
  setError,
}: DraftProps & {
  initial: string | null;
  readOnly: boolean;
  setError: (message: string | null) => void;
}) {
  const [view, setView] = useState<'hex' | 'base64'>('hex');
  const bytes = draft === null ? new Uint8Array(0) : byteaToBytes(draft);
  const shown = (b: Uint8Array | null): string => {
    if (!b) return draft ?? '';
    const slice = readOnly ? b.subarray(0, 512) : b;
    return view === 'hex' ? formatHexView(slice) : bytesToBase64(slice);
  };
  const [text, setText] = useState(() => shown(bytes));
  // Re-render the text when the view switches (or the bytes change from outside).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only view switches resync the text
  useEffect(() => {
    setText(shown(draft === null ? new Uint8Array(0) : byteaToBytes(draft)));
    setError(null);
  }, [view]);

  const edit = (next: string) => {
    setText(next);
    const decoded = view === 'hex' ? parseHexInput(next) : base64ToBytes(next);
    if (!decoded) {
      setError(view === 'hex' ? 'Not valid hex (pairs of 0-9 a-f).' : 'Not valid base64.');
      return;
    }
    setError(null);
    setDraft(bytesToByteaText(decoded));
  };

  if (initial !== null && byteaToBytes(initial) === null) {
    return (
      <div className="text-[12px] text-[var(--wb-text-2)]">
        This value is not in hex format and cannot be shown as bytes.
      </div>
    );
  }
  const size = bytes?.length ?? 0;
  return (
    <div>
      <div className="flex items-center justify-between">
        <Tabs
          value={view}
          onChange={setView}
          options={[
            { value: 'hex', label: 'Hex' },
            { value: 'base64', label: 'Base64' },
          ]}
        />
        <span className="mb-2 text-[11px] tabular-nums text-[var(--wb-text-3)]">
          {formatByteSize(size)}
        </span>
      </div>
      <textarea
        data-autofocus
        aria-label={view === 'hex' ? 'Hex bytes' : 'Base64 bytes'}
        value={text}
        readOnly={readOnly}
        rows={8}
        spellCheck={false}
        onChange={(e) => edit(e.target.value)}
        className={cn(FIELD, 'resize-y', readOnly && 'opacity-80')}
      />
      {readOnly && (
        <div className="mt-1.5 text-[11px] text-[var(--wb-text-3)]">
          Read-only: values over {formatByteSize(BYTEA_EDIT_MAX_BYTES)} are not editable here
          {size > 512 ? ' (showing the first 512 bytes)' : ''}.
        </div>
      )}
    </div>
  );
}
