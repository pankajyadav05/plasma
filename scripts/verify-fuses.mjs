#!/usr/bin/env node
/**
 * Asserts that a packaged Plasma binary has the hardened Electron fuses (SC-28).
 *
 *   node scripts/verify-fuses.mjs release/linux-unpacked/plasma.bin
 *   node scripts/verify-fuses.mjs "release/win-unpacked/Plasma.exe"
 *   node scripts/verify-fuses.mjs release/mac-arm64/Plasma.app
 *
 * The expected values mirror `electronFuses` in electron-builder.yml.
 */
import fuses from '@electron/fuses';

const { FuseV1Options, getCurrentFuseWire } = fuses;

// @electron/fuses 1.x reports the raw wire bytes ('0' = 48, '1' = 49); newer
// releases report 0 / 1 enum values. Accept both.
const isEnabled = (state) => state === 49 || state === 1;
const isDisabled = (state) => state === 48 || state === 0;

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/verify-fuses.mjs <packaged electron binary or .app>');
  process.exit(2);
}

const expected = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
};

const wire = await getCurrentFuseWire(target);
let bad = 0;
for (const [option, want] of Object.entries(expected)) {
  const state = wire[option];
  const ok = want ? isEnabled(state) : isDisabled(state);
  if (!ok) bad++;
  console.log(`${ok ? 'ok ' : 'BAD'} ${FuseV1Options[option]} = ${isEnabled(state) ? 'enabled' : isDisabled(state) ? 'disabled' : state}`);
}
process.exit(bad === 0 ? 0 : 1);
