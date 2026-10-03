import { describe, expect, it } from 'vitest';
import {
  isCardValue,
  isEmailValue,
  isIpValue,
  isPhoneValue,
  luhnValid,
  maskResultRows,
  maskValue,
  nameTokens,
  resolveMaskedColumns,
  sensitiveKindByName,
  sensitiveKindBySamples,
  sensitiveKindByValue,
  withPlainColumn,
  withSensitiveColumn,
  withoutColumnRule,
} from './masking';

describe('name detector', () => {
  it('splits snake, kebab and camel case', () => {
    expect(nameTokens('userEmailAddress')).toEqual(['user', 'email', 'address']);
    expect(nameTokens('IPAddress')).toEqual(['ip', 'address']);
    expect(nameTokens('billing-phone_2')).toEqual(['billing', 'phone', '2']);
  });

  it.each([
    ['email', 'email'],
    ['user_email', 'email'],
    ['contactEmail', 'email'],
    ['useremail', 'email'],
    ['phone', 'phone'],
    ['mobile_number', 'phone'],
    ['ssn', 'ssn'],
    ['social_security_number', 'ssn'],
    ['password', 'password'],
    ['password_hash', 'password'],
    ['api_key', 'secret'],
    ['access_token', 'secret'],
    ['client_secret', 'secret'],
    ['card_number', 'card'],
    ['credit_card', 'card'],
    ['iban', 'iban'],
    ['street_address', 'address'],
    ['dob', 'dob'],
    ['date_of_birth', 'dob'],
    ['last_ip', 'ip'],
    ['ip_address', 'ip'],
  ])('%s is sensitive (%s)', (name, kind) => {
    expect(sensitiveKindByName(name)).toBe(kind);
  });

  it.each([
    'id',
    'name',
    'description',
    'ship_date',
    'skip_count',
    'tripod',
    'email_verified',
    'token_count',
    'address_id',
    'is_email_sent',
    'has_password',
    'phone_type',
    'password_changed_at',
    'zip',
  ])('%s is not sensitive', (name) => {
    expect(sensitiveKindByName(name)).toBeNull();
  });
});

describe('value detectors', () => {
  it('recognises emails', () => {
    expect(isEmailValue('ann@example.com')).toBe(true);
    expect(isEmailValue('not an email')).toBe(false);
    expect(isEmailValue('a@b')).toBe(false);
  });

  it('recognises cards with the Luhn check', () => {
    expect(luhnValid('4242424242424242')).toBe(true);
    expect(luhnValid('4242424242424241')).toBe(false);
    expect(isCardValue('4242 4242 4242 4242')).toBe(true);
    expect(isCardValue('4242-4242-4242-4242')).toBe(true);
    expect(isCardValue('1234567890123456')).toBe(false);
  });

  it('recognises IPv4 and IPv6 but not version numbers', () => {
    expect(isIpValue('192.168.1.20')).toBe(true);
    expect(isIpValue('999.1.1.1')).toBe(false);
    expect(isIpValue('1.2.3')).toBe(false);
    expect(isIpValue('2001:db8::1')).toBe(true);
    expect(isIpValue('12:30:45')).toBe(true); // ambiguous with a time; only sniffed on text columns with agreement
  });

  it('recognises formatted phones but not bare ids or dates', () => {
    expect(isPhoneValue('+1 (415) 555-0100')).toBe(true);
    expect(isPhoneValue('415-555-0100')).toBe(true);
    expect(isPhoneValue('4155550100')).toBe(false);
    expect(isPhoneValue('2024-05-01')).toBe(false);
    expect(isPhoneValue('12345')).toBe(false);
  });

  it('classifies a single value', () => {
    expect(sensitiveKindByValue('a@b.co')).toBe('email');
    expect(sensitiveKindByValue('123-45-6789')).toBe('ssn');
    expect(sensitiveKindByValue('10.0.0.1')).toBe('ip');
    expect(sensitiveKindByValue('hello')).toBeNull();
  });

  it('needs most sampled values to agree', () => {
    expect(sensitiveKindBySamples(['a@b.co', 'c@d.org', null, 'x@y.io'])).toBe('email');
    expect(sensitiveKindBySamples(['a@b.co', 'plain', 'text', 'more'])).toBeNull();
    expect(sensitiveKindBySamples([null, null])).toBeNull();
    expect(sensitiveKindBySamples([])).toBeNull();
  });
});

describe('maskers', () => {
  it('masks emails keeping the first letter and domain', () => {
    expect(maskValue('ann@example.com', 'email', 'initial')).toBe('a•••@example.com');
    expect(maskValue('ann@example.com', 'email', 'last4')).toBe('•••@example.com');
    expect(maskValue('ann@example.com', 'email', 'full')).toBe('•••');
  });

  it('masks cards to the last four', () => {
    expect(maskValue('4242 4242 4242 4242', 'card', 'last4')).toBe('•••• 4242');
    expect(maskValue('4242424242424242', 'card', 'initial')).toBe('•••• 4242');
    expect(maskValue('4242424242424242', 'card', 'full')).toBe('•••');
  });

  it('never reveals any part of credentials', () => {
    expect(maskValue('hunter2hunter2', 'password', 'initial')).toBe('•••');
    expect(maskValue('sk_live_abcdef1234', 'secret', 'last4')).toBe('•••');
  });

  it('masks IPv4 keeping the last octet', () => {
    expect(maskValue('192.168.1.20', 'ip', 'initial')).toBe('•••.•••.•••.20');
    expect(maskValue('192.168.1.20', 'ip', 'full')).toBe('•••');
  });

  it('masks generic text and short values', () => {
    expect(maskValue('221B Baker Street', 'address', 'initial')).toBe('2•••');
    expect(maskValue('221B Baker Street', 'address', 'last4')).toBe('•••• reet');
    expect(maskValue('abc', 'address', 'last4')).toBe('•••');
  });

  it('leaves NULL and empty alone', () => {
    expect(maskValue(null, 'email')).toBeNull();
    expect(maskValue(undefined, 'email')).toBeUndefined();
    expect(maskValue('', 'email')).toBe('');
  });
});

describe('resolveMaskedColumns', () => {
  const cols = [
    { name: 'id', dataTypeName: 'int4' },
    { name: 'email', dataTypeName: 'text' },
    { name: 'contact', dataTypeName: 'text' },
    { name: 'note', dataTypeName: 'text' },
    { name: 'order_no', dataTypeName: 'int8' },
  ];
  const samples: Record<number, string[]> = {
    0: ['1', '2'],
    1: ['a@b.co'],
    2: ['a@b.co', 'c@d.org'],
    3: ['hello', 'world'],
    4: ['415-555-0100', '415-555-0101'],
  };
  const sample = (i: number) => samples[i] ?? [];

  it('combines name and value detectors, skipping numeric columns for values', () => {
    const m = resolveMaskedColumns(cols, sample);
    expect([...m.keys()]).toEqual([1, 2]);
    expect(m.get(1)).toEqual({ kind: 'email', reason: 'name' });
    expect(m.get(2)).toEqual({ kind: 'email', reason: 'values' });
  });

  it('applies per-connection rules over the detectors', () => {
    const m = resolveMaskedColumns(cols, sample, {
      sensitive: ['NOTE'],
      plain: ['Email'],
    });
    expect([...m.keys()]).toEqual([2, 3]);
    expect(m.get(3)).toEqual({ kind: 'custom', reason: 'rule' });
  });

  it('edits rules without duplicates and moves a column between lists', () => {
    let r = withSensitiveColumn({ sensitive: [], plain: [] }, 'Note');
    r = withSensitiveColumn(r, 'note');
    expect(r).toEqual({ sensitive: ['note'], plain: [] });
    r = withPlainColumn(r, 'note');
    expect(r).toEqual({ sensitive: [], plain: ['note'] });
    expect(withoutColumnRule(r, 'NOTE')).toEqual({ sensitive: [], plain: [] });
  });
});

describe('maskResultRows', () => {
  it('masks sensitive columns in copies and leaves the input alone', () => {
    const rows = [
      [1, 'ann@example.com', 'x'],
      [2, null, 'y'],
    ];
    const out = maskResultRows([{ name: 'id' }, { name: 'email' }, { name: 'note' }], rows, {
      style: 'initial',
    });
    expect(out).toEqual([
      [1, 'a•••@example.com', 'x'],
      [2, null, 'y'],
    ]);
    expect(rows[0]?.[1]).toBe('ann@example.com');
  });
});
