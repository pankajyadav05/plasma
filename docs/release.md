# Releasing Plasma

How a build gets from this repo to users, and what protects the update channel.

## Overview

| Platform | Build | Artifacts | Manifest |
|---|---|---|---|
| Windows | `pnpm dist:win` | `Plasma-Setup-<v>-x64.exe`, `Plasma-Portable-<v>-x64.exe` | `latest.yml` |
| macOS | `pnpm dist:mac` | `Plasma-<v>-arm64.{dmg,zip}` (Apple Silicon only) | `latest-mac.yml` |
| Linux | `pnpm dist:linux` | `Plasma-<v>-x86_64.AppImage`, `Plasma-<v>-amd64.deb` | `latest-linux.yml` |

Everything lands in the Cloudflare R2 bucket behind
`https://pub-05a2064511bc41689f299b542b07b67f.r2.dev`, which is also the
`publish.url` baked into every app (`electron-builder.yml`).

Local flow (the usual one):

```bash
pnpm release:patch        # bump package.json (and the site's offline label)
pnpm dist:win && pnpm release:upload      # Windows (+ any mac/linux files already in release/)
pnpm release:mac          # dist:mac + upload --mac-only
pnpm release:linux        # dist:linux + upload --linux-only
pnpm release:verify       # read-only check of what the feed serves
```

`.github/workflows/release.yml` can build all three and publish. It is started
by hand, refuses to run from any ref except `main` or a `v*` tag, requires the
tag to equal `package.json`'s version, smoke-launches the packaged app on every
platform (it must create `plasma.db`), and publishes from a protected
`production` environment (add required reviewers in the repo settings).

## Releasing from GitHub Actions

`.github/workflows/release.yml` builds Windows, macOS and Linux on GitHub's
runners, launches each build to prove it boots, then signs the manifests and
uploads to R2 (and creates a GitHub Release when run from a `v*` tag).

The GitHub Release page gets its notes from `scripts/release-notes.mjs`: every
`feat`, `fix` and `perf` commit since the previous `v*` tag, grouped under New,
Faster and Fixed (tests, CI, docs, version bumps and "review findings"
follow-ups are left out). Commit subjects are the release notes, so write them
for users. Preview them before releasing with
`node scripts/release-notes.mjs <next version>`; the in-app "What's new" link
opens this page.

One-time setup (repo → Settings):

- **Secrets and variables → Actions**: `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, and `PLASMA_UPDATE_SIGNING_KEY` (the value from your
  `.env.local`).
- Optional `VERCEL_DEPLOY_HOOK` secret (Vercel → project → Settings → Git →
  Deploy Hooks, branch `main`): the publish job calls it after the upload so
  the site rebuilds with the new version.
- **Environments**: `production` is created on first use; add yourself as a
  required reviewer so a publish waits for your click.

Run it: Actions → Release → Run workflow → branch `main` → `platforms`
(and `bump`, patch by default). No manual version bump: the `version` job
(scripts/release-version.mjs) picks one step above the highest version the
feed serves for the chosen platforms, skips versions that are already tagged
or half-published, commits `vX.Y.Z` to main and tags it; every build then
checks out that tag. Example: Linux serves 3.1.4 and Windows/macOS 3.1.3, so
`all` releases 3.1.5.

Running from a `v*` tag (made with `pnpm ship:*`) keeps the tag's version and
stops at once if it is already published for the chosen platforms.

## What the upload script guarantees

`scripts/upload-release.mjs`:

- **Versioned files are immutable.** Installers, `.dmg`/`.zip`/`.deb`/`.AppImage`
  and blockmaps are written with `If-None-Match: *` and
  `Cache-Control: public, max-age=31536000, immutable`. An existing key is never
  overwritten: re-running after a partial publish skips files whose published
  size matches, and fails if it differs (bump the version instead).
- **Manifests are not cacheable.** `latest*.yml` and `latest*.yml.sig` are
  `no-cache, must-revalidate`.
- **Local checks first.** Every file a local manifest lists must exist in
  `release/` and hash to the sha512 the manifest declares. A leftover manifest
  from an older version is skipped, never republished.
- **Order.** Binaries, then `<manifest>.sig`, then the manifest.
- **Post-publish gate.** It reads the feed back over HTTP: version, every
  referenced file present with the size the manifest declares, and the `.sig`
  verifies against the public key embedded in the app.

## Signed update manifests (SC-01)

The bucket is public and `latest.yml` carries the installer's sha512, so the
hash alone proves nothing about who published it. Until the builds are code
signed (Windows `publisherName`, macOS Developer ID), the update channel is
protected by a detached ed25519 signature:

1. The release machine signs the **exact bytes** of each manifest with a
   private key and uploads `<manifest>.sig` (base64) next to it.
2. The app embeds the matching public key
   (`src/main/update-signing-key.ts`). When electron-updater reports an
   available update, the app (`src/main/updater.ts`, `update-signing.ts`):
   - fetches the manifest and its `.sig` itself and verifies the signature;
   - checks that the version and every file's sha512 that electron-updater
     parsed equal what the signed manifest says (refuses on any mismatch,
     including a manifest that changed between the two reads);
   - only then downloads (`autoDownload` is held back until this passes);
   - after the download, hashes the file on disk and compares it with the
     signed sha512 before the update can be installed (install-on-quit is armed
     only after this check), and hashes it again at the moment of "Restart to
     update";
   - on macOS builds without a Developer ID, downloads the arm64 `.zip` named in
     the verified manifest itself and installs it with Plasma's own helper
     (docs/mac-auto-update.md); when that is impossible it takes the `.dmg` URL
     from the verified manifest instead of guessing it.
   A refused update shows "Update refused: <reason>" and is never installed.

A verified manifest plus a matching file is what allows a **silent** install
(no installer windows, relaunch afterwards) and install-on-quit, without any OS
code signing (`installPlan` in `update-policy.ts`). An update that is only
tolerated because it predates `SIGNED_UPDATES_REQUIRED_FROM` keeps the old,
manual behaviour.

### What each platform does with a verified update

| Platform | Download | "Restart to update" | Plain quit |
|---|---|---|---|
| Windows NSIS (per-user) | background, as soon as verified | stop workers, write restart marker, `quitAndInstall(true, true)` (silent, relaunch) | installs silently |
| Windows all-users install, portable | none | "Update" opens the download page | nothing |
| Linux AppImage | background | same; electron-updater swaps the file (a hard-link backup protects it) and starts the new one | installs |
| Linux .deb / any OS package (decided from `resources/package-type`, never from env) | none | "Update" opens the `.deb` from the signed manifest (root install of a user-writable file is not done) | nothing |
| macOS, Developer ID | background (Squirrel) | `quitAndInstall` | Squirrel |
| macOS, no Developer ID | Plasma downloads + unpacks the zip itself | detached `/bin/sh` helper swaps the bundle | nothing |

Publishing requirements this relies on: `latest-mac.yml` must list the
`Plasma-<v>-arm64.zip` (it does; `release:upload` publishes it), and
`latest-linux.yml` the AppImage and `.deb`.

### One-time setup

```bash
pnpm gen:update-key
```

- Writes `PLASMA_UPDATE_SIGNING_KEY` (base64 PKCS#8) to `.env.local` only. It
  refuses to overwrite an existing key. Back it up somewhere safe: losing it
  means installed apps can no longer verify (or accept) updates.
- Prints `UPDATE_SIGNING_PUBLIC_KEY = '...'`. Paste it into
  `src/main/update-signing-key.ts`.
- For the GitHub release workflow, store the same private value as the
  `PLASMA_UPDATE_SIGNING_KEY` repository secret.

`upload-release.mjs` refuses to publish unsigned manifests when the key is
missing (use `--allow-unsigned` only during the transition below). It also
refuses a private key whose public half is not the one embedded in the app.

### Transition policy (the feed is unsigned today)

Two constants in `src/main/update-signing-key.ts` define it:

| State | Behaviour |
|---|---|
| `UPDATE_SIGNING_PUBLIC_KEY` is `null` (today) | No verification. The updater logs a warning at launch. |
| Key embedded, update version `< SIGNED_UPDATES_REQUIRED_FROM` | A `.sig` that exists must verify. A missing `.sig` is allowed with a logged warning; the download still happens but install-on-quit is not armed. |
| Key embedded, update version `>= SIGNED_UPDATES_REQUIRED_FROM` | A valid `.sig` is mandatory. A missing or bad signature is refused. |

`SIGNED_UPDATES_REQUIRED_FROM` is `3.1.0`: the first release that must be
published with signed manifests. Because the rule keys off the *update's*
version, stripping the `.sig` from a current release does not downgrade the
check.

Rollout:

1. `pnpm gen:update-key`, paste the public key, set the repo secret.
2. Release 3.1.0 (or whichever version `SIGNED_UPDATES_REQUIRED_FROM` names).
   Existing 3.0.x apps have no verifier and update as before; 3.1.0 apps verify
   everything after it.
3. Every later release is signed by `release:upload`. Bump
   `SIGNED_UPDATES_REQUIRED_FROM` only if the first signed release changes.

### Rotating the key

Ship a build that embeds the new public key **before** switching the signing
key, because apps only trust the key they were built with. There is no
multi-key support; a rotation is a two-release operation (old key signs the
release that carries the new public key). Never run `gen:update-key --force`
before that.

## Install, packaging and fuses

- `pnpm install` never rebuilds natives. better-sqlite3 13 ships N-API
  prebuilds for every platform/arch, loaded as shipped; `npmRebuild: false` in
  `electron-builder.yml`. `scripts/postinstall.mjs` only makes sure the
  Electron binary exists for `pnpm dev` and never fails the install (it is
  skipped when `CI` or `ELECTRON_SKIP_BINARY_DOWNLOAD` is set).
- `logo/` and `resources/` are committed. `pnpm build:icons` regenerates them
  only when the SVG sources are newer (`--force` to override); it is no longer
  run on install.
- Only runtime dependencies (`dependencies` in `package.json`) ship in the
  installer. Everything the renderer bundles with Vite is a devDependency.
- Electron fuses are flipped by electron-builder (`electronFuses`): `RunAsNode`,
  `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments`
  off, `OnlyLoadAppFromAsar` and `EnableEmbeddedAsarIntegrityValidation` on
  (Electron honours the integrity fuse on macOS and Windows only). Check a
  packaged binary with `node scripts/verify-fuses.mjs <binary or .app>`.

## The website

`site/lib/version.ts` reads `latest.yml`, `latest-mac.yml` and
`latest-linux.yml` from the feed at build time. Each platform shows its own
version and files. Every referenced file is HEAD-checked and the build fails
if one is missing; a platform without a manifest renders "coming soon". After
a release, redeploy the site (Vercel) so the links follow. The release scripts
only patch the `PACKAGE_VERSION` offline label there.
