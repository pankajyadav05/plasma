import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Classifies the code signature of the running macOS app bundle.
 *
 * Squirrel.Mac — the installer behind `electron-updater` on macOS — takes the
 * *running* app's designated requirement and validates every downloaded update
 * against it (Squirrel.Mac, `Squirrel/SQRLCodeSignature.m`):
 *
 *   SecCodeCopyDesignatedRequirement(self, …)              ← installed app
 *   SecStaticCodeCheckValidityWithErrors(newApp,
 *     kSecCSCheckNestedCode | kSecCSStrictValidate |
 *     kSecCSCheckAllArchitectures, requirement, …)         ← downloaded app
 *
 * Two consequences for builds packaged with `identity: null`:
 *
 *  - The assembled bundle is never signed, so it has no
 *    `Contents/_CodeSignature/CodeResources`, while Electron's own prebuilt
 *    Mach-Os keep the ad-hoc signature Apple requires for arm64 code to run
 *    at all. Strict validation of that mix fails with
 *    "code has no resources but signature indicates they must be present" —
 *    the error users see when they click "Check for updates".
 *  - Ad-hoc signing the whole bundle would not help either: an ad-hoc
 *    designated requirement is `cdhash H"…"`, a hash of that exact build, so
 *    no future version can ever satisfy the installed app's requirement.
 *
 * Only a certificate-backed signature (Developer ID) yields a requirement
 * stable across releases (`identifier … and anchor apple generic and
 * certificate leaf[subject.OU] = …`). The updater therefore asks this module
 * whether a Squirrel install can possibly succeed, and degrades to a manual
 * download when it cannot — instead of burning bandwidth on a payload
 * ShipIt will reject.
 */
export type MacSignatureKind =
  /** Signed by a real identity — designated requirement survives new releases. */
  | 'certificate'
  /** Ad-hoc signed bundle — cdhash requirement, unique to this build. */
  | 'adhoc'
  /** Mach-O carries a signature, bundle was never signed (electron-builder `identity: null`). */
  | 'bundle-unsigned'
  /** No embedded signature at all (x64 Electron binaries out of the box). */
  | 'unsigned'
  /** Executable missing or not a parseable Mach-O. */
  | 'unreadable';

// Mach-O / code-signing on-disk constants (mach-o/loader.h, mach-o/fat.h,
// Security/CSCommon.h). Fat headers and every code-signing blob are
// big-endian regardless of the slice's own byte order.
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CSSLOT_CODEDIRECTORY = 0;
const CSSLOT_SIGNATURESLOT = 0x10000;
const CS_ADHOC = 0x0000_0002;
/** A blob with a header and no payload: magic + length. */
const EMPTY_BLOB_LENGTH = 8;

type SliceSignature = 'certificate' | 'adhoc' | 'unsigned';

/**
 * Reads the app bundle's signature state from its main executable plus the
 * bundle-level resource envelope. Pure filesystem work — no `codesign`
 * subprocess, which is an Xcode Command Line Tools shim in `/usr/bin` and
 * therefore absent on stock user machines.
 *
 * @param exePath `…/Plasma.app/Contents/MacOS/Plasma` (`app.getPath('exe')`)
 */
export function classifyMacAppSignature(exePath: string): MacSignatureKind {
  let buf: Buffer;
  try {
    buf = readFileSync(exePath);
  } catch {
    return 'unreadable';
  }

  const slices = machoSliceOffsets(buf);
  if (slices.length === 0) return 'unreadable';

  const perSlice = slices.map((offset) => classifySlice(buf, offset));
  if (perSlice.every((kind) => kind === 'unsigned')) return 'unsigned';

  // Contents/MacOS/<exe> → Contents/_CodeSignature/CodeResources
  if (!existsSync(join(dirname(exePath), '..', '_CodeSignature', 'CodeResources'))) {
    return 'bundle-unsigned';
  }

  return perSlice.every((kind) => kind === 'certificate') ? 'certificate' : 'adhoc';
}

/** Byte offsets of the Mach-O images in a thin or fat file. */
function machoSliceOffsets(buf: Buffer): number[] {
  if (buf.length < 32) return [];

  const magic = buf.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return [0];

  const wide = magic === FAT_MAGIC_64;
  const stride = wide ? 32 : 20;
  const count = buf.readUInt32BE(4);
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 8 + i * stride;
    if (entry + stride > buf.length) break;
    const offset = wide ? Number(buf.readBigUInt64BE(entry + 8)) : buf.readUInt32BE(entry + 8);
    if (offset + 32 <= buf.length) offsets.push(offset);
  }
  return offsets;
}

function classifySlice(buf: Buffer, slice: number): SliceSignature {
  const command = findCodeSignatureCommand(buf, slice);
  if (command == null) return 'unsigned';

  const superBlob = command.offset;
  if (superBlob + 12 > buf.length) return 'unsigned';
  if (buf.readUInt32BE(superBlob) !== CSMAGIC_EMBEDDED_SIGNATURE) return 'unsigned';

  const count = buf.readUInt32BE(superBlob + 8);
  let hasCodeDirectory = false;
  let adhoc = false;
  let cmsLength = 0;

  for (let i = 0; i < count; i++) {
    const index = superBlob + 12 + i * 8;
    if (index + 8 > buf.length) break;
    const type = buf.readUInt32BE(index);
    const blob = superBlob + buf.readUInt32BE(index + 4);
    if (blob + 8 > buf.length) continue;

    if (type === CSSLOT_CODEDIRECTORY && buf.readUInt32BE(blob) === CSMAGIC_CODEDIRECTORY) {
      if (blob + 16 > buf.length) continue;
      hasCodeDirectory = true;
      adhoc = (buf.readUInt32BE(blob + 12) & CS_ADHOC) !== 0;
    } else if (type === CSSLOT_SIGNATURESLOT) {
      const length = buf.readUInt32BE(blob + 4);
      // Trust the declared length only when the payload is really there: a
      // truncated file must never read as certificate-signed.
      if (blob + length <= buf.length) cmsLength = length;
    }
  }

  if (!hasCodeDirectory) return 'unsigned';
  // A CMS blob with a payload carries the certificate chain that signed this
  // slice. Ad-hoc signatures emit the slot empty and set CS_ADHOC.
  return !adhoc && cmsLength > EMPTY_BLOB_LENGTH ? 'certificate' : 'adhoc';
}

function findCodeSignatureCommand(
  buf: Buffer,
  slice: number,
): { offset: number; size: number } | null {
  const magic = buf.readUInt32BE(slice);
  const little = magic === MH_CIGAM_64;
  // 32-bit slices cannot run on any macOS that Electron supports.
  if (!little && magic !== MH_MAGIC_64) return null;

  const read = (offset: number) => (little ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset));

  const ncmds = read(slice + 16);
  let cursor = slice + 32;
  for (let i = 0; i < ncmds; i++) {
    if (cursor + 8 > buf.length) return null;
    const cmd = read(cursor);
    const size = read(cursor + 4);
    if (size < 8) return null;
    if (cmd === LC_CODE_SIGNATURE) {
      if (cursor + 16 > buf.length) return null;
      return { offset: slice + read(cursor + 8), size: read(cursor + 12) };
    }
    cursor += size;
  }
  return null;
}
