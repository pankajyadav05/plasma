/**
 * Presentation mode (data masking). Pure functions shared by the renderer
 * (grid, details, cell viewer, clipboard) and main (AI tool results).
 *
 * Masking is display-only: nothing here touches stored data, and callers
 * keep the raw value for edits, keys and WHERE clauses.
 */

export type SensitiveKind =
  | 'email'
  | 'phone'
  | 'ssn'
  | 'password'
  | 'secret'
  | 'card'
  | 'iban'
  | 'address'
  | 'dob'
  | 'ip'
  | 'custom';

/**
 * `initial`: first character kept (emails keep their domain), `a•••@example.com`.
 * `last4`: `•••• 4242`. `full`: `•••`.
 */
export type MaskStyle = 'initial' | 'last4' | 'full';
export const MASK_STYLES: readonly MaskStyle[] = ['initial', 'last4', 'full'];

/** Per-connection overrides keyed by lower-case column name. */
export interface MaskRules {
  /** Always masked, whatever the detectors say. */
  sensitive: string[];
  /** Never masked (the detectors were wrong about these). */
  plain: string[];
}

export const EMPTY_MASK_RULES: MaskRules = { sensitive: [], plain: [] };

export const MASK_DOT = '•';
const FULL = '•••';

// ─── Name detector ───────────────────────────────────────────────────

/** Split `userEmail`, `user_email`, `user-email` into lower-case words. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Words that mean "about a sensitive thing" rather than "the thing itself". */
const NOT_THE_VALUE = new Set([
  'count',
  'type',
  'kind',
  'status',
  'state',
  'enabled',
  'flag',
  'at',
  'on',
  'verified',
  'confirmed',
  'sent',
  'length',
  'len',
  'id',
  'ids',
  'uuid',
  'format',
  'required',
  'valid',
  'is',
  'has',
]);

const WORD_KIND: Record<string, SensitiveKind> = {
  email: 'email',
  emails: 'email',
  mail: 'email',
  phone: 'phone',
  phones: 'phone',
  mobile: 'phone',
  msisdn: 'phone',
  telephone: 'phone',
  tel: 'phone',
  ssn: 'ssn',
  nin: 'ssn',
  password: 'password',
  passwd: 'password',
  pwd: 'password',
  passcode: 'password',
  pass: 'password',
  token: 'secret',
  tokens: 'secret',
  secret: 'secret',
  secrets: 'secret',
  apikey: 'secret',
  jwt: 'secret',
  bearer: 'secret',
  credential: 'secret',
  credentials: 'secret',
  cookie: 'secret',
  salt: 'secret',
  card: 'card',
  cc: 'card',
  pan: 'card',
  cvv: 'card',
  cvc: 'card',
  iban: 'iban',
  address: 'address',
  addr: 'address',
  street: 'address',
  dob: 'dob',
  birthday: 'dob',
  birthdate: 'dob',
  ip: 'ip',
  ipv4: 'ip',
  ipv6: 'ip',
  ipaddr: 'ip',
  ipaddress: 'ip',
};

/** Longer run-together names (`useremail`, `creditcardnumber`). */
const SUBSTRING_KINDS: Array<[string, SensitiveKind]> = [
  ['email', 'email'],
  ['phone', 'phone'],
  ['password', 'password'],
  ['passwd', 'password'],
  ['secret', 'secret'],
  ['apikey', 'secret'],
  ['creditcard', 'card'],
  ['cardnumber', 'card'],
  ['socialsecurity', 'ssn'],
  ['birthdate', 'dob'],
  ['dateofbirth', 'dob'],
  ['ipaddress', 'ip'],
];

/** Which kind of sensitive data a column name suggests, or null. */
export function sensitiveKindByName(name: string): SensitiveKind | null {
  const tokens = nameTokens(name);
  if (tokens.length === 0) return null;
  const last = tokens[tokens.length - 1] as string;

  // Two-word names first: social_security, date_of_birth, api_key, private_key, credit_card.
  const joined = tokens.join(' ');
  let kind: SensitiveKind | null = null;
  if (/\bsocial security\b/.test(joined)) kind = 'ssn';
  else if (/\bdate of birth\b|\bbirth date\b/.test(joined)) kind = 'dob';
  else if (/\b(api|access|auth|private|secret|refresh) key\b/.test(joined)) kind = 'secret';
  else if (/\b(credit|debit|payment) card\b/.test(joined)) kind = 'card';
  else if (/\bip (addr|address)\b/.test(joined)) kind = 'ip';
  else if (/\bphone number\b/.test(joined)) kind = 'phone';
  if (!kind) {
    for (const t of tokens) {
      const k = WORD_KIND[t];
      if (k) {
        kind = k;
        break;
      }
    }
  }
  if (!kind && tokens.length === 1) {
    for (const [needle, k] of SUBSTRING_KINDS) {
      if (tokens[0]?.includes(needle)) {
        kind = k;
        break;
      }
    }
  }
  if (!kind) return null;
  // `email_verified`, `token_count`, `address_id`: about the thing, not the thing.
  if (tokens.length > 1 && NOT_THE_VALUE.has(last) && !WORD_KIND[last]) return null;
  if (tokens.length > 1 && (tokens[0] === 'is' || tokens[0] === 'has')) return null;
  return kind;
}

// ─── Value detectors ─────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SSN_RE = /^\d{3}-\d{2}-\d{4}$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i;
const PHONE_RE = /^\+?[\d\s().-]{7,24}$/;

export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function isEmailValue(v: string): boolean {
  return v.length <= 254 && EMAIL_RE.test(v.trim());
}

export function isCardValue(v: string): boolean {
  const t = v.trim();
  if (!/^[\d\s-]{13,23}$/.test(t)) return false;
  return luhnValid(t.replace(/[\s-]/g, ''));
}

export function isIpValue(v: string): boolean {
  const t = v.trim();
  const m = IPV4_RE.exec(t);
  if (m) return m.slice(1).every((o) => Number(o) <= 255);
  return t.includes(':') && IPV6_RE.test(t);
}

export function isPhoneValue(v: string): boolean {
  const t = v.trim();
  if (!PHONE_RE.test(t)) return false;
  const digits = t.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  // Bare digit runs are far more often ids/counters than phones.
  if (/^\d+$/.test(t)) return false;
  // Dates (2024-05-01) and times are not phones.
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return false;
  return t.startsWith('+') || /[\s().-]/.test(t);
}

export function isSsnValue(v: string): boolean {
  return SSN_RE.test(v.trim());
}

/** Classify one value, or null. Order matters: the most specific first. */
export function sensitiveKindByValue(v: string): SensitiveKind | null {
  if (v.length === 0 || v.length > 254) return null;
  if (isEmailValue(v)) return 'email';
  if (isSsnValue(v)) return 'ssn';
  if (isIpValue(v)) return 'ip';
  if (isCardValue(v)) return 'card';
  if (isPhoneValue(v)) return 'phone';
  return null;
}

/** Sample size and agreement needed for a value-based verdict. */
export const SAMPLE_ROWS = 25;
export const SAMPLE_AGREEMENT = 0.6;

/** Column kind by sampled values: the kind most non-null samples agree on. */
export function sensitiveKindBySamples(
  samples: ReadonlyArray<string | null | undefined>,
): SensitiveKind | null {
  const counts = new Map<SensitiveKind, number>();
  let nonNull = 0;
  for (const s of samples) {
    if (typeof s !== 'string' || s === '') continue;
    nonNull++;
    const k = sensitiveKindByValue(s);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (nonNull === 0) return null;
  let best: SensitiveKind | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best && bestN / nonNull >= SAMPLE_AGREEMENT ? best : null;
}

// ─── Column resolution ───────────────────────────────────────────────

export interface MaskColumn {
  name: string;
  dataTypeName?: string | null;
}

export type MaskReason = 'rule' | 'name' | 'values';

export interface ColumnMask {
  kind: SensitiveKind;
  reason: MaskReason;
}

const NON_TEXT_TYPES = new Set([
  'int2',
  'int4',
  'int8',
  'smallint',
  'integer',
  'bigint',
  'float4',
  'float8',
  'real',
  'numeric',
  'decimal',
  'double precision',
  'bool',
  'boolean',
  'date',
  'timestamp',
  'timestamptz',
  'time',
  'timetz',
  'bytea',
  'uuid',
  'oid',
]);

/** Number/date/bool columns are never value-sniffed (ids look like phones). */
function valueSniffable(typeName: string | null | undefined): boolean {
  if (!typeName) return true;
  return !NON_TEXT_TYPES.has(typeName.toLowerCase());
}

export function normaliseColumnKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Decide which result columns are sensitive. `getSample(col)` returns the
 * display text of the first rows of that column (only called when the name
 * alone is inconclusive). Rules win over detectors; `plain` beats everything.
 */
export function resolveMaskedColumns(
  columns: ReadonlyArray<MaskColumn>,
  getSample: (col: number) => ReadonlyArray<string | null | undefined>,
  rules: MaskRules = EMPTY_MASK_RULES,
): Map<number, ColumnMask> {
  const sensitive = new Set(rules.sensitive.map(normaliseColumnKey));
  const plain = new Set(rules.plain.map(normaliseColumnKey));
  const out = new Map<number, ColumnMask>();
  columns.forEach((c, i) => {
    const key = normaliseColumnKey(c.name);
    if (plain.has(key)) return;
    if (sensitive.has(key)) {
      out.set(i, { kind: sensitiveKindByName(c.name) ?? 'custom', reason: 'rule' });
      return;
    }
    const byName = sensitiveKindByName(c.name);
    if (byName) {
      out.set(i, { kind: byName, reason: 'name' });
      return;
    }
    if (!valueSniffable(c.dataTypeName)) return;
    const byValues = sensitiveKindBySamples(getSample(i));
    if (byValues) out.set(i, { kind: byValues, reason: 'values' });
  });
  return out;
}

/** Add `name` to the always-mask list (and out of the never-mask list). */
export function withSensitiveColumn(rules: MaskRules, name: string): MaskRules {
  const key = normaliseColumnKey(name);
  return {
    sensitive: rules.sensitive.some((n) => normaliseColumnKey(n) === key)
      ? rules.sensitive
      : [...rules.sensitive, key],
    plain: rules.plain.filter((n) => normaliseColumnKey(n) !== key),
  };
}

/** Add `name` to the never-mask list (and out of the always-mask list). */
export function withPlainColumn(rules: MaskRules, name: string): MaskRules {
  const key = normaliseColumnKey(name);
  return {
    sensitive: rules.sensitive.filter((n) => normaliseColumnKey(n) !== key),
    plain: rules.plain.some((n) => normaliseColumnKey(n) === key)
      ? rules.plain
      : [...rules.plain, key],
  };
}

/** Drop any rule for `name`, back to automatic detection. */
export function withoutColumnRule(rules: MaskRules, name: string): MaskRules {
  const key = normaliseColumnKey(name);
  return {
    sensitive: rules.sensitive.filter((n) => normaliseColumnKey(n) !== key),
    plain: rules.plain.filter((n) => normaliseColumnKey(n) !== key),
  };
}

// ─── Maskers ─────────────────────────────────────────────────────────

/** Kinds whose value is a credential: only ever fully masked. */
const ALWAYS_FULL = new Set<SensitiveKind>(['password', 'secret']);

function lastChars(s: string, n: number): string {
  const alnum = s.replace(/[^A-Za-z0-9]/g, '');
  return alnum.slice(-n);
}

function maskEmail(v: string, style: MaskStyle): string {
  const at = v.lastIndexOf('@');
  if (at < 1) return FULL;
  if (style === 'initial') return `${v.slice(0, 1)}${FULL}${v.slice(at)}`;
  return `${FULL}${v.slice(at)}`;
}

function maskIp(v: string, style: MaskStyle): string {
  if (style === 'full') return FULL;
  const t = v.trim();
  if (IPV4_RE.test(t)) {
    const parts = t.split('.');
    return `${FULL}.${FULL}.${FULL}.${parts[3]}`;
  }
  const tail = t.split(':').pop() ?? '';
  return `${FULL}:${tail}`;
}

/**
 * Mask one value. `null`/`undefined`/`''` stay as they are (NULL is not
 * sensitive and masking it would hide that a value is missing).
 */
export function maskValue(
  value: string | null | undefined,
  kind: SensitiveKind,
  style: MaskStyle = 'initial',
): string | null | undefined {
  if (value === null || value === undefined || value === '') return value;
  if (ALWAYS_FULL.has(kind) || style === 'full') return FULL;
  if (kind === 'email' || (kind === 'custom' && isEmailValue(value)))
    return maskEmail(value, style);
  if (kind === 'ip') return maskIp(value, style);
  if (style === 'last4') {
    const tail = lastChars(value, 4);
    return tail.length >= 4 && value.length >= 6 ? `${MASK_DOT.repeat(4)} ${tail}` : FULL;
  }
  // initial
  const first = value.trim().slice(0, 1);
  if (kind === 'card' || kind === 'iban' || kind === 'phone' || kind === 'ssn') {
    const tail = lastChars(value, 4);
    return tail.length >= 4 && value.length >= 6 ? `${MASK_DOT.repeat(4)} ${tail}` : FULL;
  }
  return first ? `${first}${FULL}` : FULL;
}

/** True when `text` is exactly something `maskValue` produced. */
export function looksMasked(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(MASK_DOT);
}

/**
 * Mask a whole result for export to a third party (AI tool results,
 * clipboard). Returns copies; the input rows are untouched.
 */
export function maskResultRows(
  columns: ReadonlyArray<MaskColumn>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  opts: { rules?: MaskRules; style?: MaskStyle } = {},
): unknown[][] {
  const style = opts.style ?? 'initial';
  const textOf = (v: unknown): string | null =>
    v === null || v === undefined ? null : typeof v === 'string' ? v : String(v);
  const masks = resolveMaskedColumns(
    columns,
    (col) => rows.slice(0, SAMPLE_ROWS).map((r) => textOf(r[col])),
    opts.rules,
  );
  if (masks.size === 0) return rows.map((r) => [...r]);
  return rows.map((r) =>
    r.map((v, i) => {
      const m = masks.get(i);
      if (!m || v === null || v === undefined) return v;
      return maskValue(textOf(v), m.kind, style);
    }),
  );
}
