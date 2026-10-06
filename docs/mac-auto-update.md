# macOS auto-update and code signing

## Symptom

On a macOS build, **Check for updates** downloads the new version and then fails:

```
Update check failed: Code signature at URL
file:///Users/…/Library/Caches/sh.plasma.app.ShipIt/update.…/Plasma.app/
did not pass validation: code has no resources but signature indicates they
must be present
```

Windows is unaffected: NSIS updates do not go through any of this. (This was the
behaviour before Plasma gained its own macOS installer; see "What the app does now".)

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
its own Mach-O and resource envelope (no `codesign` subprocess is needed for the
classification):

| classification | meaning |
| --- | --- |
| `certificate` | signed by a real identity: Squirrel can install |
| `adhoc` | ad-hoc signed bundle: requirement is build-specific |
| `bundle-unsigned` | signed Mach-O, unsigned bundle |
| `unsigned` | no signature at all |
| `unreadable` | executable missing or unparseable |

Anything other than `certificate` means Squirrel is never used. Instead Plasma
installs updates **itself** (`src/main/mac-self-update.ts`), with the same
integrity guarantee as every other platform: the ed25519 signed manifest
(docs/release.md), not Apple code signing.

### The self-install flow (no Developer ID)

1. **Check.** The signed `latest-mac.yml` is verified. Without a verified
   manifest (no key embedded, or an unsigned legacy release) there is no
   self-install, only the manual download below.
2. **Download.** The arm64 `Plasma-<v>-arm64.zip` named in the signed manifest
   streams to `<userData>/pending-update/`, hashed while it streams. It gets its
   final name only if the sha512 equals the signed one; anything else is deleted
   and the update is refused. The status shows progress like on other platforms.
3. **Unpack and check.** `ditto -x -k` into `pending-update/stage-<v>-<id>/`.
   The bundle must have our `CFBundleIdentifier` (read from the running app),
   `CFBundleShortVersionString` equal to the announced version, and pass
   `codesign --verify --deep --strict` (the ad-hoc signature added in
   `after-pack.cjs` is fine). Any failure removes the staging folder and falls
   back to the manual download with the reason.
4. **Can this app replace itself?** The running bundle (from
   `process.execPath` up to `*.app`) must not run from App Translocation
   (`/AppTranslocation/`) or a read-only volume (a mounted dmg), and its parent
   folder must be writable by the user. Otherwise the top bar offers "Update"
   (manual download) and Settings says **"Move Plasma to Applications to get
   automatic updates."**
5. **Restart to update.** One click when nothing is at stake; otherwise main
   lists what would be lost first (pending grid edits, an open transaction, a
   running query, a pending Safe Run, SQL tabs that cannot be restored). Then:
   the renderer flushes the tab strip, a restart marker is written
   (`<userData>/update-restart.json`: connection, workspace, expected version),
   the workers are stopped (session disconnected, tunnels closed, local store
   closed), and a detached `/bin/sh` helper is started from the staging folder
   and Plasma quits.
6. **The helper** (`buildHelperScript`; log: `<userData>/logs/update-helper.log`)
   waits for Plasma's PID to exit (it logs after 60 s and keeps waiting quietly for up to 30 min), refuses to touch anything if Plasma was reopened by hand in the meantime, then:
   - moves the new bundle next to the old one as `Plasma.app.new-<id>` (same
     volume; `ditto` copy if `mv` fails);
   - renames the old bundle to `Plasma.app.old-<id>`, renames the new one into
     place;
   - removes `com.apple.quarantine` (files our own process wrote do not have it,
     so Gatekeeper does not prompt again) and runs `open -n`;
   - on any failure puts the old bundle back and reopens it;
   - on success moves the old bundle into the staging folder (so no stale copy can stay in Applications) and deletes that folder.
   It only ever deletes names it created (`.old-`, `.new-`, `.bad-` + id next to
   the app, and the staging folder if it holds `.plasma-stage` and sits inside
   `pending-update/`); every other path is refused. All paths are single-quoted
   literals, so spaces and quotes are safe.
7. **Next launch.** The marker says which version was expected. If the running
   version is older, the app shows "The update could not be installed" with the
   log path and the manual download. If it is the new version, a toast says
   "Updated to Plasma X · What's new". Either way the connection and tabs come
   back, even with "Connect on launch" / "Restore tabs on launch" off.

### Keychain prompt after an update

Plasma's `safeStorage` key lives in the login keychain ("Plasma Safe Storage").
Its access list follows the app's code signature. With ad-hoc signing every
build has a different signature, so macOS may ask **once after each update** to
allow Plasma to use that item. Click "Always Allow". The fix is a stable
signing certificate (below): the signature, and with it the access list, then
stays the same across releases.

### Manual download (fallback)

`available-manual` carries the `.dmg` URL (`<publish url>/Plasma-<version>-<arch>.dmg`,
taken from the signed manifest when there is one) and a `reason`. Settings →
Updates and the top-bar "Update" pill open it. This is what Intel Macs, apps
running from a dmg or from Downloads, and builds without a verified manifest get.

### Certificate-signed builds

When `mac-signature.ts` reports `certificate` (a future Developer ID build),
Squirrel.Mac is used again, behind the same "Restart to update" button.

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
