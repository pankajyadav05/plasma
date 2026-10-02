import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type FetchLike,
  checkDownloadedFile,
  checkOfferAgainstSigned,
  compareVersions,
  manifestNameFor,
  parseManifest,
  sha512OfFile,
  signaturePolicy,
  verifyFeed,
  verifyManifestSignature,
} from './update-signing';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const OTHER = generateKeyPairSync('ed25519')
  .publicKey.export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('base64');

const signText = (text: string) => sign(null, Buffer.from(text), privateKey).toString('base64');

const MANIFEST = `version: 3.1.0
files:
  - url: Plasma-Setup-3.1.0-x64.exe
    sha512: AAAA+/==
    size: 100
  - url: Plasma-3.1.0-arm64.dmg
    sha512: BBBB
    size: 200
path: Plasma-Setup-3.1.0-x64.exe
sha512: AAAA+/==
releaseDate: '2026-10-02T00:00:00.000Z'
`;

describe('verifyManifestSignature', () => {
  it('accepts a signature made over the exact bytes', () => {
    expect(verifyManifestSignature(MANIFEST, signText(MANIFEST), PUBLIC)).toBe(true);
  });

  it('rejects a changed manifest, another key and garbage', () => {
    const sig = signText(MANIFEST);
    expect(verifyManifestSignature(MANIFEST.replace('AAAA', 'EVIL'), sig, PUBLIC)).toBe(false);
    expect(verifyManifestSignature(MANIFEST, sig, OTHER)).toBe(false);
    expect(verifyManifestSignature(MANIFEST, 'not a signature', PUBLIC)).toBe(false);
    expect(verifyManifestSignature(MANIFEST, sig, 'short')).toBe(false);
  });
});

describe('parseManifest', () => {
  it('reads the version and every file with its sha512', () => {
    expect(parseManifest(MANIFEST)).toEqual({
      version: '3.1.0',
      files: [
        { url: 'Plasma-Setup-3.1.0-x64.exe', sha512: 'AAAA+/==', size: 100 },
        { url: 'Plasma-3.1.0-arm64.dmg', sha512: 'BBBB', size: 200 },
      ],
    });
  });

  it('returns no manifest without a version', () => {
    expect(parseManifest('files: []')).toBeNull();
  });
});

describe('signaturePolicy / compareVersions', () => {
  it('orders versions numerically with pre-releases first', () => {
    expect(compareVersions('3.0.9', '3.1.0')).toBe(-1);
    expect(compareVersions('3.10.0', '3.9.0')).toBe(1);
    expect(compareVersions('3.1.0-beta.1', '3.1.0')).toBe(-1);
    expect(compareVersions('3.1.0', '3.1.0')).toBe(0);
  });

  it('is a no-op without a key, verifies when a signature exists, and sunsets unsigned', () => {
    const base = { requiredFrom: '3.1.0', updateVersion: '3.0.5' };
    expect(signaturePolicy({ ...base, hasKey: false, hasSignature: false })).toBe('unconfigured');
    expect(signaturePolicy({ ...base, hasKey: true, hasSignature: true })).toBe('verify');
    expect(signaturePolicy({ ...base, hasKey: true, hasSignature: false })).toBe('allow-unsigned');
    expect(
      signaturePolicy({ ...base, updateVersion: '3.1.0', hasKey: true, hasSignature: false }),
    ).toBe('refuse-unsigned');
    expect(
      signaturePolicy({ ...base, updateVersion: '4.0.0', hasKey: true, hasSignature: false }),
    ).toBe('refuse-unsigned');
  });
});

describe('checkOfferAgainstSigned', () => {
  const signed = parseManifest(MANIFEST) as NonNullable<ReturnType<typeof parseManifest>>;
  it('passes when version and hashes agree', () => {
    expect(
      checkOfferAgainstSigned(
        { version: '3.1.0', files: [{ url: 'Plasma-Setup-3.1.0-x64.exe', sha512: 'AAAA+/==' }] },
        signed,
      ),
    ).toBeNull();
  });

  it('refuses another version, an unknown file and a different hash', () => {
    const file = { url: 'Plasma-Setup-3.1.0-x64.exe', sha512: 'AAAA+/==' };
    expect(checkOfferAgainstSigned({ version: '9.9.9', files: [file] }, signed)).toMatch(/version/);
    expect(
      checkOfferAgainstSigned({ version: '3.1.0', files: [{ ...file, url: 'evil.exe' }] }, signed),
    ).toMatch(/not in the signed manifest/);
    expect(
      checkOfferAgainstSigned({ version: '3.1.0', files: [{ ...file, sha512: 'EVIL' }] }, signed),
    ).toMatch(/differs/);
    expect(checkOfferAgainstSigned({ version: '3.1.0', files: [] }, signed)).toMatch(/no files/);
  });
});

describe('checkDownloadedFile', () => {
  it('matches the downloaded bytes to the signed sha512', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plasma-sign-'));
    try {
      const file = join(dir, 'Plasma-Setup-3.1.0-x64.exe');
      writeFileSync(file, 'installer bytes');
      const digest = createHash('sha512').update('installer bytes').digest('base64');
      expect(await sha512OfFile(file)).toBe(digest);
      const signed = {
        version: '3.1.0',
        files: [{ url: 'Plasma-Setup-3.1.0-x64.exe', sha512: digest }],
      };
      expect(await checkDownloadedFile(file, signed)).toBeNull();
      writeFileSync(file, 'tampered');
      expect(await checkDownloadedFile(file, signed)).toMatch(/does not match/);
      expect(await checkDownloadedFile(join(dir, 'other.exe'), signed)).toMatch(
        /not in the signed/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('manifestNameFor', () => {
  it('maps platforms to electron-builder manifest names', () => {
    expect(manifestNameFor('win32', 'x64')).toBe('latest.yml');
    expect(manifestNameFor('darwin', 'arm64')).toBe('latest-mac.yml');
    expect(manifestNameFor('linux', 'x64')).toBe('latest-linux.yml');
    expect(manifestNameFor('linux', 'arm64')).toBe('latest-linux-arm64.yml');
  });
});

describe('verifyFeed', () => {
  const FEED = 'https://cdn.example.com';
  const offered = {
    version: '3.1.0',
    files: [{ url: 'Plasma-Setup-3.1.0-x64.exe', sha512: 'AAAA+/==' }],
  };

  const feed =
    (files: Record<string, { status: number; body?: string }>): FetchLike =>
    async (url) => {
      const key = url.replace(`${FEED}/`, '').replace(/\?.*$/, '');
      const hit = files[key] ?? { status: 404 };
      return { ok: hit.status < 400, status: hit.status, text: async () => hit.body ?? '' };
    };

  const run = (
    files: Record<string, { status: number; body?: string }>,
    over: Partial<Parameters<typeof verifyFeed>[0]> = {},
  ) =>
    verifyFeed({
      feedBase: FEED,
      manifestName: 'latest.yml',
      offered,
      publicKey: PUBLIC,
      requiredFrom: '3.1.0',
      fetchText: feed(files),
      ...over,
    });

  it('does nothing when no public key is embedded', async () => {
    expect(await run({}, { publicKey: null })).toEqual({ status: 'unconfigured' });
  });

  it('verifies a correctly signed manifest', async () => {
    const verdict = await run({
      'latest.yml': { status: 200, body: MANIFEST },
      'latest.yml.sig': { status: 200, body: signText(MANIFEST) },
    });
    expect(verdict.status).toBe('verified');
  });

  it('refuses a manifest that was altered after signing', async () => {
    const tampered = MANIFEST.replace('AAAA+/==', 'EVIL');
    const verdict = await run({
      'latest.yml': { status: 200, body: tampered },
      'latest.yml.sig': { status: 200, body: signText(MANIFEST) },
    });
    expect(verdict).toMatchObject({ status: 'refused', reason: expect.stringMatching(/invalid/) });
  });

  it('refuses when the signed manifest disagrees with what the updater parsed', async () => {
    const verdict = await run(
      {
        'latest.yml': { status: 200, body: MANIFEST },
        'latest.yml.sig': { status: 200, body: signText(MANIFEST) },
      },
      { offered: { ...offered, files: [{ url: offered.files[0]?.url ?? '', sha512: 'EVIL' }] } },
    );
    expect(verdict.status).toBe('refused');
  });

  it('tolerates a missing .sig only below the cut-off version', async () => {
    const files = { 'latest.yml': { status: 200, body: MANIFEST } };
    expect((await run(files, { offered: { version: '3.0.5' } })).status).toBe('unsigned-allowed');
    expect((await run(files)).status).toBe('refused');
  });

  it('refuses a .sig that exists but cannot be read reliably', async () => {
    const verdict = await run({
      'latest.yml': { status: 200, body: MANIFEST },
      'latest.yml.sig': { status: 500 },
    });
    expect(verdict.status).toBe('refused');
  });

  it('turns network failures into a refusal, never a throw', async () => {
    const verdict = await run(
      {},
      {
        fetchText: async () => {
          throw new Error('offline');
        },
      },
    );
    expect(verdict).toMatchObject({ status: 'refused' });
  });
});
