/**
 * OpenSearch create-index spec — single-source model the dialog edits.
 *
 * The dialog has two synchronised views: a structured form and a raw
 * JSON editor. Both edit the same `IndexSpec`. Round-tripping through
 * `parseJson(toJson(spec))` MUST be lossless, including for fields the
 * form can't render (custom analyzers, multi-fields beyond `.keyword`,
 * dynamic_templates, etc.). Anything the form doesn't understand is
 * preserved in `field.raw` (per-field) or `unknownTop` (top-level keys
 * beyond `settings` / `mappings` / `aliases`).
 */

export const SUPPORTED_FIELD_TYPES = [
  'keyword',
  'text',
  'long',
  'integer',
  'short',
  'byte',
  'double',
  'float',
  'half_float',
  'scaled_float',
  'boolean',
  'date',
  'date_nanos',
  'ip',
  'geo_point',
  'object',
  'binary',
] as const;

export type SupportedFieldType = (typeof SUPPORTED_FIELD_TYPES)[number];

export interface FieldSpec {
  name: string;
  type: SupportedFieldType | 'unknown';
  /** True when the field has a `.keyword` sub-field of type keyword. */
  keywordSubfield: boolean;
  /**
   * Original JSON node for this field. Set when the field has options
   * the form can't represent (analyzers, fields beyond `.keyword`,
   * properties, copy_to, runtime, etc.). When `advanced` is true the
   * form locks the row and round-trip uses this raw node verbatim.
   */
  raw?: Record<string, unknown>;
  /** Form mode locks fields with structure beyond `{type, fields:{keyword}}`. */
  advanced: boolean;
}

export interface IndexSpec {
  name: string;
  shards: number;
  replicas: number;
  fields: FieldSpec[];
  /**
   * Top-level keys other than `settings` / `mappings` / `aliases`,
   * preserved verbatim. Surfaces as a banner in the form view.
   */
  unknownTop: Record<string, unknown>;
  /**
   * Settings nodes other than `number_of_shards` / `number_of_replicas`
   * (e.g. `analysis`, `refresh_interval`). Preserved verbatim.
   */
  unknownSettings: Record<string, unknown>;
  /**
   * Mappings nodes other than `properties` (e.g. `dynamic_templates`,
   * `_source`, `runtime`). Preserved verbatim.
   */
  unknownMappings: Record<string, unknown>;
  /** Top-level `aliases` block, preserved verbatim. */
  aliases?: Record<string, unknown>;
}

export const DEFAULT_SPEC: IndexSpec = {
  name: '',
  shards: 1,
  replicas: 1,
  fields: [],
  unknownTop: {},
  unknownSettings: {},
  unknownMappings: {},
};

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Validate an index name per OpenSearch rules.
 * https://opensearch.org/docs/latest/api-reference/index-apis/create-index/
 */
export function validateIndexName(name: string): string | null {
  if (!name) return 'name required';
  if (name.length > 255) return 'must be 255 characters or fewer';
  if (name === '.' || name === '..') return 'cannot be . or ..';
  if (name.startsWith('_') || name.startsWith('-') || name.startsWith('+')) {
    return 'cannot start with _, -, or +';
  }
  if (name !== name.toLowerCase()) return 'must be lowercase';
  if (!NAME_RE.test(name)) {
    return 'only a-z, 0-9, . _ -';
  }
  return null;
}

export function validateFieldName(name: string): string | null {
  if (!name) return 'name required';
  if (/^\s|\s$/.test(name)) return 'no leading/trailing whitespace';
  if (name.includes('"')) return 'no quote chars';
  return null;
}

/**
 * Top-level keys we know how to render in form mode. Anything else lands
 * in `unknownTop` and surfaces as a banner.
 */
const KNOWN_TOP_KEYS = new Set(['settings', 'mappings', 'aliases']);

/** Is the field node a plain `{type: ...}` (or `{type, fields: {keyword: {type: keyword}}}`)? */
function isFormCompatibleFieldNode(node: Record<string, unknown>): boolean {
  const keys = Object.keys(node);
  if (keys.length === 0) return false;
  // type may be missing on legacy `object` nodes — accept properties-only
  if (keys.includes('properties')) return false;
  for (const k of keys) {
    if (k === 'type') continue;
    if (k === 'fields') {
      const sub = node.fields;
      if (
        !sub ||
        typeof sub !== 'object' ||
        Array.isArray(sub) ||
        Object.keys(sub).length !== 1 ||
        !('keyword' in sub)
      ) {
        return false;
      }
      const kw = (sub as Record<string, unknown>).keyword;
      if (
        !kw ||
        typeof kw !== 'object' ||
        Array.isArray(kw) ||
        Object.keys(kw as object).length !== 1 ||
        (kw as { type?: string }).type !== 'keyword'
      ) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

export interface ParseResult {
  spec: IndexSpec;
  /** Soft warnings — preserved features the form can't edit. */
  notes: string[];
}

export interface ParseError {
  message: string;
  /** Position into the source string when JSON.parse threw with one. */
  line?: number;
}

/**
 * Parse a raw create-index body into an `IndexSpec`. Throws `ParseError`
 * on malformed JSON. The spec keeps every input feature — anything the
 * form can't represent ends up in `raw` / `unknownTop` / `unknownSettings`
 * / `unknownMappings` so `toJson(spec)` round-trips.
 *
 * `name` defaults to the current spec's `name` since the create-index
 * payload doesn't include the index name.
 */
export function parseJson(text: string, currentName = ''): ParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw { message: msg } as ParseError;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw { message: 'expected an object' } as ParseError;
  }

  const root = doc as Record<string, unknown>;
  const notes: string[] = [];

  // ── settings ──
  let shards = 1;
  let replicas = 1;
  const unknownSettings: Record<string, unknown> = {};
  const settings = root.settings;
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    // OpenSearch accepts both flattened ("index.number_of_shards") and
    // nested ("index": {"number_of_shards": ...}). Normalise.
    const sObj = settings as Record<string, unknown>;
    const nested =
      sObj.index && typeof sObj.index === 'object' && !Array.isArray(sObj.index)
        ? (sObj.index as Record<string, unknown>)
        : undefined;
    const lookup = (k: string) =>
      nested && k in nested ? nested[k] : (sObj[`index.${k}`] ?? sObj[k]);
    const ns = lookup('number_of_shards');
    const nr = lookup('number_of_replicas');
    if (typeof ns === 'number') shards = ns;
    else if (typeof ns === 'string' && /^\d+$/.test(ns)) shards = Number(ns);
    if (typeof nr === 'number') replicas = nr;
    else if (typeof nr === 'string' && /^\d+$/.test(nr)) replicas = Number(nr);

    // Anything else under settings goes to unknownSettings verbatim.
    for (const [k, v] of Object.entries(sObj)) {
      if (
        k === 'number_of_shards' ||
        k === 'number_of_replicas' ||
        k === 'index.number_of_shards' ||
        k === 'index.number_of_replicas'
      ) {
        continue;
      }
      if (k === 'index' && nested) {
        const filteredIndex: Record<string, unknown> = {};
        for (const [ik, iv] of Object.entries(nested)) {
          if (ik === 'number_of_shards' || ik === 'number_of_replicas') continue;
          filteredIndex[ik] = iv;
        }
        if (Object.keys(filteredIndex).length > 0) {
          unknownSettings.index = filteredIndex;
        }
        continue;
      }
      unknownSettings[k] = v;
    }
    if (Object.keys(unknownSettings).length > 0) {
      notes.push(
        `${Object.keys(unknownSettings).length} advanced setting(s) preserved (edit in JSON tab)`,
      );
    }
  }

  // ── mappings ──
  const fields: FieldSpec[] = [];
  const unknownMappings: Record<string, unknown> = {};
  const mappings = root.mappings;
  if (mappings && typeof mappings === 'object' && !Array.isArray(mappings)) {
    const mObj = mappings as Record<string, unknown>;
    const props = mObj.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          fields.push({
            name,
            type: 'unknown',
            keywordSubfield: false,
            raw: raw as Record<string, unknown>,
            advanced: true,
          });
          continue;
        }
        const node = raw as Record<string, unknown>;
        const compatible = isFormCompatibleFieldNode(node);
        const t = typeof node.type === 'string' ? (node.type as string) : '';
        const supported = (SUPPORTED_FIELD_TYPES as readonly string[]).includes(t)
          ? (t as SupportedFieldType)
          : null;
        if (compatible && supported) {
          const keywordSub =
            node.fields !== undefined &&
            typeof node.fields === 'object' &&
            (node.fields as Record<string, unknown>).keyword !== undefined;
          fields.push({
            name,
            type: supported,
            keywordSubfield: keywordSub,
            advanced: false,
          });
        } else {
          fields.push({
            name,
            type: supported ?? 'unknown',
            keywordSubfield: false,
            raw: node,
            advanced: true,
          });
        }
      }
    }
    for (const [k, v] of Object.entries(mObj)) {
      if (k === 'properties') continue;
      unknownMappings[k] = v;
    }
    const advCount = fields.filter((f) => f.advanced).length;
    if (advCount > 0) {
      notes.push(`${advCount} field(s) have advanced options (locked in form, edit in JSON tab)`);
    }
    if (Object.keys(unknownMappings).length > 0) {
      notes.push(
        `${Object.keys(unknownMappings).length} mapping section(s) preserved (edit in JSON tab)`,
      );
    }
  }

  // ── unknown top ──
  const unknownTop: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(root)) {
    if (KNOWN_TOP_KEYS.has(k)) continue;
    unknownTop[k] = v;
  }
  if (Object.keys(unknownTop).length > 0) {
    notes.push(
      `${Object.keys(unknownTop).length} top-level key(s) preserved: ${Object.keys(unknownTop).join(', ')}`,
    );
  }

  // ── aliases ──
  const aliases =
    root.aliases && typeof root.aliases === 'object' && !Array.isArray(root.aliases)
      ? (root.aliases as Record<string, unknown>)
      : undefined;

  return {
    spec: {
      name: currentName,
      shards,
      replicas,
      fields,
      unknownTop,
      unknownSettings,
      unknownMappings,
      aliases,
    },
    notes,
  };
}

/**
 * Serialise an `IndexSpec` to a canonical JSON create-index body. Form
 * fields render to `{type}` (with `fields.keyword` when requested);
 * advanced fields use their preserved `raw` node verbatim. Round-trips:
 *   parseJson(toJson(s)).spec deep-equals s (modulo formatting).
 */
export function toJson(spec: IndexSpec): string {
  return JSON.stringify(toBody(spec), null, 2);
}

export function toBody(spec: IndexSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  // settings
  const settings: Record<string, unknown> = {
    number_of_shards: spec.shards,
    number_of_replicas: spec.replicas,
  };
  for (const [k, v] of Object.entries(spec.unknownSettings)) settings[k] = v;
  body.settings = settings;

  // mappings
  const properties: Record<string, unknown> = {};
  for (const f of spec.fields) {
    if (f.advanced && f.raw) {
      properties[f.name] = f.raw;
      continue;
    }
    if (f.type === 'unknown') {
      // No raw node and no known type — emit a stub so the user notices.
      properties[f.name] = f.raw ?? {};
      continue;
    }
    const node: Record<string, unknown> = { type: f.type };
    if (f.keywordSubfield) {
      node.fields = { keyword: { type: 'keyword' } };
    }
    properties[f.name] = node;
  }
  const mappings: Record<string, unknown> = {};
  if (Object.keys(properties).length > 0) mappings.properties = properties;
  for (const [k, v] of Object.entries(spec.unknownMappings)) mappings[k] = v;
  if (Object.keys(mappings).length > 0) body.mappings = mappings;

  if (spec.aliases) body.aliases = spec.aliases;
  for (const [k, v] of Object.entries(spec.unknownTop)) body[k] = v;
  return body;
}
