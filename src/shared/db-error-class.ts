/**
 * A database error as a value-free reason. Driver messages can quote row
 * values (`Duplicate entry 'alice@corp.com'`, a trigger's RAISE text), so
 * without the row-data opt-in the model only gets a category and, where known,
 * the SQLSTATE, never the driver's own text.
 */

const RULES: Array<{ re: RegExp; code: string; label: string }> = [
  {
    re: /duplicate (key|entry)|unique (constraint|violation)|already exists.*key/i,
    code: '23505',
    label: 'duplicate key',
  },
  { re: /foreign key/i, code: '23503', label: 'foreign key violation' },
  {
    re: /not[- ]null|null value in column|cannot be null|may not be null/i,
    code: '23502',
    label: 'not-null violation',
  },
  { re: /check constraint|violates check/i, code: '23514', label: 'check constraint violation' },
  {
    re: /permission denied|access denied|not authorized|insufficient privilege/i,
    code: '42501',
    label: 'permission denied',
  },
  { re: /read[- ]only/i, code: '25006', label: 'the connection or transaction is read-only' },
  {
    re: /syntax error|parse error|mismatched input|unexpected token/i,
    code: '42601',
    label: 'syntax error',
  },
  {
    re: /(relation|table|view)\b.*does not exist|no such table|doesn'?t exist.*table|unknown table/i,
    code: '42P01',
    label: 'table does not exist',
  },
  {
    re: /column\b.*does not exist|no such column|unknown column/i,
    code: '42703',
    label: 'column does not exist',
  },
  {
    re: /does not exist|no such|unknown (function|identifier)/i,
    code: '42883',
    label: 'object does not exist',
  },
  {
    re: /invalid input|out of range|invalid (value|syntax for type)|cannot cast|conversion failed|data truncat/i,
    code: '22P02',
    label: 'invalid value',
  },
  { re: /division by zero/i, code: '22012', label: 'division by zero' },
  { re: /deadlock/i, code: '40P01', label: 'deadlock' },
  {
    re: /timeout|timed out|canceling statement|cancelled|canceled|interrupted/i,
    code: '57014',
    label: 'the statement timed out or was cancelled',
  },
  { re: /safe run is waiting|safe run/i, code: '', label: 'another Safe Run is waiting' },
  {
    re: /connection (changed|lost|closed|terminated)|connect(ion)? (refused|reset)/i,
    code: '08006',
    label: 'connection problem',
  },
];

/** `SQLSTATE 23505`, `code: 42P01` and similar spellings, when the text carries one. */
const EXPLICIT_CODE = /\b(?:sqlstate|sql state|code)[\s:=]+['"(]?([0-9A-Z]{5})\b/i;

/** "duplicate key (23505)", or a generic line. Never contains any of `message`. */
export function describeDbErrorSafely(message: string): string {
  const explicit = EXPLICIT_CODE.exec(message)?.[1]?.toUpperCase();
  for (const rule of RULES) {
    if (!rule.re.test(message)) continue;
    const code = explicit ?? rule.code;
    return code ? `${rule.label} (${code})` : rule.label;
  }
  return explicit ? `the statement failed (${explicit})` : 'the statement failed';
}
