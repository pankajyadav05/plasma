import { cellToText } from '@/features/result-grid/cell-edit';
import type { SchemaInfo } from '@shared/protocol';

/**
 * Pure helpers for the right-sidebar Details pane: how a field is shown
 * and which typed editor it gets (G1 / VF28).
 */

export type FieldEditorKind = 'bool' | 'enum' | 'json' | 'text';

function baseType(typeName: string | null | undefined): string {
  return (typeName ?? '')
    .replace(/\(.*\)/, '')
    .trim()
    .toLowerCase();
}

function isArrayType(t: string): boolean {
  return t.endsWith('[]') || t.startsWith('_');
}

export function isJsonTypeName(typeName: string | null | undefined): boolean {
  const t = baseType(typeName);
  return t === 'json' || t === 'jsonb';
}

/** Enum labels for a column type, when the type is a known enum. */
export function enumValuesFor(
  schema: SchemaInfo | null | undefined,
  typeName: string | null | undefined,
): string[] | null {
  if (!schema || !typeName) return null;
  const t = baseType(typeName);
  const hit = (schema.types ?? []).find(
    (ty) =>
      ty.kind === 'enum' &&
      (ty.name.toLowerCase() === t || `${ty.schema}.${ty.name}`.toLowerCase() === t),
  );
  return hit?.values && hit.values.length > 0 ? hit.values : null;
}

/** Which editor a field gets: bool / enum pickers, JSON text, plain text. */
export function fieldEditorKind(
  typeName: string | null | undefined,
  enumValues?: readonly string[] | null,
): FieldEditorKind {
  const t = baseType(typeName);
  if (isArrayType(t)) return 'text';
  if (t === 'bool' || t === 'boolean') return 'bool';
  if (t === 'json' || t === 'jsonb') return 'json';
  if (enumValues && enumValues.length > 0) return 'enum';
  return 'text';
}

/**
 * Display text for a non-null value. JSON documents (and JSON stored as
 * text) are pretty-printed; every scalar — dates included — is shown as
 * its Postgres text, never JSON-quoted.
 */
export function displayText(value: unknown, typeName?: string | null): string {
  if (value === null || value === undefined) return '';
  if (isJsonTypeName(typeName) || (typeof value === 'object' && isPlainJson(value))) {
    if (typeof value === 'string') return prettyJsonText(value);
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }
  if (typeof value === 'string') return prettyJsonText(value);
  return cellToText(value, typeName) ?? '';
}

/** Plain objects / arrays of plain values — not Dates, buffers or bytes. */
function isPlainJson(value: object): boolean {
  if (value instanceof Date || value instanceof Uint8Array) return false;
  if (Array.isArray(value)) return false; // arrays render as Postgres array literals
  const buf = value as { type?: unknown; data?: unknown };
  if (buf.type === 'Buffer' && Array.isArray(buf.data)) return false;
  return true;
}

/** JSON stored as text: pretty-print when it parses to an object/array. */
function prettyJsonText(text: string): string {
  if (!/^\s*[[{]/.test(text)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Initial editor text for a field (Postgres text; '' for NULL). */
export function editorText(value: unknown, typeName?: string | null): string {
  const text = cellToText(value, typeName);
  if (text === null) return '';
  if (isJsonTypeName(typeName)) return prettyJsonText(text);
  return text;
}

/** Validation message for editor input, or null when it can be queued. */
export function validateFieldInput(kind: FieldEditorKind, text: string): string | null {
  if (kind !== 'json') return null;
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    return `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
}
