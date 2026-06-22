# Changelog

All notable changes to GitManager are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The in-app desktop upgrade prompt links to the release for the version it offers
(`https://github.com/grabskimm/git-manager/releases/tag/v{version}`), so keep each
release's notes in its GitHub Release (mirrored from the matching section below).

## [Unreleased]

### Added

- **Desktop app (Windows, macOS, Linux).** GitManager now ships as a standalone
  native app that runs the existing engine + UI headlessly and 100% locally — no
  terminal, no manual server start. Built with Electron (see
  [`docs/desktop.md`](docs/desktop.md) for the framework rationale).
- **Sidebar version display.** The sidebar footer shows `v{semver}`
  (with `vX.Y.Z (build {short-sha})` on hover), sourced from a single source of
  truth — the app manifest, surfaced via `version.ts` / `/api/ping` / the desktop
  bridge.
- **In-app update prompt.** The desktop app checks for new releases on startup and
  every 6 hours and shows a non-blocking upgrade banner near the sidebar with
  **Update now** / **Later** and download progress.
- **Cross-platform release CI** (`.github/workflows/desktop-release.yml`): a matrix
  build that produces signed (or clearly unsigned) `.msi`/`.exe`, `.dmg`/`.zip`, and
  `.AppImage`/`.deb` installers plus the electron-updater manifests, attached to a
  GitHub Release on every `v*` tag.
- Unauthenticated `/healthz` readiness endpoint on the engine (used by the desktop
  shell to wait for the server before showing the window).

## [1.0.0]

- Initial GitManager: local-first, GitHub-like UI over multiple local git
  repositories with local PRs and automatic AI review.
