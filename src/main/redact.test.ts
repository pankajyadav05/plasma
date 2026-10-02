import { describe, expect, it } from 'vitest';
import { redactErrorText, redactLogValue, redactSqlSecrets } from './redact';

describe('redactSqlSecrets (SC-27)', () => {
  it.each([
    ["ALTER USER a WITH PASSWORD 'hunter2'", "ALTER USER a WITH PASSWORD '***'"],
    ["CREATE ROLE r PASSWORD E'it\\'s secret'", "CREATE ROLE r PASSWORD '***'"],
    ['CREATE ROLE r PASSWORD $$s3cr;et$$', "CREATE ROLE r PASSWORD '***'"],
    ['CREATE ROLE r PASSWORD $pw$s3cr$et$pw$ LOGIN', "CREATE ROLE r PASSWORD '***' LOGIN"],
    ["CREATE SERVER s OPTIONS (password 'x y')", "CREATE SERVER s OPTIONS (password '***')"],
    [
      "SELECT dblink_connect('host=h password=s3cret dbname=d')",
      "SELECT dblink_connect('host=h password=*** dbname=d')",
    ],
    [
      'ALTER SUBSCRIPTION s CONNECTION \'host=h password="a b"\'',
      "ALTER SUBSCRIPTION s CONNECTION 'host=h password=***'",
    ],
  ])('masks %j', (input, expected) => {
    expect(redactSqlSecrets(input)).toBe(expected);
  });

  it('leaves ordinary SQL alone', () => {
    const sql = "SELECT * FROM users WHERE password = $1 AND note = 'password policy'";
    expect(redactSqlSecrets(sql)).toBe(sql);
  });
});

describe('redactErrorText (SC-27)', () => {
  it('drops echoed row values but keeps the error shape', () => {
    expect(redactErrorText('Key (email)=(a@b.com) already exists.')).toBe(
      'Key (email)=(***) already exists.',
    );
    expect(redactErrorText('Failing row contains (1, a@b.com, secret)')).toBe(
      'Failing row contains (***)',
    );
    expect(redactErrorText('invalid input syntax for type integer: "12abc"')).toBe(
      'invalid input syntax for type integer: "***"',
    );
  });

  it('masks passwords quoted in the failing statement', () => {
    expect(
      redactErrorText('syntax error at or near "x"\nLINE 1: ALTER USER a PASSWORD \'pw\''),
    ).toContain("PASSWORD '***'");
  });
});

describe('redactLogValue', () => {
  it('redacts strings and error messages, passes other values through', () => {
    expect(redactLogValue('password=abc')).toBe('password=***');
    const err = redactLogValue(new Error("bad PASSWORD 'zz'")) as Error;
    expect(err.message).toBe("bad PASSWORD '***'");
    expect(redactLogValue(42)).toBe(42);
  });
});
