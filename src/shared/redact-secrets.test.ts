import { describe, expect, it } from 'vitest';
import { REDACTED, REDACTED_KEY, containsSecret, redactSecrets } from './redact-secrets';

/** A fake key that looks like the real thing, split so scanners do not flag the test file. */
const AWS_KEY = `AKIA${'IOSFODNN7EXAMPLE'}`;
const OPENROUTER = `sk-or-v1-${'0123456789abcdef'.repeat(4)}`;
const OPENSSH_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACBzZWNyZXRzZWNyZXRzZWNyZXRzZWNyZXRzZWNyZXRzZWNyZXRzZWNyZXQ=',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

describe('URLs with a password', () => {
  it.each([
    ['postgres://admin:hunter2@db.example.com:5432/app', 'hunter2'],
    ['postgresql://admin:p%40ss%2Fword@db/app?sslmode=require', 'p%40ss%2Fword'],
    ['mysql://root:s3cr3t!@127.0.0.1:3306/x', 's3cr3t!'],
    ['redis://:topsecret@cache:6379/0', 'topsecret'],
    ['rediss://default:abc123@r.example.com:6380', 'abc123'],
    ['https://user:pa:ss@host/path', 'pa:ss'],
    // An unescaped @ inside the password: the last @ before the host ends the userinfo.
    ['postgres://u:pa@ss@host:5432/db', 'pa@ss'],
    ['connect failed for clickhouse://default:chpw@ch:8123 (timeout)', 'chpw'],
  ])('removes the password from %s', (text, password) => {
    const out = redactSecrets(text);
    expect(out).not.toContain(password);
    expect(out).toContain(`:${REDACTED}@`);
  });

  it('keeps the user name and host, so the line stays useful', () => {
    expect(redactSecrets('postgres://admin:hunter2@db.example.com:5432/app')).toBe(
      'postgres://admin:***@db.example.com:5432/app',
    );
  });

  it('leaves a URL without a password alone', () => {
    const url = 'https://user@host.example.com/path?x=1';
    expect(redactSecrets(url)).toBe(url);
    expect(redactSecrets('see https://example.com/docs')).toBe('see https://example.com/docs');
  });
});

describe('key=value secrets', () => {
  it.each([
    ['host=db user=app password=hunter2 dbname=x', 'hunter2'],
    ["host=db password='two words' sslmode=require", 'two words'],
    ['Server=db;User Id=app;Password=hunter2;Database=x', 'hunter2'],
    ['{"user":"app","password":"hunter2"}', 'hunter2'],
    ['{"password": "with \\"quote\\" inside"}', 'quote'],
    ['PGPASSWORD=hunter2 psql -h db', 'hunter2'],
    ['passwd: hunter2', 'hunter2'],
    ['ssl_passphrase=correct horse battery', 'correct'],
    ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
    ['api_key=abcd1234efgh5678', 'abcd1234efgh5678'],
    ['client_secret: "xyz-secret-value"', 'xyz-secret-value'],
    ['access_token=ya29.a0AfH6SMBexample', 'ya29'],
  ])('removes the value in %s', (text, secret) => {
    expect(redactSecrets(text)).not.toContain(secret);
  });

  it('keeps the names and the structure', () => {
    expect(redactSecrets('{"user":"app","password":"hunter2","port":5432}')).toBe(
      '{"user":"app","password":"***","port":5432}',
    );
    expect(redactSecrets('host=db password=hunter2 dbname=x')).toBe(
      'host=db password=*** dbname=x',
    );
  });

  it('does not treat "using password: YES" as a secret', () => {
    const msg = "Access denied for user 'root'@'localhost' (using password: YES)";
    expect(redactSecrets(msg)).toBe(msg);
  });

  it('removes a SQL password literal', () => {
    expect(redactSecrets("CREATE ROLE app LOGIN PASSWORD 'hunter2'")).not.toContain('hunter2');
    expect(redactSecrets("ALTER USER app IDENTIFIED BY 'it''s secret'")).not.toContain('secret');
  });
});

describe('private keys', () => {
  it('removes a whole PEM block, not just its header', () => {
    const out = redactSecrets(`before\n${OPENSSH_KEY}\nafter`);
    expect(out).toBe(`before\n${REDACTED_KEY}\nafter`);
    expect(out).not.toContain('b3BlbnNzaC1');
  });

  it.each(['RSA', 'EC', 'DSA', 'ENCRYPTED', 'OPENSSH', ''])('handles %s keys', (kind) => {
    const label = `${kind ? `${kind} ` : ''}PRIVATE KEY`;
    const pem = `-----BEGIN ${label}-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END ${label}-----`;
    expect(redactSecrets(pem)).toBe(REDACTED_KEY);
  });

  it('removes a key stored in JSON with escaped newlines', () => {
    const json = JSON.stringify({ host: 'jump', privateKey: OPENSSH_KEY });
    const out = redactSecrets(json);
    expect(out).not.toContain('b3BlbnNzaC1');
    expect(out).toContain('"host":"jump"');
  });

  it('removes a key that was cut off (no END line) up to the end of the text', () => {
    const out = redactSecrets(
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7vbqajDw4o6gJy8UtmIbkcpnkO3Kwc4qsEn',
    );
    expect(out).not.toContain('MIIEowIBAAKCAQEA');
  });

  it('leaves a public key and a certificate alone', () => {
    const cert =
      '-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0BAQUFADBa\n-----END CERTIFICATE-----';
    expect(redactSecrets(cert)).toBe(cert);
  });
});

describe('tokens and keys', () => {
  it('removes an AWS access key id', () => {
    const out = redactSecrets(`key ${AWS_KEY} used`);
    expect(out).not.toContain(AWS_KEY);
    expect(out).toContain('[aws key removed]');
  });

  it('removes an OpenRouter key', () => {
    const out = redactSecrets(`Authorization failed for ${OPENROUTER}`);
    expect(out).not.toContain(OPENROUTER);
    expect(out).not.toContain('0123456789abcdef');
  });

  it.each([
    'Authorization: Bearer abcdef1234567890abcdef',
    'authorization=Bearer abcdef1234567890abcdef',
    'request failed (Bearer abcdef1234567890abcdef)',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'x-api-key: abcdef1234567890',
  ])('removes the credential in %j', (text) => {
    const out = redactSecrets(text);
    expect(out).not.toMatch(/abcdef1234567890|dXNlcjpwYXNzd29yZA/);
  });

  it.each([
    ['ghp_', 'ghp_0123456789abcdefghijABCDEFGHIJ012345'],
    ['github_pat_', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'],
    ['sk-ant-', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['sk-', 'sk-abcdefghijklmnopqrstuvwxyz012345'],
    ['AIza', 'AIzaSyA1234567890abcdefghijklmnopqrstuvw'],
    ['xoxb-', 'xoxb-123456789012-abcdefghij'],
    [
      'jwt',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ],
  ])('removes a %s token', (_name, token) => {
    expect(redactSecrets(`token was ${token} ok`)).not.toContain(
      token.slice(0, 20) + token.slice(-8),
    );
  });
});

describe('known secrets', () => {
  it('removes a known password wherever it appears, in every encoding', () => {
    const pw = 'p@ss w0rd/"x"';
    const text = [
      `plain ${pw}`,
      `url-encoded ${encodeURIComponent(pw)}`,
      `json ${JSON.stringify(pw)}`,
    ].join('\n');
    const out = redactSecrets(text, [pw]);
    expect(out).not.toContain('w0rd');
    expect(out).not.toContain('w0rd%2F');
  });

  it('ignores empty and very short secrets that would shred the text', () => {
    expect(redactSecrets('the cat sat', ['a', '', 'at'])).toBe('the cat sat');
  });

  it('does not change text with nothing to remove', () => {
    const text = 'connect ECONNREFUSED 127.0.0.1:5432 at TCPConnectWrap.afterConnect';
    expect(redactSecrets(text, ['hunter2'])).toBe(text);
    expect(containsSecret(text, ['hunter2'])).toBe(false);
    expect(containsSecret('password=hunter2')).toBe(true);
  });

  it('is idempotent', () => {
    const text = `postgres://a:hunter2@h/db password=hunter2 ${AWS_KEY}`;
    const once = redactSecrets(text, ['hunter2']);
    expect(redactSecrets(once, ['hunter2'])).toBe(once);
  });
});
