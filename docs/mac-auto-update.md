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

Releases up to 3.2.7 were packaged with `identity: null` (plus
`CSC_IDENTITY_AUTO_DISCOVERY: false` in CI), so electron-builder logged `skipped
macOS code signing` and never signed the assembled bundle. What shipped
(verified on the published `Plasma-0.0.20-*.zip` artifacts):

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

Local releases are signed with the Developer ID Application certificate
(`Pankaj Yadav (88LKBXATSW)`) and notarized. `mac-signature.ts` reports
`certificate` for them, so Squirrel.Mac is used again, behind the same
"Restart to update" button.

## Signing and notarizing a release

1. The Developer ID Application certificate (with its private key) is in the
   login keychain. `electron-builder.yml` leaves `mac.identity` unset, so it is
   auto-discovered (`security find-identity -v -p codesigning` lists it).
2. Notarization uses the `notary` keychain profile, shared with the other apps
   signed by this team (`xcrun notarytool history --keychain-profile notary`
   checks it). On a new machine, create it once:

   ```sh
   xcrun notarytool store-credentials notary \
     --apple-id <apple id> --team-id 88LKBXATSW --password <app-specific password>
   ```

   and build with `APPLE_KEYCHAIN_PROFILE=notary` in the env (shell or
   `.env.local` is not read by electron-builder, so export it). An App Store
   Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`)
   works too. Without credentials electron-builder signs but skips
   notarization, and `upload-release.mjs` refuses to publish that build.
3. `APPLE_KEYCHAIN_PROFILE=notary pnpm release:mac`
4. Check the app before or after publishing:

   ```sh
   codesign -dv --verbose=4 release/mac-arm64/Plasma.app   # Authority=Developer ID Application: …
   codesign --verify --strict --deep release/mac-arm64/Plasma.app
   spctl -a -vvv -t exec release/mac-arm64/Plasma.app      # accepted, source=Notarized Developer ID
   ```

**GitHub release workflow.** `build-macos` signs and notarizes from repository
secrets: `CSC_LINK` (base64 `.p12` holding only the Developer ID identity),
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (from
appleid.apple.com) and `APPLE_TEAM_ID` (`88LKBXATSW`). The keychain profile
above does not exist on the runner. The step after the build fails the release
unless the app carries the Developer ID signature, a stapled ticket and
`spctl`'s `source=Notarized Developer ID`.

**No manual hop for existing users.** Apps already in the field (ad-hoc, up to
3.2.7) never use Squirrel: they install the first signed release through
Plasma's own installer above, whose `codesign --verify --deep --strict` check a
Developer ID bundle passes. From then on `mac-signature.ts` reports
`certificate` and Squirrel takes over. Expect the one-time "Plasma Safe
Storage" keychain prompt on that update.
