/**
 * Secret redaction for text that leaves a trust boundary: an error shown next
 * to a connection, a log line put in a support bundle, a settings dump.
 * Pure string functions, no Electron imports.
 *
 * It removes what is recognisably a credential, whatever it is attached to:
 * passwords in URLs and `password=` pairs, private keys, cloud and API keys,
 * bearer / basic tokens and any secret the caller knows by value. It does not
 * try to be clever about data: it is not a PII scrubber (see `redact.ts` in
 * main for SQL text and row values).
 *
 * The rule when in doubt is to remove: a redacted line is an annoyance, a
 * leaked key is an incident.
 */

export const REDACTED = '***';
export const REDACTED_KEY = '[private key removed]';
export const REDACTED_TOKEN = '[token removed]';

/** Names that mean "the value next to me is a secret". */
const SECRET_NAME =
  '(?:[a-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|authorization)[a-z0-9_.-]*)';

/** `-----BEGIN … PRIVATE KEY-----` up to its END line (or the end of the text when cut off). */
const PEM_PRIVATE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

/** `scheme://user:password@host`: the password is everything between the first `:` and the last `@`. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*)@/gi;

/** `Authorization: Bearer abc`, `Authorization: Basic abc`, a bare `Bearer abc`. */
const AUTH_HEADER =
  /\b(authorization\s*[:=]\s*)(?:(bearer|basic|token|digest|negotiate)\s+)?[^\s,;"']+/gi;
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** `"password": "x"`, `password=x`, `Password = 'x y'`, `SECRET_KEY: abc` (also with the name quoted). */
const KEY_VALUE = new RegExp(
  `(["']?)(${SECRET_NAME})(["']?)(\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,;&)\\]}]+)`,
  'gi',
);

/** `CREATE ROLE x PASSWORD 'abc'`, `ALTER USER x IDENTIFIED BY 'abc'`. */
const SQL_PASSWORD = /\b(password|passphrase|identified\s+by)\s+(?:[eE])?'(?:[^']|'')*'/gi;

const TOKEN_SHAPES: Array<[RegExp, string]> = [
  // AWS access key ids (the secret half travels next to a name KEY_VALUE catches).
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g, '[aws key removed]'],
  // OpenRouter, Anthropic and OpenAI style keys.
  [/\bsk-or-[A-Za-z0-9_-]{8,}/g, '[api key removed]'],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[api key removed]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[api key removed]'],
  // GitHub, Slack, Google.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[token removed]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[token removed]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[token removed]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[api key removed]'],
  // JSON web tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[jwt removed]'],
];

/** A secret the caller knows, in the forms it may appear in text. */
function variantsOf(secret: string): string[] {
  const forms = new Set<string>([secret]);
  try {
    forms.add(encodeURIComponent(secret));
  } catch {
    // lone surrogate: not encodable, the plain form still goes
  }
  forms.add(JSON.stringify(secret).slice(1, -1));
  forms.add(secret.replace(/'/g, "''"));
  return [...forms].filter((f) => f.length >= 1);
}

/** Secrets shorter than this are only removed where a name or a URL marks them as one. */
const MIN_BARE_SECRET = 4;

function replaceAll(text: string, needle: string, with_: string): string {
  return needle ? text.split(needle).join(with_) : text;
}

/**
 * Remove credentials from `text`. `secrets` are values the caller knows are
 * secret (the connection's password, an SSH passphrase, an API key): every
 * occurrence goes, in plain, URL-encoded and JSON-escaped form.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  if (!text) return text;
  let out = text;

  out = out.replace(PEM_PRIVATE, REDACTED_KEY);

  out = out.replace(URL_USERINFO, (_m, scheme: string, userinfo: string) => {
    const colon = userinfo.indexOf(':');
    // `user@host` has no password to remove.
    if (colon === -1) return `${scheme}${userinfo}@`;
    return `${scheme}${userinfo.slice(0, colon)}:${REDACTED}@`;
  });

  out = out.replace(AUTH_HEADER, (_m, head: string, kind: string | undefined) =>
    kind ? `${head}${kind} ${REDACTED}` : `${head}${REDACTED}`,
  );
  out = out.replace(BEARER, (_m, kind: string) => `${kind} ${REDACTED}`);

  out = out.replace(SQL_PASSWORD, (_m, kw: string) => `${kw} '${REDACTED}'`);

  out = out.replace(
    KEY_VALUE,
    (m, q1: string, name: string, q2: string, sep: string, value: string) => {
      // MySQL's "(using password: YES)" says whether one was sent, not what it was.
      if (/^(?:yes|no)$/i.test(value)) return m;
      // So do flags and the markers other redaction passes leave ("hasApiKey": true, "[set]").
      const bare = value.replace(/^["']|["']$/g, '');
      if (/^(?:true|false|null|\[set\]|\[empty\]|\[left out\]|\[omitted\]|\*\*\*)$/i.test(bare)) {
        return m;
      }
      // A quoted key means JSON: the value stays a string, so the document still parses.
      const quote = value.startsWith('"')
        ? '"'
        : value.startsWith("'")
          ? "'"
          : q1 === '"'
            ? '"'
            : '';
      return `${q1}${name}${q2}${sep}${quote}${REDACTED}${quote}`;
    },
  );

  for (const [re, label] of TOKEN_SHAPES) out = out.replace(re, label);

  for (const secret of secrets) {
    if (!secret || secret.length < MIN_BARE_SECRET) continue;
    for (const form of variantsOf(secret)) out = replaceAll(out, form, REDACTED);
  }
  return out;
}

/** True when `text` still holds something `redactSecrets` would remove (used by tests and the bundle review). */
export function containsSecret(text: string, secrets: readonly string[] = []): boolean {
  return redactSecrets(text, secrets) !== text;
}
