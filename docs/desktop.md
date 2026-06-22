# GitManager Desktop

GitManager ships as a standalone desktop app for **Windows, macOS, and Linux**.
It is the *same* GitManager — same engine, same UI, same git operations — wrapped
in a native window that runs the whole stack **headless and 100% locally**. No
terminal, no `npm run dev`, no cloud dependency. The only outbound network call is
the update check.

- [Framework decision](#framework-decision-electron)
- [How it works](#how-it-works)
- [Run & build locally](#run--build-locally)
- [Release process](#release-process)
- [Auto-update flow](#auto-update-flow)
- [CI secrets & signing](#ci-secrets--signing)

---

## Framework decision: Electron

**We use Electron + electron-builder + electron-updater, not Tauri.**

Tauri was the default choice (smaller binaries, built-in updater), but it requires
the Node backend to be packaged as a single self-contained **sidecar binary**
(via `pkg`/Node SEA). The GitManager engine depends on two **native node-gyp
modules** that resist that bundling:

- **`better-sqlite3`** — the local database (`~/.gitmanager/gitmanager.db`).
- **`node-pty`** — the integrated terminal.

This is exactly the documented fallback condition. Electron solves it cleanly: the
engine runs on **Electron's own bundled Node runtime** (`ELECTRON_RUN_AS_NODE`),
and electron-builder rebuilds the native modules against the Electron ABI at
package time. The existing server and UI run **unchanged** — the desktop layer is
only a shell + lifecycle manager + updater, so feature parity is automatic.

The packages:

| Package | Role |
| --- | --- |
| `packages/engine` | Existing Fastify server + CLI (unchanged behaviour). |
| `packages/ui` | Existing React/Vite SPA (unchanged behaviour). |
| `packages/desktop` | **New** Electron shell — spawns the engine, owns the window, runs the updater. |

## How it works

On launch, the Electron main process (`packages/desktop/src/main.ts`):

1. **Single-instance lock** — a second launch focuses the existing window instead
   of spawning a second engine.
2. **Picks a free loopback port** dynamically (binds `127.0.0.1:0`, reads it back) —
   never hardcoded, so it never collides with a dev server (`:4317`) or a second app.
3. **Spawns the engine** as a child process on Electron's Node runtime, bound to
   `127.0.0.1` only, with `GITMANAGER_VERSION` (from the app manifest) and the build
   SHA injected.
4. **Waits for readiness** by polling the engine's unauthenticated `/healthz`
   endpoint, showing a splash window until it's up (and a visible error if it isn't).
5. **Loads the webview** at `http://127.0.0.1:<port>/`. The engine injects the
   loopback auth token into the served HTML, so the renderer authenticates exactly
   as it does in the browser. The webview is hardened: context isolation on, no Node
   integration, navigation locked to the loopback origin, external links open in the
   system browser. The engine still enforces its strict CSP, Host-pinning, and
   token/Origin checks.
6. **Cleans up** the engine process on window close, quit, crash, and OS signals
   (`SIGTERM` then `SIGKILL` fallback) — no orphan processes, no leaked ports.

**Logs** (engine stdout/stderr + shell) go to the per-OS app-data logs directory
via `electron-log`:

- Windows: `%APPDATA%\GitManager\logs`
- macOS: `~/Library/Logs/GitManager`
- Linux: `~/.config/GitManager/logs`

Use **Help → Open logs folder** (the `openLogsFolder` bridge call) to reveal them.

**Version display** — the sidebar footer shows `v{semver}`, with
`vX.Y.Z (build {short-sha})` on hover. It is sourced from a single place: the app
manifest version, surfaced to the renderer through the desktop bridge
(`window.__GM_DESKTOP__.version`). In pure web mode the same component falls back to
the engine's `/api/ping` (or a build-time constant). There is no second hardcoded
version string — see `packages/engine/src/version.ts`.

## Run & build locally

From the repo root:

```bash
npm install

# Run the desktop app (builds engine + UI, then launches Electron):
npm run desktop

# Build unpacked / installers locally (no publish):
npm run desktop:dist        # -> packages/desktop/release/
```

`desktop:dist` (and `desktop:pack` for an unpacked `--dir` build) mirror the CI
packaging steps: they stage a self-contained copy of the production deps under
`packages/desktop` (so electron-builder's asar packer doesn't choke on the
workspace symlink to `@git-manager/engine`), rebuild better-sqlite3 for Electron,
then restore the normal workspace afterward — see `packages/desktop/scripts/dist.mjs`.

Notes:

- The first `npm install` (with scripts enabled) downloads the Electron binary.
  Behind a restrictive network policy this download may be blocked.
- `npm run desktop` rebuilds **better-sqlite3** for the Electron ABI before
  launching (the engine, spawned on Electron's Node, can't load a system-Node
  build — `NODE_MODULE_VERSION` mismatch). node-pty is N-API and ABI-stable, so it
  isn't rebuilt. When the app exits, the `postdesktop` hook runs `npm rebuild
  better-sqlite3` to restore the system-Node binary so the CLI/web engine
  (`npm start`, `npm test`) keeps working. If you interrupt the app with Ctrl-C,
  run `npm rebuild better-sqlite3` once to restore it.
- Local installers are **unsigned** unless you provide the signing secrets below.

### App icon / logo

The icon and logo are generated procedurally (no design tooling required) by
`packages/desktop/scripts/make-icon.mjs` — a git branch-and-merge graph in the
GitManager palette. Regenerate with `npm run icon --workspace packages/desktop`,
which writes `build/icon.ico` (Windows — the MSI target requires it), `build/icon.png`
(Linux), and `build/logo.png` (branding). To use your own artwork instead, drop a
≥256px `icon.ico`, a 512px `icon.png`, and (for macOS) an `icon.icns` into
`packages/desktop/build/`.
- The desktop app shares state with the CLI/web app (`~/.gitmanager`), so your
  repos and settings carry over.

## Release process

Releases are **automated with [semantic-release](https://semantic-release.gitbook.io/)**
on every push to `main`, driven by [Conventional Commits](https://www.conventionalcommits.org/):

- `fix: …` → patch (`1.2.0 → 1.2.1`)
- `feat: …` → minor (`1.2.0 → 1.3.0`)
- `feat!: …` or a `BREAKING CHANGE:` footer → major (`1.2.0 → 2.0.0`)
- `chore:` / `docs:` / `ci:` / `refactor:` … → no release

So you don't tag by hand — just merge Conventional-Commit PRs into `main`. The flow:

1. **`.github/workflows/release.yml`** runs semantic-release: it computes the next
   version from the commits, updates `CHANGELOG.md`, creates the **`v<version>` git
   tag**, publishes a **GitHub Release** with generated notes, and **publishes the CLI
   (`@git-manager/engine`) to npm** (gated on the `NPM_TOKEN` secret). (No releasable
   commits → it does nothing.)
2. The new `v*` tag triggers **`.github/workflows/desktop-release.yml`**, which:
   1. Writes the tag version into every `package.json` (the single source of truth
      for the installer + sidebar version + update comparison).
   2. Builds the engine + UI + desktop shell.
   3. Runs `electron-builder` per-OS: `windows-latest` → `.msi` + `.exe` (NSIS);
      `macos-14` (arm64) → `.dmg` + `.zip`; `ubuntu-22.04` → `.AppImage` + `.deb`.
   4. Signs/notarizes when the secrets are present (otherwise **unsigned** installers
      with a warning — never a hard failure).
   5. Publishes the installers **and** the auto-update manifests to the release.

> **Required secret for the hand-off:** GitHub does **not** trigger one workflow
> from a tag pushed by another workflow's default `GITHUB_TOKEN`. So semantic-release
> must push the tag with a **Personal Access Token** — add a repo-scoped PAT as the
> `RELEASE_TOKEN` secret. Without it the release + tag are still created, but you must
> trigger the installer build manually (re-push the tag, or run the workflow). The
> branch must also allow semantic-release to push the `CHANGELOG.md` commit (or drop
> the `@semantic-release/git` plugin from `.releaserc.json`).

You can still cut a release by hand if needed — `git tag v1.2.0 && git push origin
v1.2.0` triggers the installer build directly.

`pull_request` runs the **validation build only**: compile + package on each OS, no
signing, no publish — so packaging breakage is caught in PRs. Artifacts are uploaded
for inspection (7-day retention).

> **macOS arch note:** the matrix builds **Apple Silicon (arm64)** only. To also
> ship Intel, add a `macos-13` matrix entry (`arch: x64`, `ebflags: --x64`) and an
> `x64` macOS target in `electron-builder.yml`; note that two mac runners both
> publishing `latest-mac.yml` need care (or build a **universal** binary on one
> `macos-14` runner instead).

## Auto-update flow

electron-builder emits the electron-updater manifests next to the installers and
attaches them to the GitHub Release:

- `latest.yml` (Windows)
- `latest-mac.yml` (macOS)
- `latest-linux.yml` (Linux)

These are the electron-updater equivalent of Tauri's `latest.json`.

On startup (and every 6 hours), the shell asks `autoUpdater` to check the Releases
feed. When a newer version exists, the main process emits `update-available` to the
renderer, and the **in-app upgrade prompt** (`packages/ui/src/components/UpdateBanner.tsx`)
shows a non-blocking banner near the sidebar with the new version, a release-notes
link, **Update now**, and **Later**:

- **Update now** → downloads the signed update (progress shown in the banner), then
  prompts to **Relaunch** to install into the new version.
- **Later** → dismissed for that version (stored in `localStorage`), so it doesn't
  nag on every focus.
- Failures surface inline with a **Retry**.

Downloads are verified by electron-updater against the publisher (and, on macOS, the
code signature) before install.

## CI secrets & signing

All signing is **optional-by-secret**: if a secret is unset, the workflow still
produces unsigned installers and logs a clear warning. Configure these as repository
secrets to enable signing.

> **Generating the certificates & credentials** — step-by-step instructions for
> creating the Apple Developer ID cert, the notarization app-specific password, the
> Windows Authenticode `.pfx` / Azure Trusted Signing setup, and adding each as a
> GitHub secret live in **[`docs/desktop-credentials.md`](desktop-credentials.md)**.

### macOS — Developer ID signing + notarization + stapling

| Secret | Purpose |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 `.p12` Developer ID Application cert (→ `CSC_LINK`). |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` (→ `CSC_KEY_PASSWORD`). |
| `APPLE_ID` | Apple ID for notarization. |
| `APPLE_PASSWORD` | App-specific password (→ `APPLE_APP_SPECIFIC_PASSWORD`). |
| `APPLE_TEAM_ID` | Apple Developer Team ID. |

Hardened runtime + entitlements are set in `packages/desktop/build/entitlements.mac.plist`
(JIT / unsigned-memory allowances are required because the engine runs as a child
Node process loading native modules). Notarization + stapling run automatically when
the Apple secrets are present.

### Windows — Authenticode

| Secret | Purpose |
| --- | --- |
| `WINDOWS_CERTIFICATE` | Base64 code-signing cert (→ `WIN_CSC_LINK`). |
| `WINDOWS_CERTIFICATE_PASSWORD` | Cert password (→ `WIN_CSC_KEY_PASSWORD`). |

> **Azure Trusted Signing** (preferred for the Azure stack): wire an `afterSign`
> hook that calls the Azure Trusted Signing / Key Vault client with `AZURE_*`
> service-principal secrets, and drop the cert-in-secret. The workflow falls back to
> the standard Authenticode cert when Azure infra isn't configured.

### Linux

Linux builds (`.AppImage` + `.deb`) are unsigned by default. Optionally GPG-sign the
`.deb` by providing a key (not wired by default).

### Updater signing

electron-updater verifies updates against the GitHub Releases publisher and the OS
code signature; there is no separate updater key to manage as there is with Tauri.
(If you switch to a generic/self-hosted update server, add publisher verification
accordingly.)
