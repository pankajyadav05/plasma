#!/usr/bin/env node
/**
 * Creates the ed25519 key pair that signs the update manifests (SC-01).
 *
 *   pnpm gen:update-key
 *
 * - The PRIVATE key is written to .env.local (gitignored) as
 *   PLASMA_UPDATE_SIGNING_KEY. It is never printed.
 * - The PUBLIC key is printed: paste it into
 *   src/main/update-signing-key.ts (UPDATE_SIGNING_PUBLIC_KEY).
 *
 * Refuses to overwrite an existing key: replacing it locks every installed
 * app that embeds the old public key out of updates. Pass --force only when
 * you really mean to rotate (and ship a build with the new public key first).
 */
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env.local');
const force = process.argv.includes('--force');
const VAR = 'PLASMA_UPDATE_SIGNING_KEY';

const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const hasKey = new RegExp(`^\\s*${VAR}\\s*=`, 'm').test(existing);
if (hasKey && !force) {
  console.error(`[gen-update-key] ${VAR} already exists in .env.local; not overwriting.`);
  console.error('[gen-update-key] pass --force to rotate (see docs/release.md before doing so).');
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
// PKCS#8 DER, base64: one line, no PEM armour, easy to keep in an env file.
const privateB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

const line = `${VAR}=${privateB64}\n`;
if (hasKey) {
  writeFileSync(envPath, existing.replace(new RegExp(`^\\s*${VAR}\\s*=.*$`, 'm'), line.trimEnd()), {
    mode: 0o600,
  });
} else {
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  appendFileSync(envPath, sep + line, { mode: 0o600 });
}

console.log('[gen-update-key] private key written to .env.local (never commit it, back it up).');
console.log('[gen-update-key] paste this into src/main/update-signing-key.ts:');
console.log('');
console.log(`export const UPDATE_SIGNING_PUBLIC_KEY: string | null = '${publicRaw}';`);
console.log('');
