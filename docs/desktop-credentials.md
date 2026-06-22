# Desktop signing & notarization — credentials guide

This is a step-by-step guide to **generating every credential** the desktop
release pipeline (`.github/workflows/desktop-release.yml`) can consume, and adding
them as GitHub repository secrets. It is the companion to
[`docs/desktop.md`](desktop.md), which covers the architecture and release flow.

**Everything here is optional.** If a secret is absent, the workflow still builds
**unsigned** installers and logs a warning — it never fails for missing secrets. Add
the credentials only when you want signed/notarized builds.

> Security: these are private signing materials. Never commit them, never paste
> them into logs/PRs, and store them only as encrypted **GitHub Actions secrets**
> (Repo → *Settings → Secrets and variables → Actions → New repository secret*).

- [Secret reference (at a glance)](#secret-reference-at-a-glance)
- [macOS — Developer ID + notarization](#macos--developer-id--notarization)
- [Windows — Authenticode (cert-in-secret)](#windows--authenticode-cert-in-secret)
- [Windows — Azure Trusted Signing (preferred)](#windows--azure-trusted-signing-preferred)
- [Linux](#linux)
- [The updater](#the-updater)
- [Verifying a signed build](#verifying-a-signed-build)

---

## Secret reference (at a glance)

| Secret name | Platform | What it is |
| --- | --- | --- |
| `APPLE_CERTIFICATE` | macOS | Base64 of your **Developer ID Application** `.p12` certificate. |
| `APPLE_CERTIFICATE_PASSWORD` | macOS | The password you set when exporting that `.p12`. |
| `APPLE_ID` | macOS | The Apple ID email used for notarization. |
| `APPLE_PASSWORD` | macOS | An **app-specific password** for that Apple ID (not your login password). |
| `APPLE_TEAM_ID` | macOS | Your 10-character Apple Developer Team ID. |
| `WINDOWS_CERTIFICATE` | Windows | Base64 of your Authenticode code-signing `.pfx`/`.p12`. |
| `WINDOWS_CERTIFICATE_PASSWORD` | Windows | The password for that `.pfx`. |

The workflow maps these onto electron-builder's environment variables
(`CSC_LINK`, `CSC_KEY_PASSWORD`, `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`,
`APPLE_APP_SPECIFIC_PASSWORD`, …) for you.

---

## macOS — Developer ID + notarization

Requires membership in the **Apple Developer Program** ($99/yr). For distribution
*outside* the Mac App Store you need a **Developer ID Application** certificate, and
Apple requires the app to be **notarized** and **stapled** (electron-builder does the
stapling automatically once notarization succeeds).

### 1. Create the Developer ID Application certificate

On a Mac:

1. Open **Keychain Access → Certificate Assistant → Request a Certificate From a
   Certificate Authority**. Enter your email, leave "CA Email" blank, choose **Saved
   to disk**, and save the `CertificateSigningRequest.certSigningRequest` (CSR).
2. Go to <https://developer.apple.com/account/resources/certificates/list> →
   **+** → **Developer ID Application** → upload the CSR → **Download** the resulting
   `.cer`.
3. Double-click the `.cer` to import it into your **login** keychain. It pairs with
   the private key created by the CSR.

> No Mac? You can generate the key/CSR with OpenSSL, but Keychain Access is the
> supported path. The rest of this section assumes the cert+key are in your keychain.

### 2. Export it as a password-protected `.p12`

In Keychain Access, expand the **Developer ID Application** certificate so its private
key shows, select **both** the certificate and its key, right-click → **Export 2
items…** → save as `developer-id.p12` and set a strong export password (this becomes
`APPLE_CERTIFICATE_PASSWORD`).

### 3. Base64-encode the `.p12`

```bash
# macOS / Linux
base64 -i developer-id.p12 | tr -d '\n' > developer-id.p12.base64
# (Windows PowerShell)
# [Convert]::ToBase64String([IO.File]::ReadAllBytes("developer-id.p12")) > developer-id.p12.base64
```

Add the file's contents as the secret **`APPLE_CERTIFICATE`**, and the export password
as **`APPLE_CERTIFICATE_PASSWORD`**.

### 4. Find your Team ID

At <https://developer.apple.com/account> → **Membership** → copy the 10-character
**Team ID**. Add it as **`APPLE_TEAM_ID`**.

### 5. Create an app-specific password for notarization

1. Sign in at <https://account.apple.com> → **Sign-In and Security → App-Specific
   Passwords → +**. Label it e.g. "gitmanager-notarize".
2. Copy the generated `xxxx-xxxx-xxxx-xxxx` value.

Add your Apple ID email as **`APPLE_ID`** and the app-specific password as
**`APPLE_PASSWORD`**.

### 6. Done

With all five Apple secrets set, the next `v*` tag build on the `macos-14` (arm64)
runner will sign with Developer ID, notarize via Apple's notary service, and staple
the ticket. Missing any of them → an unsigned build with a warning.

---

## Windows — Authenticode (cert-in-secret)

The simplest path: an OV or EV code-signing certificate exported as a `.pfx`.

1. **Obtain a certificate** from a CA (DigiCert, Sectigo, SSL.com, …). OV certs are
   delivered as a file; EV certs traditionally ship on hardware tokens (which a
   GitHub-hosted runner can't access — for EV/HSM use Azure Trusted Signing below).
2. **Export to `.pfx`** with the private key and a strong password
   (`certmgr.msc` → your cert → *All Tasks → Export → Yes, export the private key →
   PFX*). If you already have a `.pfx`, skip this.
3. **Base64-encode** it:

   ```bash
   base64 -i code-signing.pfx | tr -d '\n' > code-signing.pfx.base64
   ```

4. Add the contents as **`WINDOWS_CERTIFICATE`** and the password as
   **`WINDOWS_CERTIFICATE_PASSWORD`**.

The `windows-latest` runner will then Authenticode-sign the `.exe`/`.msi`.

---

## Windows — Azure Trusted Signing (preferred)

If you have Azure infrastructure, **Azure Trusted Signing** (formerly Azure Code
Signing) is preferred: keys live in Azure, you sign with a service principal, and
there's no cert file to ship in secrets. It also covers EV-level trust without a
hardware token.

### 1. Set up the Azure resources

1. Create a **Trusted Signing account** and a **Certificate Profile** in the Azure
   portal, and complete identity validation.
2. Create an **App registration** (service principal) and grant it the
   **Trusted Signing Certificate Profile Signer** role on the account.

### 2. Add the service-principal secrets

| Secret | Value |
| --- | --- |
| `AZURE_TENANT_ID` | Directory (tenant) ID of the app registration. |
| `AZURE_CLIENT_ID` | Application (client) ID. |
| `AZURE_CLIENT_SECRET` | A client secret for the app registration. |
| `AZURE_CODESIGN_ACCOUNT` | Trusted Signing account name. |
| `AZURE_CODESIGN_PROFILE` | Certificate profile name. |
| `AZURE_CODESIGN_ENDPOINT` | Region endpoint, e.g. `https://eus.codesigning.azure.net`. |

### 3. Wire the afterSign hook

Trusted Signing runs as an electron-builder **`afterSign`** (or `signtoolOptions`)
hook that invokes the Azure signing client. Add a `build/azure-sign.js` hook that
shells out to the `Azure.CodeSigning.Client`/`trusted-signing-cli`, then reference it
from `electron-builder.yml`:

```yaml
win:
  signtoolOptions:
    sign: build/azure-sign.js   # only when AZURE_* secrets are present
```

Keep it conditional on `process.env.AZURE_CLIENT_ID` so the build falls back to the
cert-in-secret path (or unsigned) when Azure isn't configured. (The hook itself isn't
committed yet — add it when you enable Azure signing.)

---

## Linux

`.AppImage` and `.deb` are shipped **unsigned**; no credentials are required. AppImage
integrity comes from the GitHub Release download + the electron-updater manifest.

Optionally, GPG-sign the `.deb`: import a private key on the `ubuntu-22.04` runner
(e.g. a `GPG_PRIVATE_KEY` secret) and run `dpkg-sig --sign builder *.deb` after the
build. Not wired by default.

---

## The updater

There is **no separate updater signing key** to manage (unlike Tauri). electron-updater
verifies each update against the GitHub Releases publisher and, on macOS/Windows, the
OS code signature of the downloaded installer. So: sign your installers (above) and the
auto-update path is trustworthy automatically. The only updater requirement is that the
release assets and the generated `latest*.yml` manifests are published together — which
the workflow does.

---

## Verifying a signed build

- **macOS:**

  ```bash
  codesign --verify --deep --strict --verbose=2 "GitManager.app"
  spctl -a -vvv "GitManager.app"          # should say: accepted, source=Notarized Developer ID
  xcrun stapler validate "GitManager.app"  # stapled ticket present
  ```

- **Windows (PowerShell):**

  ```powershell
  Get-AuthenticodeSignature .\GitManager-Setup.exe | Format-List
  # Status should be 'Valid'
  ```

- **Auto-update smoke test:** install an older version, publish a higher `v*` tag,
  and confirm the in-app banner offers the update and relaunches into the new build.
