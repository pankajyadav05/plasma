import { createHash, createPublicKey, verify } from 'node:crypto';
import { closeSync, createReadStream, openSync, readSync } from 'node:fs';

/**
 * Detached ed25519 signatures over the update manifests (SC-01).
 *
 * The update feed is a public bucket, so `latest.yml` (which carries the
 * installer's sha512) proves nothing by itself: whoever can write the bucket
 * can publish a matching hash. The release machine therefore signs the exact
 * manifest bytes with a private key that never leaves it
 * (`scripts/upload-release.mjs`), publishes `<manifest>.sig` next to it, and
 * the app pins the public key (`update-signing-key.ts`). Before downloading or
 * offering an update the app checks:
 *
 *   1. the signature over the manifest bytes,
 *   2. that what electron-updater parsed (version + per-file sha512) is what
 *      the signed manifest says, and
 *   3. after the download, that the file on disk hashes to the signed sha512.
 *
 * Pure helpers only (plus a streaming file hash) so everything is unit
 * testable without Electron.
 */

/** DER prefix of an ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type ManifestFile = { url: string; sha512: string; size?: number };
export type ParsedManifest = { version: string; files: ManifestFile[] };

/** Manifest file name for a platform/arch, as electron-builder emits it. */
export function manifestNameFor(platform: string, arch: string): string {
  if (platform === 'darwin') return 'latest-mac.yml';
  if (platform === 'linux') return arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml';
  return 'latest.yml';
}

/** Verify a base64 detached signature over `manifest` with a raw base64 public key. */
export function verifyManifestSignature(
  manifest: Buffer | string,
  signatureBase64: string,
  publicKeyBase64: string,
): boolean {
  try {
    const raw = Buffer.from(publicKeyBase64.trim(), 'base64');
    if (raw.length !== 32) return false;
    const signature = Buffer.from(signatureBase64.trim(), 'base64');
    if (signature.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    const data = typeof manifest === 'string' ? Buffer.from(manifest, 'utf8') : manifest;
    return verify(null, data, key, signature);
  } catch {
    return false;
  }
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

/**
 * Reads `version` and the `files:` list out of an electron-builder manifest.
 * Deliberately tiny and strict: it only has to understand the shape
 * electron-builder writes, and anything else yields no files (which then
 * fails the cross-check instead of passing it).
 */
export function parseManifest(text: string): ParsedManifest | null {
  const version = /^version:[ \t]*(\S.*)$/m.exec(text)?.[1];
  if (version == null) return null;
  const files: ManifestFile[] = [];
  let current: Partial<ManifestFile> | null = null;
  let inFiles = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (inFiles && /^\S/.test(line)) inFiles = false;
    if (!inFiles) continue;
    const item = /^\s*-\s+url:[ \t]*(\S.*)$/.exec(line);
    if (item?.[1] != null) {
      if (current?.url && current.sha512) files.push(current as ManifestFile);
      current = { url: unquote(item[1]) };
      continue;
    }
    const field = /^\s+(sha512|size):[ \t]*(\S.*)$/.exec(line);
    if (field?.[1] != null && field[2] != null && current) {
      if (field[1] === 'sha512') current.sha512 = unquote(field[2]);
      else current.size = Number(unquote(field[2]));
    }
  }
  if (current?.url && current.sha512) files.push(current as ManifestFile);
  return { version: unquote(version), files };
}

/** Compares `a.b.c` versions (a pre-release suffix sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-', 2);
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre == null) return 1;
  if (y.pre == null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export type SignaturePolicy =
  /** No key embedded in this build: nothing can be verified. */
  | 'unconfigured'
  /** A signature exists: it must verify. */
  | 'verify'
  /** No signature, but the update predates the cut-off: allow with a warning. */
  | 'allow-unsigned'
  /** No signature on an update that must be signed. */
  | 'refuse-unsigned';

export function signaturePolicy(input: {
  hasKey: boolean;
  hasSignature: boolean;
  updateVersion: string;
  requiredFrom: string;
}): SignaturePolicy {
  if (!input.hasKey) return 'unconfigured';
  if (input.hasSignature) return 'verify';
  return compareVersions(input.updateVersion, input.requiredFrom) < 0
    ? 'allow-unsigned'
    : 'refuse-unsigned';
}

/** What electron-updater parsed out of the (unauthenticated) manifest. */
export type OfferedUpdate = { version: string; files?: { url: string; sha512: string }[] | null };

/**
 * Cross-checks the update electron-updater is about to download against the
 * signed manifest. Returns a reason to refuse, or null when they agree. The
 * manifest is fetched twice (once by electron-updater, once by us), so a
 * mismatch also catches a feed that changed between the two reads.
 */
export function checkOfferAgainstSigned(
  offered: OfferedUpdate,
  signed: ParsedManifest,
): string | null {
  if (offered.version !== signed.version) {
    return `version ${offered.version} is not the signed version ${signed.version}`;
  }
  const offeredFiles = offered.files ?? [];
  if (offeredFiles.length === 0) return 'the update lists no files';
  for (const file of offeredFiles) {
    const match = signed.files.find((f) => f.url === file.url);
    if (match == null) return `${file.url} is not in the signed manifest`;
    if (match.sha512 !== file.sha512)
      return `sha512 of ${file.url} differs from the signed manifest`;
  }
  return null;
}

/** Base64 sha512 of a file, streamed (installers are 100 MB+). */
export function sha512OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')));
  });
}

/** Base64 sha512 of a file, synchronously (for the quit path, which cannot wait). */
export function sha512OfFileSync(path: string): string {
  const hash = createHash('sha512');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('base64');
}

/** Synchronous `checkDownloadedFile`: a reason to refuse, or null. Never throws. */
export function checkDownloadedFileSync(filePath: string, signed: ParsedManifest): string | null {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const match = signed.files.find((f) => f.url === name || decodeURIComponent(f.url) === name);
  if (match == null) return `${name} is not in the signed manifest`;
  try {
    return sha512OfFileSync(filePath) === match.sha512
      ? null
      : `${name} does not match the signed sha512`;
  } catch (err) {
    return `could not read ${name} (${err instanceof Error ? err.message : String(err)})`;
  }
}

/** Checks a downloaded file against the sha512 the signed manifest lists for it. */
export async function checkDownloadedFile(
  filePath: string,
  signed: ParsedManifest,
  hashFile: (path: string) => Promise<string> = sha512OfFile,
): Promise<string | null> {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const match = signed.files.find((f) => f.url === name || decodeURIComponent(f.url) === name);
  if (match == null) return `${name} is not in the signed manifest`;
  const actual = await hashFile(filePath);
  return actual === match.sha512 ? null : `${name} does not match the signed sha512`;
}

export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type FeedVerification =
  | { status: 'unconfigured' }
  | { status: 'unsigned-allowed'; reason: string }
  | { status: 'verified'; manifest: ParsedManifest }
  | { status: 'refused'; reason: string };

/**
 * Fetches `<feed>/<manifest>` and its `.sig`, applies the transition policy
 * and the signature check, and cross-checks the offered update. Never
 * throws: any failure is a `refused` result, because an update that cannot
 * be authenticated must not be installed.
 */
export async function verifyFeed(input: {
  feedBase: string | null;
  manifestName: string;
  offered: OfferedUpdate;
  publicKey: string | null;
  requiredFrom: string;
  fetchText: FetchLike;
}): Promise<FeedVerification> {
  const { feedBase, manifestName, offered, publicKey, requiredFrom, fetchText } = input;
  if (publicKey == null) return { status: 'unconfigured' };
  if (feedBase == null) {
    return { status: 'refused', reason: 'the update feed URL is unknown, cannot verify it' };
  }
  const base = `${feedBase}/${manifestName}`;
  const bust = `?noCache=${Date.now()}`;
  try {
    const manifestRes = await fetchText(base + bust);
    if (!manifestRes.ok) {
      return { status: 'refused', reason: `${manifestName} returned HTTP ${manifestRes.status}` };
    }
    const manifestText = await manifestRes.text();
    const sigRes = await fetchText(`${base}.sig${bust}`);
    let signature: string | null = null;
    if (sigRes.ok) signature = await sigRes.text();
    else if (sigRes.status !== 404 && sigRes.status !== 403) {
      // Not "no signature published": the fetch itself is unreliable.
      return { status: 'refused', reason: `${manifestName}.sig returned HTTP ${sigRes.status}` };
    }

    const policy = signaturePolicy({
      hasKey: true,
      hasSignature: signature != null,
      updateVersion: offered.version,
      requiredFrom,
    });
    if (policy === 'refuse-unsigned') {
      return {
        status: 'refused',
        reason: `${manifestName} for ${offered.version} has no signature (required from ${requiredFrom})`,
      };
    }
    if (policy === 'allow-unsigned') {
      return { status: 'unsigned-allowed', reason: `${manifestName}.sig is not published` };
    }
    if (signature == null || !verifyManifestSignature(manifestText, signature, publicKey)) {
      return { status: 'refused', reason: `${manifestName} signature is invalid` };
    }
    const manifest = parseManifest(manifestText);
    if (manifest == null) return { status: 'refused', reason: `${manifestName} is malformed` };
    const mismatch = checkOfferAgainstSigned(offered, manifest);
    if (mismatch != null) return { status: 'refused', reason: mismatch };
    return { status: 'verified', manifest };
  } catch (err) {
    return {
      status: 'refused',
      reason: `could not fetch the signed manifest: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
