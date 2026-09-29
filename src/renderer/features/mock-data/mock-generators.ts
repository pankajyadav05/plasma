/**
 * Pure value generators for the mock-data dialog. No `faker` dep — the
 * built-ins cover text / numeric / timestamp / uuid / boolean / json.
 *
 * Length-aware: `char(n)` / `varchar(n)` / `character varying(n)` columns
 * (as rendered by Postgres `format_type`) never receive a string longer
 * than `n`, and short columns default to a generator that fits (2-letter
 * country codes for `char(2)`, random letters for other tiny widths).
 */
export type GenKind =
  | 'auto'
  | 'name-first'
  | 'name-last'
  | 'name-full'
  | 'email'
  | 'url'
  | 'lorem'
  | 'word'
  | 'country'
  | 'letters'
  | 'int'
  | 'numeric'
  | 'bool'
  | 'timestamp'
  | 'date'
  | 'uuid'
  | 'json'
  | 'fixed'
  | 'null';

export const GENERATOR_CHOICES: GenKind[] = [
  'auto',
  'name-first',
  'name-last',
  'name-full',
  'email',
  'url',
  'lorem',
  'word',
  'country',
  'letters',
  'int',
  'numeric',
  'bool',
  'timestamp',
  'date',
  'uuid',
  'json',
  'fixed',
  'null',
];

export interface GenColumn {
  name: string;
  dataType: string;
  kind: GenKind;
  fixedValue: string;
}

const CHAR_TYPE_RE =
  /^\s*(?:character varying|varchar|character|char|bpchar|nchar|nvarchar)\s*\(\s*(\d+)\s*\)/i;

/**
 * Max character length for a fixed/variable-width string type, or
 * `undefined` when unbounded / not a character type. Array types
 * (`character(2)[]`) are treated as unbounded.
 */
export function charLength(dataType: string): number | undefined {
  if (/\[\]\s*$/.test(dataType)) return undefined;
  const m = CHAR_TYPE_RE.exec(dataType);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function nameKind(n: string): GenKind | undefined {
  if (n === 'email' || n.endsWith('_email')) return 'email';
  if (n.endsWith('_url') || n === 'url') return 'url';
  if (n === 'first_name' || n === 'firstname' || n === 'given_name') return 'name-first';
  if (n === 'last_name' || n === 'lastname' || n === 'family_name' || n === 'surname')
    return 'name-last';
  if (n === 'name' || n === 'full_name' || n === 'fullname') return 'name-full';
  if (n === 'country' || n === 'country_code' || n.endsWith('_country')) return 'country';
  return undefined;
}

export function defaultKind(col: { name: string; dataType: string }): GenKind {
  const t = col.dataType.toLowerCase();
  const n = col.name.toLowerCase();
  const len = charLength(t);
  if (len !== undefined) {
    // Tiny widths: pick something that fits instead of truncating prose.
    if (len === 2) return 'country';
    if (len < 5) return 'letters';
    const byName = nameKind(n);
    if (byName) return byName;
    return len < 30 ? 'word' : 'lorem';
  }
  if (t.includes('uuid')) return 'uuid';
  if (t.includes('json')) return 'json';
  if (t.includes('timestamp')) return 'timestamp';
  if (t.includes('date')) return 'date';
  if (t === 'boolean' || t === 'bool') return 'bool';
  if (t.includes('int')) return 'int';
  if (t.includes('numeric') || t.includes('float') || t.includes('double') || t.includes('real'))
    return 'numeric';
  const byName = nameKind(n);
  if (byName && byName !== 'country') return byName;
  if (n.endsWith('_at') || n.endsWith('_time')) return 'timestamp';
  return 'lorem';
}

const FIRST_NAMES = [
  'Ada',
  'Linus',
  'Grace',
  'Alan',
  'Margaret',
  'Donald',
  'Edsger',
  'Barbara',
  'Tony',
  'Niklaus',
  'John',
  'Karen',
  'Brian',
  'Anita',
  'Dennis',
  'Vint',
  'Radia',
  'Frances',
  'Tim',
  'Sandi',
];
const LAST_NAMES = [
  'Lovelace',
  'Torvalds',
  'Hopper',
  'Turing',
  'Hamilton',
  'Knuth',
  'Dijkstra',
  'Liskov',
  'Hoare',
  'Wirth',
  'Carmack',
  'Sandberg',
  'Kernighan',
  'Borg',
  'Ritchie',
  'Cerf',
  'Perlman',
  'Allen',
  'Berners-Lee',
  'Metz',
];
const WORDS = [
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'sed',
  'tempor',
  'incididunt',
  'ut',
  'labore',
  'magna',
  'aliqua',
];
export const COUNTRY_CODES = [
  'US',
  'GB',
  'DE',
  'FR',
  'IN',
  'JP',
  'BR',
  'CA',
  'AU',
  'NL',
  'SE',
  'ES',
  'IT',
  'MX',
  'SG',
];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export type Rng = () => number;

function pick<T>(xs: readonly T[], rng: Rng): T {
  return xs[Math.floor(rng() * xs.length)];
}

function randInt(lo: number, hi: number, rng: Rng): number {
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

function letters(len: number, rng: Rng): string {
  let s = '';
  for (let i = 0; i < len; i++) s += LETTERS[Math.floor(rng() * LETTERS.length)];
  return s;
}

/** Trim a generated string to at most `max` characters (no dangling space). */
export function fitLength(value: string, max: number | undefined): string {
  if (max === undefined || value.length <= max) return value;
  return value.slice(0, max).trimEnd() || value.slice(0, max);
}

function uuid(idx: number, rng: Rng): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${randInt(1, 1e9, rng)}-${idx}`;
}

/**
 * Returns the value to bind for this column.
 *  - `undefined` → emit `DEFAULT` (skip the param)
 *  - `null` → emit `NULL` literal
 *  - any other value is bound via `$N` to keep the SQL injection-free
 *
 * Fixed values are passed through verbatim — if they overflow the column
 * Postgres reports it rather than us silently altering user input.
 */
export function generate(col: GenColumn, idx: number, rng: Rng = Math.random): unknown {
  if (col.kind === 'null') return null;
  if (col.kind === 'fixed') return col.fixedValue;
  const kind = col.kind === 'auto' ? defaultKind(col) : col.kind;
  const max = charLength(col.dataType);
  const value = rawValue(kind, idx, max, rng);
  return typeof value === 'string' ? fitLength(value, max) : value;
}

function rawValue(kind: GenKind, idx: number, max: number | undefined, rng: Rng): unknown {
  switch (kind) {
    case 'name-first':
      return pick(FIRST_NAMES, rng);
    case 'name-last':
      return pick(LAST_NAMES, rng);
    case 'name-full':
      return `${pick(FIRST_NAMES, rng)} ${pick(LAST_NAMES, rng)}`;
    case 'email':
      return `${pick(FIRST_NAMES, rng).toLowerCase()}.${idx}@example.com`;
    case 'url':
      return `https://example.com/${randInt(1000, 9999, rng)}`;
    case 'lorem':
      return Array.from({ length: randInt(3, 8, rng) }, () => pick(WORDS, rng)).join(' ');
    case 'word': {
      if (max !== undefined) {
        const fits = WORDS.filter((w) => w.length <= max);
        if (fits.length > 0) return pick(fits, rng);
        return letters(max, rng);
      }
      return pick(WORDS, rng);
    }
    case 'country':
      return max !== undefined && max < 2 ? letters(max, rng) : pick(COUNTRY_CODES, rng);
    case 'letters':
      return letters(Math.min(max ?? 8, 8), rng);
    case 'int':
      return randInt(0, 10000, rng);
    case 'numeric':
      return Math.round(rng() * 10000) / 100;
    case 'bool':
      return rng() < 0.5;
    case 'timestamp': {
      const d = new Date(Date.now() - randInt(0, 365 * 24 * 3600 * 1000, rng));
      return d.toISOString();
    }
    case 'date': {
      const d = new Date(Date.now() - randInt(0, 365 * 24 * 3600 * 1000, rng));
      return d.toISOString().slice(0, 10);
    }
    case 'uuid':
      return uuid(idx, rng);
    case 'json':
      return JSON.stringify({ idx, sample: pick(WORDS, rng) });
    default:
      return pick(WORDS, rng);
  }
}
