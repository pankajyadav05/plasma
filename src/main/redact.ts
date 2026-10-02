/**
 * Credential / row-value redaction for anything that is persisted in
 * plaintext: query history (SQL and error text) and the main log (C34,
 * SC-27). Pure string functions, no Electron imports.
 */

/** A single-quoted SQL string, with `''` escapes. */
const PLAIN_STRING = "'(?:[^']|'')*'";
/** E'...' string: backslash escapes allowed (E'it\'s'). */
const ESCAPE_STRING = "[eE]'(?:[^'\\\\]|\\\\[\\s\\S]|'')*'";
/** $$...$$ or $tag$...$tag$. */
// (the tag is capture group 3 of PASSWORD_LITERAL below)
const DOLLAR_STRING = '\\$([A-Za-z_]\\w*)?\\$[\\s\\S]*?\\$\\3\\$';

const PASSWORD_LITERAL = new RegExp(
  `(\\bpassword\\s+)(${ESCAPE_STRING}|${PLAIN_STRING}|${DOLLAR_STRING})`,
  'gi',
);
/** libpq-style `password=value` and `password='quoted value'`. */
const PASSWORD_KV = /(\bpassword=)('(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.)*"|[^\s'";]+)/gi;

/**
 * Mask credentials before SQL is written to query history: `PASSWORD '…'`
 * (plain, E'…' and dollar-quoted, tagged or not) in CREATE/ALTER ROLE|USER
 * and `password=…` inside connection strings (dblink, postgres_fdw user
 * mappings, subscriptions).
 */
export function redactSqlSecrets(sql: string): string {
  return sql.replace(PASSWORD_LITERAL, "$1'***'").replace(PASSWORD_KV, '$1***');
}

/**
 * Error text can echo data: Postgres puts offending values in messages
 * (`invalid input syntax for type integer: "abc"`) and details (`Key
 * (email)=(a@b.com) already exists`, `Failing row contains (...)`), and
 * quotes the failing SQL. Keep the shape, drop the values.
 */
export function redactErrorText(text: string): string {
  return redactSqlSecrets(text)
    .replace(/(invalid input (?:syntax|value) for [^:\n]+: )"(?:[^"]|"")*"/gi, '$1"***"')
    .replace(/(Key \([^)\n]*\)=)\([^\n]*?\)(?= (?:already|is not|is still)|\.|$)/g, '$1(***)')
    .replace(/(Failing row contains )\([^\n]*\)/g, '$1(***)');
}

/** Redact one log argument; non-strings and Errors are handled by message. */
export function redactLogValue(value: unknown): unknown {
  if (typeof value === 'string') return redactErrorText(value);
  if (value instanceof Error) {
    value.message = redactErrorText(value.message);
    return value;
  }
  return value;
}
