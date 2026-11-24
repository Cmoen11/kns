# macOS signing and notarization

A `.dmg` downloaded from GitHub carries the quarantine flag. Gatekeeper only starts such an app
without complaint when it is signed with an Apple **Developer ID Application** certificate and
**notarized** by Apple. Without that, an Apple Silicon Mac reports "kns is damaged and can't be
opened" (unsigned) or blocks it as from an unidentified developer (ad-hoc signed).

`tauri.conf.json` sets `bundle.macOS.signingIdentity` to `"-"` (ad-hoc), so builds without the
secrets below still have a valid signature. With the secrets, CI (`.github/workflows/build.yml`)
signs with the Developer ID, and Tauri notarizes and staples the `.app` during `tauri build`.
Updates installed by the app itself are not quarantined and are unaffected either way.

## One-time setup

1. Join the [Apple Developer Program](https://developer.apple.com/programs/) (99 USD per year).
   An individual account is enough.
2. Create the certificate. In Xcode: Settings → Accounts → your team → Manage Certificates →
   `+` → **Developer ID Application**. (Or create a CSR in Keychain Access and upload it at
   developer.apple.com → Certificates.)
3. Export it from Keychain Access ("My Certificates", the certificate together with its private
   key) as a `.p12` file with a password, then base64 it:
   ```sh
   base64 -i kns-developer-id.p12 | pbcopy
   ```
4. Find the identity name:
   ```sh
   security find-identity -v -p codesigning
   ```
   It looks like `Developer ID Application: Your Name (ABCDE12345)`; the part in brackets is the team id.
5. Create an app-specific password at [account.apple.com](https://account.apple.com) → Sign-In
   and Security → App-Specific Passwords. Notarization uses it instead of the Apple ID password.
6. Add the repository secrets (GitHub → Settings → Secrets and variables → Actions):

   | Secret | Value |
   |---|---|
   | `APPLE_CERTIFICATE` | base64 of the `.p12` (step 3) |
   | `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
   | `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (ABCDE12345)` |
   | `APPLE_ID` | the Apple ID email of the developer account |
   | `APPLE_PASSWORD` | the app-specific password (step 5) |
   | `APPLE_TEAM_ID` | `ABCDE12345` |

The next `v*` tag then produces a signed, notarized build. The "verify macOS signature" step in
the build log shows the authority and whether `spctl` (Gatekeeper) accepts it. The certificate
is valid for five years.
