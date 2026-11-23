# Auto-update: findings and plan

Status: implemented, but switched off until the signing key below is added. Written 2026-11-23.

## Before the first release with auto-update

1. Generate the key pair once, on your own machine: `pnpm tauri signer generate -w ~/.tauri/kns.key`. Keep a backup of the private key and its password in a password manager.
2. Put the **public** key (the contents of `~/.tauri/kns.key.pub`) in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, and commit it.
3. Add the repo secrets `TAURI_SIGNING_PRIVATE_KEY` (the contents of `~/.tauri/kns.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Make the repo public, so the app can read `releases/latest/download/latest.json` without logging in.
5. Release: bump `version` in `package.json` (the only version that counts: `tauri.conf.json` reads it), commit, tag `v<version>`, push the tag.

What is in place:
- **Rust** (`src-tauri/src/update.rs`): checks 30 s after start and every 6 h, downloads and verifies in the background, and installs only on `update_install`. It is off in dev builds, when `KNS_NO_UPDATE` is set, and while `pubkey` is empty.
- **UI** (`src/update/`): `update 0.2.0` in the bottom row once a version is downloaded. A click, `:update` or Help → Check for Updates installs it after a confirm. `:update check` and `:update status` are also available. Try it in the browser with `pnpm dev`, then open `http://localhost:1420/?update=ready`.
- **CI** (`.github/workflows/build.yml`):
  - A tag build fails if the tag does not match `package.json` or if `pubkey` or the signing secret is missing.
  - The release job uploads `kns_<v>_aarch64.app.tar.gz` and `latest.json` next to the installers.
  - Builds on `main` sign when the secret is there and still pass when it is not.

The rest of this file is the exploration that led here.

## Summary

- **It can be done with the official `tauri-plugin-updater` (2.14.1), which fits how kns is built.** The plugin can run entirely from Rust, the way the dialog, opener and notification plugins already do, so the window gets no new capability and the CSP stays the same.
- **The plugin does not need OS code signing.** It verifies every download with its own minisign key pair, which is separate from Authenticode and Apple signing, so the current unsigned builds can still update themselves.
- **The blocker is that `Cmoen11/kns` is private.** The app has to fetch `latest.json` and the installer without logging in. A private repo's release assets return 404 to anonymous requests, so update files cannot be served from this repo's GitHub Releases as things stand. See [Hosting](#hosting-the-blocker).
- **Existing v0.1.0 installs will not update themselves.** Every user has to install the first version that includes the updater by hand. From then on updates are automatic.

## How the plugin works

1. With `bundle.createUpdaterArtifacts: true`, `tauri build` writes an update bundle and a `.sig` next to each installer. It signs them with the private key from `TAURI_SIGNING_PRIVATE_KEY`, plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has a password.
   - Windows (NSIS): the `*-setup.exe` is the update bundle, plus `*-setup.exe.sig`.
   - macOS: `kns.app.tar.gz` plus `kns.app.tar.gz.sig`.
2. The app GETs an endpoint from `plugins.updater.endpoints`, which can be a static JSON file:
   ```json
   {
     "version": "0.2.0",
     "notes": "…",
     "pub_date": "2026-11-23T12:00:00Z",
     "platforms": {
       "windows-x86_64": { "url": "https://…/kns_0.2.0_x64-setup.exe", "signature": "<contents of .sig>" },
       "darwin-aarch64": { "url": "https://…/kns.app.tar.gz", "signature": "<contents of .sig>" }
     }
   }
   ```
   The plugin looks up `{os}-{arch}-{installer}` first (for example `windows-x86_64-nsis`), then `{os}-{arch}`. I checked this order in the plugin source (`updater.rs`, `get_urls`).
3. If the version is newer (semver), `download_and_install` downloads the bundle, checks it against `pubkey` from the config, and installs it.
   - Windows: the app runs the NSIS installer with `/UPDATE` plus the flags for `windows.installMode` (`passive`, `basicUi` or `quiet`), then exits.
   - macOS: the app swaps the `.app` bundle in place and keeps a backup if the swap fails. The user then restarts the app.

## Hosting (the blocker)

The endpoint and the download URLs must work without credentials.

| Option | What it takes | Verdict |
|---|---|---|
| **A. Make `kns` public** | Change the repo setting. The endpoint becomes `https://github.com/Cmoen11/kns/releases/latest/download/latest.json`. | The simplest option, if the source may be public. |
| **B. Public releases-only repo** (e.g. `Cmoen11/kns-releases`, with no code) | The release job uploads assets and `latest.json` there, using a fine-grained PAT stored as a secret (`contents: write` on that one repo). | **Recommended if the source stays private.** It is still GitHub, costs nothing, and needs little CI work. |
| C. Object storage (Cloudflare R2, S3, GitHub Pages) | A bucket, upload credentials in CI, and a public URL. | Works, but adds one more account and one more secret. |
| D. Private repo with a token built into the app | — | **No.** Anyone with the binary can extract the token. |

Note: with A or B, anyone who finds the URL can download the binaries. The installers already sit on a release page, so this only matters if the binaries themselves are meant to stay private.

## Signing key

- Generate it once with `pnpm tauri signer generate -w ~/.tauri/kns.key`.
- The public key goes into `tauri.conf.json`. The private key and its password go into the repo secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **If the private key is lost, installed apps can never update automatically again**, because they only accept the old public key. Store a backup in a password manager.
- Once `createUpdaterArtifacts` is on, `tauri build` fails if the key is missing. Pushes to `main` in this repo have access to secrets, so the `main` builds keep working. A workflow triggered from a fork would not have the key.

## Platform notes

**Windows** (used day to day, so the most important target)
- The NSIS installer runs in `passive` mode (progress bar only) and restarts the app afterwards.
- Tauri's NSIS default is a per-user install (`currentUser`), so updating needs no UAC prompt. Check this on a real machine if `bundle.windows.nsis.installMode` is ever changed.
- SmartScreen: the app downloads the file itself, so it gets no Mark-of-the-Web. The installer should therefore not trigger the SmartScreen warning the way a browser download does. *Not verified. Test this on the first real update.*

**macOS** (built in CI, never run by hand)
- The app replaces the `.app` in place, so it needs write access to where it is installed. Under `/Applications` that is the normal case for an admin user.
- The app downloads the bundle itself, so it gets no quarantine attribute, and Gatekeeper does not ask again after an update. *Not verified.*
- Architecture mismatch: the v0.1.0 release has `kns_0.1.0_universal.dmg`, but CI now builds `--target aarch64-apple-darwin`. `latest.json` needs a `darwin-aarch64` entry, plus `darwin-x86_64` only if universal builds come back.

## CI changes (`.github/workflows/build.yml`)

1. Set `"createUpdaterArtifacts": true` under `bundle` in `tauri.conf.json`.
2. Pass both signing secrets as `env` to the `pnpm tauri build` step.
3. Add to the `upload-artifact` paths:
   - `src-tauri/target/release/bundle/nsis/*.exe.sig`
   - `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/*.app.tar.gz{,.sig}`
4. Add a step to the release job that builds `latest.json` with `jq` from the `.sig` files and the release URLs, and uploads it with the assets. With option B, it uploads to `kns-releases` instead of this repo.
5. **Make the tag and the version match.** Today the version appears in three places (`package.json`, `tauri.conf.json` and `Cargo.toml`), all `0.1.0`. A tag `v0.2.0` with an app that still says `0.1.0` would put every install in an update loop.
   - Set `"version": "../package.json"` in `tauri.conf.json` so there is one source.
   - Add a check in the release job that fails if `$GITHUB_REF_NAME != v$(jq -r .version package.json)`.

I'm keeping the hand-written `gh release` flow rather than switching to `tauri-apps/tauri-action`. That action generates `latest.json` automatically, but only for a release in the same repo, so it does not cover option B.

## UX in kns

kns holds long-lived state: port-forwards, shells, log streams and the MCP server. **It must never restart itself without the user asking.**

- Check 30 s after startup, then every 6 hours. Network errors are silent and go to the log only.
- If a newer version exists, download it in the background, then show a quiet notice in the status bar: `kns 0.2.0 ready · restart to update`.
- The user installs it from the palette (`:update`) or by clicking the notice. Before restarting, warn if port-forwards or shells are open, using the same pattern as the confirm on delete.
- Add a setting to turn off automatic checks, with `:update check` for a manual check.
- Add Rust commands, e.g. `update_status` and `update_install`, plus an event for "ready". Use `tauri_plugin_updater::Builder` with `app.updater()?.check()` from Rust, and add no JS permission to `capabilities/default.json`.

## Effort

Small: about one day of work, plus one round of testing on real Windows and macOS machines.

1. Key pair and secrets (manual, by the repo owner).
2. Hosting decision (A or B) and, for B, create the repo and a PAT.
3. Config, CI and the version check.
4. Rust: plugin, check loop, commands. Frontend: status bar and palette.
5. Release `v0.2.0` with the updater and install it by hand. Release `v0.2.1` and check that 0.2.0 updates itself on Windows and macOS.

## Open questions

- May the source be public (A), or do we need a releases-only repo (B)?
- Who uses kns? If everyone has access to the private repo, B is still needed, because the app cannot log in.
- Should updates install on quit without asking, or only after the user clicks?
- Should we do a universal macOS build, or aarch64 only?
