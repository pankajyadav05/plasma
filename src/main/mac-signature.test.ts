import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyMacAppSignature } from './mac-signature';

/**
 * The updater's macOS branch hangs off this classification: a build that is
 * not certificate-signed can never install its own updates, because
 * Squirrel.Mac validates the download against the installed app's designated
 * requirement. Getting the classification wrong either revives the cryptic
 * ShipIt failure ("code has no resources but signature indicates they must be
 * present") or permanently disables auto-update on properly signed builds.
 *
 * Fixtures are synthesized Mach-Os: the shapes below are exactly what
 * `codesign` and the Electron distribution produce, minus the payload bytes
 * this code never reads.
 */

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CSMAGIC_BLOBWRAPPER = 0xfade0b01;
const CSSLOT_SIGNATURESLOT = 0x10000;
const CS_ADHOC = 0x0000_0002;

/** Embedded signature superblob: CodeDirectory + CMS wrapper. */
function embeddedSignature({ adhoc, certBytes }: { adhoc: boolean; certBytes: number }): Buffer {
  const directory = Buffer.alloc(44);
  directory.writeUInt32BE(CSMAGIC_CODEDIRECTORY, 0);
  directory.writeUInt32BE(directory.length, 4);
  directory.writeUInt32BE(0x00020400, 8); // version
  directory.writeUInt32BE(adhoc ? CS_ADHOC : 0, 12); // flags

  const cms = Buffer.alloc(8 + certBytes);
  cms.writeUInt32BE(CSMAGIC_BLOBWRAPPER, 0);
  cms.writeUInt32BE(cms.length, 4);

  const header = Buffer.alloc(12 + 2 * 8);
  const directoryOffset = header.length;
  const cmsOffset = directoryOffset + directory.length;
  header.writeUInt32BE(CSMAGIC_EMBEDDED_SIGNATURE, 0);
  header.writeUInt32BE(header.length + directory.length + cms.length, 4);
  header.writeUInt32BE(2, 8); // slot count
  header.writeUInt32BE(0, 12); // CSSLOT_CODEDIRECTORY
  header.writeUInt32BE(directoryOffset, 16);
  header.writeUInt32BE(CSSLOT_SIGNATURESLOT, 20);
  header.writeUInt32BE(cmsOffset, 24);

  return Buffer.concat([header, directory, cms]);
}

/** 64-bit little-endian Mach-O, optionally carrying LC_CODE_SIGNATURE. */
function machO(signature: Buffer | null): Buffer {
  const commands = Buffer.alloc(signature == null ? 0 : 16);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(MH_MAGIC_64, 0);
  header.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  header.writeUInt32LE(2, 12); // MH_EXECUTE
  header.writeUInt32LE(signature == null ? 0 : 1, 16); // ncmds
  header.writeUInt32LE(commands.length, 20);

  if (signature == null) return Buffer.concat([header, Buffer.alloc(64)]);

  const text = Buffer.alloc(64); // stand-in for the code the signature covers
  const dataOffset = header.length + commands.length + text.length;
  commands.writeUInt32LE(LC_CODE_SIGNATURE, 0);
  commands.writeUInt32LE(commands.length, 4);
  commands.writeUInt32LE(dataOffset, 8);
  commands.writeUInt32LE(signature.length, 12);

  return Buffer.concat([header, commands, text, signature]);
}

/** Fat wrapper — universal builds sign each slice separately. */
function fat(slices: Buffer[]): Buffer {
  const header = Buffer.alloc(8 + slices.length * 20);
  header.writeUInt32BE(FAT_MAGIC, 0);
  header.writeUInt32BE(slices.length, 4);

  let offset = header.length;
  const parts: Buffer[] = [];
  slices.forEach((slice, i) => {
    const entry = 8 + i * 20;
    header.writeUInt32BE(offset, entry + 8);
    header.writeUInt32BE(slice.length, entry + 12);
    parts.push(slice);
    offset += slice.length;
  });

  return Buffer.concat([header, ...parts]);
}

const roots: string[] = [];

function bundle(executable: Buffer, { codeResources }: { codeResources: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'plasma-sig-'));
  roots.push(root);
  const contents = join(root, 'Plasma.app', 'Contents');
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  const exePath = join(contents, 'MacOS', 'Plasma');
  writeFileSync(exePath, executable);
  if (codeResources) {
    mkdirSync(join(contents, '_CodeSignature'), { recursive: true });
    writeFileSync(join(contents, '_CodeSignature', 'CodeResources'), '<plist/>');
  }
  return exePath;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('classifyMacAppSignature', () => {
  it('reports the shipped unsigned-mac state: signed Mach-O, unsigned bundle', () => {
    // What `identity: null` leaves behind on arm64: Electron's prebuilt
    // binaries keep their ad-hoc signature, nothing ever signs the bundle, so
    // strict validation trips on the missing resource envelope.
    const exePath = bundle(machO(embeddedSignature({ adhoc: true, certBytes: 0 })), {
      codeResources: false,
    });
    expect(classifyMacAppSignature(exePath)).toBe('bundle-unsigned');
  });

  it('reports an ad-hoc signed bundle', () => {
    const exePath = bundle(machO(embeddedSignature({ adhoc: true, certBytes: 0 })), {
      codeResources: true,
    });
    expect(classifyMacAppSignature(exePath)).toBe('adhoc');
  });

  it('reports a certificate-signed bundle', () => {
    const exePath = bundle(machO(embeddedSignature({ adhoc: false, certBytes: 2048 })), {
      codeResources: true,
    });
    expect(classifyMacAppSignature(exePath)).toBe('certificate');
  });

  it('reports x64 Electron binaries with no signature at all as unsigned', () => {
    const exePath = bundle(machO(null), { codeResources: true });
    expect(classifyMacAppSignature(exePath)).toBe('unsigned');
  });

  it('does not trust a universal binary whose slices are not all signed', () => {
    // Squirrel validates with kSecCSCheckAllArchitectures, so one ad-hoc
    // slice sinks the whole bundle.
    const exePath = bundle(
      fat([
        machO(embeddedSignature({ adhoc: false, certBytes: 2048 })),
        machO(embeddedSignature({ adhoc: true, certBytes: 0 })),
      ]),
      { codeResources: true },
    );
    expect(classifyMacAppSignature(exePath)).toBe('adhoc');
  });

  it('accepts a universal binary signed on every slice', () => {
    const exePath = bundle(
      fat([
        machO(embeddedSignature({ adhoc: false, certBytes: 2048 })),
        machO(embeddedSignature({ adhoc: false, certBytes: 2048 })),
      ]),
      { codeResources: true },
    );
    expect(classifyMacAppSignature(exePath)).toBe('certificate');
  });

  it('reports a missing executable instead of throwing', () => {
    expect(classifyMacAppSignature(join(tmpdir(), 'plasma-does-not-exist', 'Plasma'))).toBe(
      'unreadable',
    );
  });

  it('never reads a truncated signature as certificate-signed', () => {
    const full = machO(embeddedSignature({ adhoc: false, certBytes: 2048 }));
    const exePath = bundle(full.subarray(0, full.length - 1024), { codeResources: true });
    expect(classifyMacAppSignature(exePath)).toBe('adhoc');
  });
});
