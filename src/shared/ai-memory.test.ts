import { describe, expect, it } from 'vitest';
import {
  MEMORY_ERR_DUPLICATE,
  MEMORY_ERR_SECRET,
  MEMORY_MAX_CHARS,
  MEMORY_MAX_NOTES,
  MEMORY_PROMPT_MAX_CHARS,
  MEMORY_SECTION_TITLE,
  checkMemoryText,
  findMemoryByRef,
  formatMemoryForPrompt,
  isMemoryEnabled,
  isMemorySource,
  memoryActionResult,
  memoryHasSecret,
  memoryPromptSection,
  memorySourceLabel,
  normalizeMemoryText,
} from './ai-memory';

describe('checkMemoryText', () => {
  it('trims and collapses whitespace into one paragraph', () => {
    const r = checkMemoryText('  orders.amount \n\n is   in\tcents ', []);
    expect(r).toEqual({ ok: true, text: 'orders.amount is in cents' });
    expect(normalizeMemoryText('a\n\n\nb')).toBe('a b');
  });

  it('refuses empty and over-long notes', () => {
    expect(checkMemoryText('   ', []).ok).toBe(false);
    expect(checkMemoryText('x'.repeat(MEMORY_MAX_CHARS), []).ok).toBe(true);
    const long = checkMemoryText('x'.repeat(MEMORY_MAX_CHARS + 1), []);
    expect(long.ok).toBe(false);
  });

  it('refuses an exact duplicate, ignoring case and spacing', () => {
    const existing = [{ id: 'a', text: 'Active customer = status A' }];
    expect(checkMemoryText('  active   CUSTOMER = status a', existing)).toEqual({
      ok: false,
      error: MEMORY_ERR_DUPLICATE,
    });
    expect(MEMORY_ERR_DUPLICATE).toBe('Already remembered.');
    // Editing a note to its own text is not a duplicate.
    expect(checkMemoryText('Active customer = status A', existing, { selfId: 'a' }).ok).toBe(true);
  });

  it('caps the notes per connection', () => {
    const full = Array.from({ length: MEMORY_MAX_NOTES }, (_, i) => ({
      id: `i${i}`,
      text: `n${i}`,
    }));
    expect(checkMemoryText('one more', full).ok).toBe(false);
    // An edit of an existing note is still fine on a full list.
    expect(checkMemoryText('changed', full, { selfId: 'i3' }).ok).toBe(true);
  });

  it('refuses text that carries a secret', () => {
    for (const t of [
      'the password: hunter2hunter2',
      'use postgres://admin:s3cretpw@db.internal:5432/app for reports',
      'api_key=abcd1234efgh5678',
      'Authorization: Bearer abcdefghijklmnop',
      'key AKIAIOSFODNN7EXAMPLE',
      'token sk-ant-abcdefghijklmnop',
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    ]) {
      expect(checkMemoryText(t, []), t).toEqual({ ok: false, error: MEMORY_ERR_SECRET });
    }
    expect(MEMORY_ERR_SECRET).toBe("Memory can't hold passwords or keys.");
  });

  it('accepts ordinary business notes', () => {
    for (const t of [
      "Active customer = status 'A' and an order in the last 90 days",
      'orders.amount is in cents',
      'Ignore schema legacy_*',
      'Test accounts have emails @example.com',
      'The tokens table lists API clients, one row each',
    ]) {
      expect(checkMemoryText(t, []).ok, t).toBe(true);
    }
  });
});

describe('formatMemoryForPrompt', () => {
  const note = (id: string, text: string, updatedAt: number) => ({ id, text, updatedAt });

  it('lists newest-updated first as `- [m:<shortid>] text`', () => {
    const f = formatMemoryForPrompt([
      note('aaaaaa1111', 'old', 1),
      note('bbbbbb2222', 'new', 5),
      note('cccccc3333', 'mid', 3),
    ]);
    expect(f.block.split('\n')).toEqual([
      '- [m:bbbbbb] new',
      '- [m:cccccc] mid',
      '- [m:aaaaaa] old',
    ]);
    expect(f.included).toBe(3);
  });

  it('stops at the character cap, drops the oldest and says how many', () => {
    const notes = Array.from({ length: 30 }, (_, i) =>
      note(`id${String(i).padStart(4, '0')}xx`, `${'n'.repeat(400)}${i}`, i),
    );
    const f = formatMemoryForPrompt(notes);
    expect(f.block.length).toBeLessThanOrEqual(MEMORY_PROMPT_MAX_CHARS + 80);
    const lines = f.block.split('\n');
    expect(lines[0]).toContain('[m:id0029]');
    expect(lines.at(-1)).toMatch(/^\(\d+ older notes were left out/);
    expect(f.included + Number(lines.at(-1)?.match(/\d+/)?.[0])).toBe(30);
    // the note lines alone fit the cap
    expect(lines.slice(0, -1).join('\n').length).toBeLessThanOrEqual(MEMORY_PROMPT_MAX_CHARS);
  });

  it('builds the section with its title, or nothing for no notes', () => {
    expect(memoryPromptSection([])).toBeNull();
    const s = memoryPromptSection([note('abcdef123', 'a rule', 1)]);
    expect(s?.count).toBe(1);
    expect(s?.text).toContain(MEMORY_SECTION_TITLE);
    expect(s?.text).toContain('- [m:abcdef] a rule');
  });
});

describe('refs, sources, switch', () => {
  const notes = [{ id: 'abcdef111111' }, { id: 'abcdef222222' }, { id: 'zzzzzz333333' }];
  it('finds a note by m:<shortid>, bare shortid or full id; refuses ambiguous', () => {
    expect(findMemoryByRef(notes, 'm:zzzzzz')?.id).toBe('zzzzzz333333');
    expect(findMemoryByRef(notes, '[m:zzzzzz]')?.id).toBe('zzzzzz333333');
    expect(findMemoryByRef(notes, 'abcdef222222')?.id).toBe('abcdef222222');
    expect(findMemoryByRef(notes, 'm:abcdef')).toBeNull();
    expect(findMemoryByRef(notes, 'm:nope')).toBeNull();
  });

  it('accepts user, agent and mcp:<client> sources', () => {
    expect(isMemorySource('user')).toBe(true);
    expect(isMemorySource('agent')).toBe(true);
    expect(isMemorySource('mcp:Claude Code')).toBe(true);
    expect(isMemorySource('mcp:')).toBe(false);
    expect(isMemorySource('robot')).toBe(false);
    expect(memorySourceLabel('user')).toBe('You');
    expect(memorySourceLabel('agent')).toBe('Assistant');
    expect(memorySourceLabel('mcp:Claude Code')).toBe('Claude Code');
  });

  it('is on unless switched off, and never without a connection', () => {
    expect(isMemoryEnabled('c1', {})).toBe(true);
    expect(isMemoryEnabled('c1', { connectionAiMemory: { c1: false } })).toBe(false);
    expect(isMemoryEnabled('c1', { connectionAiMemory: { c2: false } })).toBe(true);
    expect(isMemoryEnabled(null, {})).toBe(false);
  });

  it('words the tool result for the model', () => {
    expect(
      JSON.parse(memoryActionResult('remember', { outcome: 'applied', memoryId: 'abcdef123456' })),
    ).toEqual({
      remembered: true,
      id: 'm:abcdef',
    });
    expect(JSON.parse(memoryActionResult('forget', { outcome: 'applied' }))).toEqual({
      forgotten: true,
    });
    expect(JSON.parse(memoryActionResult('remember', { outcome: 'rejected' }))).toEqual({
      outcome: 'rejected',
    });
    expect(
      JSON.parse(
        memoryActionResult('remember', { outcome: 'failed', note: 'Already remembered.' }),
      ),
    ).toEqual({
      error: 'Already remembered.',
    });
  });
});

describe('secrets in prose and column notes', () => {
  it('refuses a credential written as a sentence', () => {
    for (const t of [
      'Password for reporting role: Rep0rt!ng',
      'the admin password is hunter2',
      'pw for app_user is S3cretPass!',
      'api key is Zx81kQpLm',
      'The token = "ab12"',
    ]) {
      expect(checkMemoryText(t, []), t).toEqual({ ok: false, error: MEMORY_ERR_SECRET });
    }
  });

  it('refuses text holding a value main knows, case-sensitively, ignoring short ones', () => {
    const secrets = ['correct horse battery', 'abc'];
    expect(memoryHasSecret('login uses correct horse battery here', secrets)).toBe(true);
    expect(memoryHasSecret('login uses Correct Horse Battery here', secrets)).toBe(false);
    expect(memoryHasSecret('the abc table', secrets)).toBe(false);
    expect(checkMemoryText('use correct horse battery', [], { secrets }).ok).toBe(false);
  });

  it('accepts notes that explain a password or token column', () => {
    for (const t of [
      'users.password_hash: bcrypt hash, never select it',
      'sessions.token is a uuid',
      'sessions.token: opaque id, do not show',
      'token_count = tokens billed',
      'The password column holds a bcrypt hash',
      'api_keys.secret_key: shown once, stored hashed',
      'reset token is valid for 24 hours',
      'secrets table: public.secrets_v2',
    ]) {
      expect(checkMemoryText(t, []).ok, t).toBe(true);
    }
  });

  it('still refuses name=value credentials with identifier-shaped names', () => {
    expect(memoryHasSecret('db_password=Pa55w0rd!x', [])).toBe(true);
    expect(memoryHasSecret('users.password: S3cr3tValue9', [])).toBe(true);
  });
});
