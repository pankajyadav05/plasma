# macOS auto-update and code signing

## Symptom

On a macOS build, **Check for updates** downloads the new version and then fails:

```
Update check failed: Code signature at URL
file:///Users/…/Library/Caches/sh.plasma.app.ShipIt/update.…/Plasma.app/
did not pass validation: code has no resources but signature indicates they
must be present
```

Windows is unaffected — NSIS updates do not go through any of this.

## Why it happens

macOS installs run through Squirrel.Mac (`ShipIt`), which electron-updater
drives. Before installing, Squirrel takes the **designated requirement of the
app that is currently running** and validates the downloaded bundle against it
(`Squirrel/SQRLCodeSignature.m`):

```objc
SecCodeCopySelf(…, &staticCode);                       // installed app
SecCodeCopyDesignatedRequirement(staticCode, …, &req); // its requirement
SecStaticCodeCheckValidityWithErrors(newApp,
    kSecCSCheckNestedCode | kSecCSStrictValidate | kSecCSCheckAllArchitectures,
    req, &error);                                      // downloaded app
```

Releases are packaged with `identity: null` (plus `CSC_IDENTITY_AUTO_DISCOVERY:
false` in CI), so electron-builder logs `skipped macOS code signing` and never
signs the assembled bundle. What actually ships (verified on the published
`Plasma-0.0.20-*.zip` artifacts):

| artifact | `Contents/_CodeSignature/CodeResources` | main executable signature |
| --- | --- | --- |
| `Plasma-0.0.20-arm64.zip` | absent | ad-hoc, linker-signed (`flags=0x20002`, identifier still `Electron`), no CMS slot |
| `Plasma-0.0.20-x64.zip` | absent | none |

The arm64 binaries are signed because Apple Silicon refuses to execute
unsigned code: the linker emits an ad-hoc signature, and Electron ships those
prebuilt binaries. So the bundle is a mix — the Mach-O advertises a code
directory with a resource-directory hash, while the bundle has no resource
envelope. `kSecCSStrictValidate` reports exactly that: *code has no resources
but signature indicates they must be present* (`errSecCSResourcesNotFound`).

**Ad-hoc signing the whole bundle would not fix it.** An ad-hoc designated
requirement is `cdhash H"…"` — the hash of that one build. The installed app's
requirement can then never be satisfied by any future version, so validation
would still fail, just with a different message.

Squirrel updates therefore require a signature whose designated requirement
outlives the build. Only a certificate-backed one does:

```
identifier "sh.plasma.app" and anchor apple generic and
certificate leaf[subject.OU] = "<TEAMID>"
```

## What the app does now

`src/main/mac-signature.ts` classifies the running bundle at launch by reading
its own Mach-O and resource envelope (no `codesign` subprocess — `/usr/bin/
codesign` is an Xcode Command Line Tools shim and is not usable on stock user
machines):

| classification | meaning |
| --- | --- |
| `certificate` | signed by a real identity — Squirrel can install |
| `adhoc` | ad-hoc signed bundle — requirement is build-specific |
| `bundle-unsigned` | signed Mach-O, unsigned bundle (what ships today) |
| `unsigned` | no signature at all |
| `unreadable` | executable missing or unparseable |

Anything other than `certificate` puts the updater in **manual mode**
(`src/main/updater.ts`):

- `autoDownload` / `autoInstallOnAppQuit` are off, so the app no longer pulls
  ~110 MB every poll cycle for a payload ShipIt will reject.
- `update-available` broadcasts `{ kind: 'available-manual', version,
  downloadUrl }`. The URL is `<publish url>/Plasma-<version>-<arch>.dmg`, read
  from the `app-update.yml` baked into the bundle, so it always points at the
  bucket that build publishes to.
- Settings → About and the status-bar pill show **Download v\<version\>**;
  clicking opens that .dmg in the browser.
- `plasma:update:install` only calls `quitAndInstall` when a download really
  completed; on `available-manual` it opens the .dmg instead.

Checking still happens, so users are told a new version exists — they just
install it by dragging it to /Applications.

## Enabling real auto-update

1. Get an Apple Developer Program membership and a **Developer ID Application**
   certificate; export it as `.p12`.
2. Add repo secrets `CSC_LINK` (base64 of the `.p12`) and `CSC_KEY_PASSWORD`.
   For notarization add `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`
   (App Store Connect API key).
3. In `electron-builder.yml`, drop `identity: null` from the `mac` block (keep
   `hardenedRuntime: true`, which is a no-op until signing happens) and add
   `notarize: true`.
4. In `.github/workflows/release.yml`, remove `CSC_IDENTITY_AUTO_DISCOVERY:
   false` from the `build-macos` env and pass the secrets above instead.
5. Verify the produced app before publishing:

   ```sh
   codesign -dv --verbose=4 release/mac-arm64/Plasma.app   # Authority=Developer ID Application: …
   codesign --verify --strict --deep release/mac-arm64/Plasma.app
   spctl -a -vvv -t install release/mac-arm64/Plasma.app    # accepted, notarized
   ```

**One manual hop is unavoidable.** The requirement Squirrel enforces comes from
the *installed* app, so builds already in the field (unsigned or ad-hoc) can
never auto-install the first signed release — every existing macOS user has to
download that one build by hand. From the first signed build onward,
`mac-signature.ts` reports `certificate` and updates install themselves.
