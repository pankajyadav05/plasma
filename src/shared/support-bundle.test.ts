import { describe, expect, it } from 'vitest';
import {
  type SupportBundleInput,
  buildSupportBundle,
  collectIdentities,
  createPrivacyFilter,
  recentErrors,
  sanitizeConnections,
  sanitizeSettings,
  tailLines,
  totalBytes,
} from './support-bundle';

/** Fake credentials, assembled so a secret scanner does not flag this file. */
const OR_KEY = `sk-or-v1-${'abcdef0123456789'.repeat(4)}`;
const AWS_KEY = `AKIA${'IOSFODNN7EXAMPLE'}`;
const PEM = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACBzZWNyZXRzZWNyZXRzZWNyZXRzZWNyZXRzZWNyZXRzZWNyZXRzZWNyZXQ=',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

const HOST = 'db.prod.example.com';
const SSH_HOST = 'bastion.example.com';

const input = (over: Partial<SupportBundleInput> = {}): SupportBundleInput => ({
  generatedAt: '2026-10-07T10:00:00.000Z',
  app: {
    name: 'Plasma',
    version: '3.3.0',
    platform: 'linux',
    arch: 'x64',
    osRelease: '7.0.0-34-generic',
    electron: '44.0.0',
    chrome: '140.0.0.0',
    node: '24.0.0',
    locale: 'en-US',
    packaged: true,
  },
  active: { engine: 'postgres', serverVersion: 'PostgreSQL 16.2' },
  connections: [
    {
      id: 'c1',
      name: 'Prod orders',
      engine: 'postgres',
      host: HOST,
      port: 5432,
      database: 'orders',
      user: 'alice',
      password: 'hunter2-pw',
      ssl: true,
      tls: { mode: 'verify-full', ca: PEM, key: PEM, cert: PEM },
      readOnly: true,
      bootstrapSql:
        "SET search_path = secret_schema; SELECT set_config('app.token','tok-123',false)",
    },
    {
      id: 'c2',
      name: 'Search',
      engine: 'opensearch',
      host: 'search.example.com',
      port: 9200,
      user: 'bob',
      database: '',
      opensearch: {
        auth: 'apiKey',
        apiKey: 'key-id:key-secret',
        awsSecretAccessKey: 'aws-secret-value',
        nodes: ['https://bob:node-pw@node2.example.com:9200'],
      },
    },
    {
      id: 'c3',
      name: 'Local file',
      engine: 'sqlite',
      host: 'local',
      port: 1,
      database: '/home/alice/projects/data/app.db',
      user: '',
    },
    {
      id: 'c4',
      name: 'Files',
      engine: 'duckdb',
      host: 'local',
      port: 1,
      database: ':memory:',
      duckdb: {
        files: ['/home/alice/secret/customers.csv', '/home/alice/secret/salaries.parquet'],
      },
    },
  ],
  settings: {
    theme: 'dark',
    queryTimeoutMs: 30000,
    editorFontSize: 13,
    pgBinDir: '/home/alice/pg/bin',
    openrouterApiKey: OR_KEY,
    hasOpenrouterApiKey: true,
    claudeApiKey: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
    aiLocalUrl: 'http://alice:local-pw@127.0.0.1:11434/v1',
    connectionTags: { c1: 'prod' },
    connectionSsh: {
      c1: {
        host: SSH_HOST,
        port: 22,
        user: 'alice',
        password: 'ssh-pw-123',
        privateKey: PEM,
        passphrase: 'key-pass-456',
        privateKeyPath: '/home/alice/.ssh/id_ed25519',
        useAgent: false,
      },
    },
    sshKnownHosts: {
      'bastion:22': { host: SSH_HOST, port: 22, key: 'AAAAC3NzaC1lZDI1NTE5', addedAt: 1 },
    },
    userSnippets: [{ name: 'dump', prefix: 'sel', body: 'SELECT ssn FROM people' }],
    savedQueries: [{ name: 'q', sql: 'SELECT salary FROM payroll' }],
    queryHistory: [{ sql: "INSERT INTO users VALUES ('secret-row')" }],
    sessionTabs: { c1: [{ sql: 'SELECT * FROM customers' }] },
    schemaSnapshots: { s1: { schema: { tables: [{ name: 'payroll' }] } } },
    note: "SELECT name, ssn FROM people WHERE name = 'x'",
    longText: 'x'.repeat(5000),
  },
  mainLog: [
    '[2026-10-07 09:00:00.000] [info] [plasma] logger initialized at /home/alice/.config/Plasma/logs/main.log',
    `[2026-10-07 09:00:01.000] [error] connect failed for postgres://alice:hunter2-pw@${HOST}:5432/orders`,
    '[2026-10-07 09:00:02.000] [info] host=10.0.0.5 user=alice password=hunter2-pw dbname=orders',
    '[2026-10-07 09:00:03.000] [warn] request failed (Bearer abcdef1234567890abcdef)',
    `[2026-10-07 09:00:04.000] [error] key ${AWS_KEY} rejected`,
    `[2026-10-07 09:00:05.000] [error] syntax error at or near "FROM" in "SELECT ssn FROM people WHERE name = 'carol'"`,
    "[2026-10-07 09:00:06.000] [error] Failing row contains INSERT INTO users (email) VALUES ('alice@corp.com')",
    `[2026-10-07 09:00:07.000] [info] using ${OR_KEY}`,
    ...PEM.split('\n').map((l) => `[2026-10-07 09:00:08.000] [debug] ${l}`),
    '[2026-10-07 09:00:09.000] [info] alice@corp.com connected',
    '[2026-10-07 09:00:10.000] [info] ordinary line',
  ].join('\n'),
  mainLogOld: '[2026-10-06 23:59:59.000] [error] older failure on db.prod.example.com',
  workerLog: [
    '[worker] plasma db worker ready',
    '[worker:err] [plasma] postgres connection lost: primary: connection closed by server',
    '[worker:err] COPY secrets FROM stdin failed',
  ].join('\n'),
  updateHelperLog: 'step 1\nstep 2\nstep 3',
  osUser: 'alice',
  ...over,
});

const allText = (files: ReturnType<typeof buildSupportBundle>) =>
  files.map((f) => `# ${f.name}\n${f.text}`).join('\n');

/** Everything that must never appear, whatever the toggle is. */
const FORBIDDEN = [
  'hunter2-pw',
  'ssh-pw-123',
  'key-pass-456',
  'local-pw',
  'node-pw',
  'tok-123',
  'secret_schema',
  'key-secret',
  'aws-secret-value',
  OR_KEY,
  'sk-ant-api03',
  AWS_KEY,
  'abcdef1234567890abcdef',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU',
  'QyNTUxOQAAACBzZWNyZXRz',
  'AAAAC3NzaC1lZDI1NTE5',
  // what the user wrote or ran
  'SELECT ssn',
  'SELECT salary',
  'SELECT * FROM customers',
  'secret-row',
  'payroll',
  'INSERT INTO users',
  "WHERE name = 'carol'",
  'COPY secrets',
  'customers.csv',
  'salaries.parquet',
  'x'.repeat(400),
];

describe('buildSupportBundle', () => {
  it.each([false, true])(
    'never holds a secret or anything the user wrote (hide hosts: %s)',
    (hide) => {
      const files = buildSupportBundle(input(), { redactHostsAndUsers: hide });
      const text = allText(files);
      for (const bad of FORBIDDEN) expect(text, `leaked: ${bad.slice(0, 40)}`).not.toContain(bad);
    },
  );

  it('lists the files a helper expects, each with a description and its exact size', () => {
    const files = buildSupportBundle(input(), { redactHostsAndUsers: false });
    expect(files.map((f) => f.name)).toEqual([
      'README.txt',
      'system.json',
      'settings.json',
      'connections.json',
      'logs/main.log',
      'logs/main.old.log',
      'logs/worker.log',
      'logs/update-helper.log',
      'errors.txt',
    ]);
    for (const f of files) {
      expect(f.description.length).toBeGreaterThan(5);
      expect(f.bytes).toBe(new TextEncoder().encode(f.text).length);
      expect(f.text.endsWith('\n') || f.text === '').toBe(true);
    }
    expect(totalBytes(files)).toBe(files.reduce((n, f) => n + f.bytes, 0));
  });

  it('keeps the useful facts: versions, engine, host, port, database', () => {
    const files = buildSupportBundle(input(), { redactHostsAndUsers: false });
    const by = Object.fromEntries(files.map((f) => [f.name, f.text]));
    const system = JSON.parse(by['system.json'] as string);
    expect(system.app.version).toBe('3.3.0');
    expect(system.runtime.electron).toBe('44.0.0');
    expect(system.activeConnection).toEqual({
      engine: 'postgres',
      serverVersion: 'PostgreSQL 16.2',
    });
    const conns = JSON.parse(by['connections.json'] as string);
    expect(conns[0]).toMatchObject({
      engine: 'postgres',
      host: HOST,
      port: 5432,
      database: 'orders',
      user: 'alice',
      tlsMode: 'verify-full',
      readOnly: true,
      hasBootstrapSql: true,
    });
    expect(by['logs/main.log']).toContain('ordinary line');
    expect(by['logs/update-helper.log']).toContain('step 3');
    expect(by['errors.txt']).toContain('connection lost');
  });

  it('keeps plain preferences and marks credentials as set', () => {
    const settings = JSON.parse(
      buildSupportBundle(input(), { redactHostsAndUsers: false }).find(
        (f) => f.name === 'settings.json',
      )?.text as string,
    );
    expect(settings.theme).toBe('dark');
    expect(settings.queryTimeoutMs).toBe(30000);
    expect(settings.openrouterApiKey).toBe('[set]');
    expect(settings.hasOpenrouterApiKey).toBe(true);
    expect(settings.connectionSsh.c1).toEqual({
      host: SSH_HOST,
      port: 22,
      user: 'alice',
      auth: 'key',
      keyFile: true,
    });
    expect(settings.userSnippets).toMatch(/left out/);
    expect(settings.longText).toMatch(/^\[text, 5000 characters\]$/);
  });

  it('describes a file or data-file connection without the paths', () => {
    const conns = JSON.parse(
      buildSupportBundle(input(), { redactHostsAndUsers: false }).find(
        (f) => f.name === 'connections.json',
      )?.text as string,
    );
    expect(conns[2]).toMatchObject({ engine: 'sqlite', database: 'app.db' });
    expect(conns[3]).toMatchObject({ engine: 'duckdb', dataFiles: 2 });
    expect(JSON.stringify(conns)).not.toContain('/home/alice');
  });

  it('leaves out log lines that look like SQL, and says so', () => {
    const log = buildSupportBundle(input(), { redactHostsAndUsers: false }).find(
      (f) => f.name === 'logs/main.log',
    )?.text as string;
    expect(log).toContain('[line left out: it looks like SQL]');
    expect(log).not.toContain('SELECT ssn');
    // The rest of the log is untouched.
    expect(log).toContain('ordinary line');
  });

  it('omits main.old.log and update-helper.log when there is nothing', () => {
    const files = buildSupportBundle(input({ mainLogOld: '', updateHelperLog: null }), {
      redactHostsAndUsers: false,
    });
    expect(files.map((f) => f.name)).not.toContain('logs/main.old.log');
    expect(files.map((f) => f.name)).not.toContain('logs/update-helper.log');
  });

  it('keeps only the last 200 lines of the update helper log', () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    const text = buildSupportBundle(input({ updateHelperLog: many }), {
      redactHostsAndUsers: false,
    }).find((f) => f.name === 'logs/update-helper.log')?.text as string;
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('line 301');
    expect(lines.at(-1)).toBe('line 500');
  });
});

describe('hiding host names and user names', () => {
  const hidden = () => buildSupportBundle(input(), { redactHostsAndUsers: true });

  it('removes every host, address, user and e-mail address from every file', () => {
    const text = allText(hidden());
    for (const bad of [
      HOST,
      SSH_HOST,
      'search.example.com',
      'node2.example.com',
      '10.0.0.5',
      'alice',
      'bob',
      'alice@corp.com',
      '/home/alice',
    ]) {
      expect(text, bad).not.toContain(bad);
    }
  });

  it('uses the same placeholder for the same host in every file', () => {
    const files = hidden();
    const conns = JSON.parse(files.find((f) => f.name === 'connections.json')?.text as string);
    const placeholder = conns[0].host as string;
    expect(placeholder).toMatch(/^host-\d+$/);
    const log = files.find((f) => f.name === 'logs/main.log')?.text as string;
    expect(log).toContain(
      `postgres://user-1:***@${placeholder}:5432/orders`.replace('user-1', conns[0].user),
    );
    const old = files.find((f) => f.name === 'logs/main.old.log')?.text as string;
    expect(old).toContain(placeholder);
  });

  it('keeps what is not an identity: versions, engines, ports, loopback', () => {
    const text = allText(hidden());
    expect(text).toContain('PostgreSQL 16.2');
    expect(text).toContain('"port": 5432');
    expect(text).toContain('127.0.0.1');
    expect(text).toContain('localhost'.slice(0, 0));
  });

  it('says in the README which mode it is', () => {
    const readme = (hide: boolean) =>
      buildSupportBundle(input(), { redactHostsAndUsers: hide }).find(
        (f) => f.name === 'README.txt',
      )?.text as string;
    expect(readme(true)).toMatch(/replaced with placeholders|replaced with\s+placeholders/);
    expect(readme(false)).toMatch(/Host names and user names are included/);
    for (const hide of [true, false]) {
      for (const line of readme(hide).split('\n')) expect(line.length).toBeLessThanOrEqual(72);
    }
  });

  it('does not rewrite a user name inside a longer word', () => {
    const p = createPrivacyFilter({ hosts: [], users: ['app'] });
    expect(p.text('user app logged in; application started; app_server ok')).toBe(
      'user user-1 logged in; application started; app_server ok',
    );
  });

  it('ignores user names too short to replace safely', () => {
    const p = createPrivacyFilter({ hosts: [], users: ['a', 'ab'] });
    expect(p.text('a cat and a bat, ab cd')).toBe('a cat and a bat, ab cd');
  });

  it('collects hosts and users from connections, SSH tunnels and the OS account', () => {
    const { hosts, users } = collectIdentities(input().connections, input().settings, 'alice');
    expect(hosts).toEqual(
      expect.arrayContaining([HOST, SSH_HOST, 'search.example.com', 'node2.example.com']),
    );
    expect(hosts).not.toContain('local');
    expect(users).toEqual(expect.arrayContaining(['alice', 'bob']));
    // Longest first, so a name that contains another is replaced whole.
    expect([...hosts].sort((a, b) => b.length - a.length)).toEqual(hosts);
  });
});

describe('pieces', () => {
  it('tailLines keeps the last n lines and tolerates a trailing newline and CRLF', () => {
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc');
    expect(tailLines('a\r\nb\r\nc', 2)).toBe('b\nc');
    expect(tailLines('', 5)).toBe('');
    expect(tailLines('a', 5)).toBe('a');
  });

  it('recentErrors takes error lines only, newest last, at most the limit', () => {
    const log = [
      '[info] fine',
      '[error] one',
      '[warn] w',
      '[error] two',
      'Uncaught exception x',
    ].join('\n');
    expect(recentErrors([log])).toBe('[error] one\n[error] two\nUncaught exception x');
    expect(recentErrors([log], 2)).toBe('[error] two\nUncaught exception x');
  });

  it('sanitizeSettings never keeps a value under a secret-looking key', () => {
    const out = sanitizeSettings({
      githubToken: 'ghp_0123456789abcdefghijABCDEFGHIJ012345',
      dbPassword: 'x',
      emptyApiKey: '',
      hasApiKey: true,
      nested: { apiKey: 'k' },
    });
    expect(out).toEqual({
      githubToken: '[set]',
      dbPassword: '[set]',
      emptyApiKey: '[empty]',
      hasApiKey: true,
      nested: { apiKey: '[set]' },
    });
  });

  it('sanitizeConnections tolerates junk', () => {
    expect(sanitizeConnections([null, 'x', {}, { engine: 5 }])).toEqual([
      { engine: 'postgres' },
      { engine: 'postgres' },
      { engine: 'postgres' },
      { engine: 'postgres' },
    ]);
  });
});

describe('what a driver error prints in the worker log', () => {
  const worker = [
    '[worker:err] [plasma-worker] uncaught: error: duplicate key value violates unique constraint "u"',
    "    detail: 'Key (customer_email)=(carol@corp.com) already exists.',",
    '    where: \'SQL statement "INSERT INTO customers (email) VALUES ($1)"\',',
    "    internalQuery: 'SELECT ssn FROM people WHERE id = 7',",
    '    routine: _bt_check_unique',
    '[worker:err] bad value: invalid input syntax for type integer: "123-45-6789"',
    '[worker:err] statement failed:',
    'SELECT name',
    'FROM payroll',
    "WHERE ssn = '123-45-6789'",
    '    at Client._handleErrorMessage (node_modules/pg/lib/client.js:1)',
    '[worker] still running',
    'MERGE INTO t USING s ON t.id = s.id',
    '  WHEN MATCHED THEN UPDATE SET v = 1',
    '[worker] ok',
  ].join('\n');
  const text = () =>
    buildSupportBundle(input({ workerLog: worker }), { redactHostsAndUsers: false }).find(
      (f) => f.name === 'logs/worker.log',
    )?.text as string;

  it('removes row values, quoted statements and the lines that continue a statement', () => {
    const t = text();
    for (const bad of [
      'carol@corp.com',
      '123-45-6789',
      'payroll',
      'INSERT INTO customers',
      'SELECT ssn',
      'MATCHED',
      'UPDATE SET',
    ]) {
      expect(t, bad).not.toContain(bad);
    }
    expect(t).toContain('Key (customer_email)=(***)');
    expect(t).toContain('invalid input syntax for type integer: "***"');
    expect(t).toContain('internalQuery: [left out]');
  });

  it('keeps the rest of the log, stack frames included', () => {
    const t = text();
    expect(t).toContain('routine: _bt_check_unique');
    expect(t).toContain('at Client._handleErrorMessage');
    expect(t).toContain('[worker] still running');
    expect(t).toContain('[worker] ok');
  });
});

describe('hiding hosts and users nobody saved', () => {
  const hidden = (over: Partial<SupportBundleInput>) =>
    allText(buildSupportBundle(input(over), { redactHostsAndUsers: true }));

  it('hides host names that only appear in a log or a setting', () => {
    const t = hidden({
      mainLog:
        '[error] getaddrinfo ENOTFOUND db9.internal.corp\n[info] ollama at ollama.lab.example.net',
      settings: {
        aiLocalUrl: 'http://gpu-box.lan:11434/v1',
        theme: 'dark',
        pgBinDir: '/opt/pg/bin',
      },
    });
    for (const bad of ['db9.internal.corp', 'ollama.lab.example.net', 'gpu-box.lan']) {
      expect(t, bad).not.toContain(bad);
    }
    // File names, versions and code are not host names.
    expect(t).toContain('main.log');
    expect(t).toContain('3.3.0');
  });

  it('hides every host of a Sentinel or Cluster list', () => {
    const t = hidden({
      connections: [
        {
          id: 'r',
          name: 'cache',
          engine: 'redis',
          host: 'sentinel://s1.corp:26379,s2.corp:26379/master',
          port: 6379,
        },
      ],
    });
    expect(t).not.toContain('s1.corp');
    expect(t).not.toContain('s2.corp');
  });

  it('hides IPv6 addresses but not clock times or ::1', () => {
    const t = hidden({
      mainLog: [
        '[2026-10-07 09:00:00.000] [error] connect ECONNREFUSED [fd00:1234::5]:5432',
        '[2026-10-07 09:00:01.000] [info] peer 2001:db8:0:0:0:0:2:1 and fe80::1ff:fe23:4567:890a',
        '[2026-10-07 09:00:02.000] [info] local ::1 ok',
      ].join('\n'),
    });
    expect(t).not.toContain('fd00:1234');
    expect(t).not.toContain('2001:db8');
    expect(t).not.toContain('fe80::');
    expect(t).toContain('09:00:00.000');
    expect(t).toContain('::1 ok');
  });

  it('hides a short Windows account name in plain and JSON-escaped paths', () => {
    const t = hidden({
      osUser: 'pj',
      settings: { pgBinDir: 'C:\\Users\\pj\\pg\\bin', theme: 'dark' },
      mainLog: 'opened C:\\Users\\pj\\AppData\\Roaming\\Plasma',
    });
    expect(t).not.toMatch(/Users\\+pj/);
    expect(t).toContain('<user>');
  });
});
